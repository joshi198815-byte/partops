import { z } from 'zod';
import { PAYMENT_METHOD_LABEL } from './orders.js';

/**
 * Finanzas: ventas, costo de lo vendido, gastos y utilidad.
 *
 * Tres decisiones que cambian los números y por eso están escritas aquí, no en un comentario
 * perdido del servicio:
 *
 *  1. **La venta se reconoce cuando la pieza sale** (`deliveredAt` de la línea), no cuando se
 *     captura el pedido. Un pedido abierto que nadie despachó no es ingreso: si se contara al
 *     crearlo, el dueño vería utilidad de algo que quizá nunca se cobre.
 *  2. **El costo es el congelado en la línea** (`unitCostCents`). Si el proveedor sube el costo en
 *     marzo, la utilidad de enero no se mueve. Recalcular con el costo de hoy es la forma más común
 *     de que un reporte histórico deje de cuadrar consigo mismo.
 *  3. **Ventas incluyen IVA; la utilidad no lo descuenta.** Es el número que el dueño usa para
 *     pagar planilla y fletes. El IVA se muestra aparte para que nadie lo confunda con ganancia.
 */

/** Tope de rango: un año largo. Más que eso se pide por meses, no de un jalón. */
export const FINANCE_MAX_RANGE_DAYS = 400;

/** Días que recalcula el agregado diario en una corrida (hoy, ayer y el margen de una caída). */
export const FINANCE_ROLLUP_DAYS = 3;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const financePeriodSchema = z
  .object({
    from: z.string().refine(isDay, 'Fecha inicial inválida'),
    to: z.string().refine(isDay, 'Fecha final inválida'),
  })
  .refine((v) => v.from <= v.to, { message: 'La fecha inicial va antes de la final', path: ['from'] })
  .refine(
    (v) =>
      (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000 <
      FINANCE_MAX_RANGE_DAYS,
    { message: `El rango no puede pasar de ${FINANCE_MAX_RANGE_DAYS} días`, path: ['to'] },
  );

export type FinancePeriodInput = z.output<typeof financePeriodSchema>;

export interface FinancePeriod {
  /** `YYYY-MM-DD` en la zona del negocio, inclusive. */
  from: string;
  to: string;
}

/**
 * Costo y utilidad son `null` cuando la persona no tiene `finance.cost.view`.
 *
 * No se devuelve cero: un cero es un dato —"vendí y no gané nada"— y aquí sería una mentira. La
 * pantalla pinta una raya y dice qué permiso falta; el vendedor ve ventas, que es lo que necesita
 * para cobrar, y no el margen del negocio.
 */
export interface FinanceTotals {
  salesCents: number;
  /** IVA contenido en `salesCents`. Informativo: no se resta de la utilidad. */
  taxCents: number;
  cogsCents: number | null;
  grossProfitCents: number | null;
  expensesCents: number;
  netProfitCents: number | null;
  /** Utilidad bruta sobre ventas, en puntos base. Puede ser negativa. */
  grossMarginBps: number | null;
  ordersCount: number;
  itemsCount: number;
  /** Ventas promedio por pedido entregado. Cero si no hubo pedidos. */
  ticketAvgCents: number;
}

export interface FinanceDayRow {
  day: string;
  salesCents: number;
  cogsCents: number | null;
  expensesCents: number;
  netProfitCents: number | null;
  ordersCount: number;
  itemsCount: number;
}

/**
 * Fila de desglose.
 *
 * `key` es el identificador estable (vendedor, bodega, categoría) y `label` lo que se pinta. Un
 * vendedor dado de baja conserva su historial: se muestra "Vendedor eliminado" y no se pierde la
 * venta de la suma.
 */
export interface FinanceBreakdownRow {
  key: string;
  label: string;
  salesCents: number;
  cogsCents: number | null;
  profitCents: number | null;
  ordersCount: number;
  itemsCount: number;
}

/** Cobrado por forma de pago. No es lo mismo que vendido: una venta al crédito no entra aquí. */
export interface FinancePaymentRow {
  method: string;
  label: string;
  amountCents: number;
  count: number;
}

/** Nombre legible de una forma de pago. La base devuelve `text`, no el enum de TypeScript. */
export function paymentMethodLabel(method: string): string {
  return (PAYMENT_METHOD_LABEL as Record<string, string>)[method] ?? method;
}

export interface FinanceExpenseRow {
  id: string;
  title: string;
  amountCents: number;
  /** `YYYY-MM-DD` local. */
  paidAt: string;
  categoryId: string | null;
  categoryName: string | null;
  notes: string | null;
  createdByName: string | null;
}

export interface FinanceExpenseCategoryRow {
  id: string;
  name: string;
  isSystem: boolean;
  expensesCents: number;
}

export interface FinanceRecurringRow {
  id: string;
  title: string;
  amountCents: number;
  categoryId: string | null;
  categoryName: string | null;
  dayOfMonth: number;
  active: boolean;
  /** `YYYY-MM` del último mes en que se generó el gasto. */
  lastRunMonth: string | null;
}

export interface FinanceOverview {
  period: FinancePeriod;
  currency: string;
  /** Si es `false`, costos y utilidad llegan en `null` y la pantalla lo dice. */
  costsVisible: boolean;
  totals: FinanceTotals;
  days: FinanceDayRow[];
  bySeller: FinanceBreakdownRow[];
  byWarehouse: FinanceBreakdownRow[];
  byPaymentMethod: FinancePaymentRow[];
  expenses: FinanceExpenseRow[];
  expensesByCategory: FinanceExpenseCategoryRow[];
  categories: FinanceExpenseCategoryRow[];
  recurring: FinanceRecurringRow[];
}

// ───────────────────────────── Gastos ─────────────────────────────

/** Centavos enteros y positivos. Un gasto de cero no es un gasto y uno negativo es un ingreso. */
const amountCents = z
  .number()
  .int('El monto va en centavos enteros')
  .positive('El monto tiene que ser mayor que cero')
  .max(2_000_000_000, 'Ese monto no cabe en un gasto');

export const expenseInputSchema = z.object({
  title: z.string().trim().min(2, 'Escribe de qué fue el gasto').max(120, 'Título demasiado largo'),
  amountCents,
  categoryId: z.string().uuid('Categoría inválida').optional(),
  /** Fecha de pago en la zona del negocio. Si no viene, es hoy. */
  paidAt: z.string().refine(isDay, 'Fecha inválida').optional(),
  notes: z.string().trim().max(500, 'La nota es demasiado larga').optional(),
});

export type ExpenseInput = z.output<typeof expenseInputSchema>;

export const expenseUpdateSchema = expenseInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que cambiar' });

export type ExpenseUpdate = z.output<typeof expenseUpdateSchema>;

export const expenseCategorySchema = z.object({
  name: z.string().trim().min(2, 'Escribe el nombre').max(60, 'Nombre demasiado largo'),
});

export type ExpenseCategoryInput = z.output<typeof expenseCategorySchema>;

/**
 * Gasto fijo mensual (alquiler, planilla, internet).
 *
 * Se guarda como plantilla y el mantenimiento crea el gasto del mes una sola vez. Capturarlo a
 * mano cada mes es justo lo que se olvida, y un reporte con el alquiler de tres meses de cinco
 * es peor que no tener reporte.
 */
export const recurringExpenseSchema = z.object({
  title: z.string().trim().min(2, 'Escribe de qué es el gasto fijo').max(120, 'Título demasiado largo'),
  amountCents,
  categoryId: z.string().uuid('Categoría inválida').optional(),
  /** Día del mes en que se paga. Se limita a 28: el 31 no existe en febrero. */
  dayOfMonth: z.number().int().min(1).max(28).default(1),
  active: z.boolean().default(true),
});

export type RecurringExpenseInput = z.output<typeof recurringExpenseSchema>;

export const recurringExpenseUpdateSchema = recurringExpenseSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que cambiar' });

/** Categorías que se crean solas la primera vez que se abre Finanzas. */
export const EXPENSE_PRESETS = [
  'Alquiler',
  'Planilla',
  'Fletes',
  'Servicios',
  'Importaciones',
  'Impuestos',
  'Otros',
] as const;

/**
 * Utilidad neta, en un solo lugar.
 *
 * La pantalla, el agregado diario y la exportación llaman a esto mismo. Si cada uno restara por su
 * cuenta, el día que alguien cambie el orden (o olvide los gastos) el reporte y el archivo dirían
 * cosas distintas sobre el mismo mes y no habría forma de saber cuál creer.
 */
export function financeProfit(salesCents: number, cogsCents: number, expensesCents: number) {
  const grossProfitCents = salesCents - cogsCents;
  return {
    grossProfitCents,
    netProfitCents: grossProfitCents - expensesCents,
    grossMarginBps: salesCents > 0 ? Math.round((grossProfitCents * 10_000) / salesCents) : 0,
  };
}
