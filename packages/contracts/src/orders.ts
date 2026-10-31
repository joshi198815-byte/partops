import { z } from 'zod';
import { allocateProportionally, splitTaxIncluded } from './money.js';

/**
 * Estado de pedido por LÍNEA, no por cabecera.
 *
 * Una venta de 5 piezas puede salir de dos bodegas: 3 se despachan hoy y 2 esperan traslado desde
 * la central. Con un solo estado en la cabecera, el bodeguero no puede cerrar su parte y el pedido
 * queda "en preparación" para siempre. Por eso el estado vive en la línea y la cabecera se DERIVA.
 */

export const LINE_STATUSES = [
  'PENDIENTE',
  'EN_PREPARACION',
  'LISTO',
  'ENTREGADO',
  'SIN_STOCK',
  'CANCELADO',
] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const ORDER_STATUSES = [
  'ABIERTO',
  'EN_PREPARACION',
  'LISTO',
  'ENTREGADO',
  'PARCIAL',
  'CANCELADO',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_CHANNELS = ['MOSTRADOR', 'TELEFONO', 'WHATSAPP', 'CATALOGO', 'MOVIL'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const PAYMENT_METHODS = ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'CREDITO', 'MIXTO'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Transiciones legales por línea. Cualquier otra combinación es un error del cliente o un
 * intento de saltarse el flujo (entregar sin preparar, cancelar lo ya entregado).
 */
const LINE_TRANSITIONS: Record<LineStatus, readonly LineStatus[]> = {
  PENDIENTE: ['EN_PREPARACION', 'SIN_STOCK', 'CANCELADO'],
  EN_PREPARACION: ['LISTO', 'SIN_STOCK', 'CANCELADO'],
  LISTO: ['ENTREGADO', 'CANCELADO'],
  ENTREGADO: [],
  SIN_STOCK: ['PENDIENTE', 'CANCELADO'],
  CANCELADO: [],
};

export function canTransitionLine(from: LineStatus, to: LineStatus): boolean {
  return LINE_TRANSITIONS[from].includes(to);
}

export interface LineLike {
  status: LineStatus;
  quantity: number;
}

/**
 * Estado de la cabecera derivado de sus líneas.
 *
 * Reglas, en orden:
 *  - todas canceladas → CANCELADO
 *  - alguna pendiente/en preparación → EN_PREPARACION (hay trabajo en bodega)
 *  - hay entregadas y hay canceladas/sin stock → PARCIAL
 *  - todas entregadas → ENTREGADO
 *  - todas listas (o listas + canceladas) → LISTO
 *  - todo sin stock → ABIERTO (falta comprar, nadie lo está preparando)
 */
export function deriveOrderStatus(lines: LineLike[]): OrderStatus {
  if (!lines.length) return 'ABIERTO';
  const alive = lines.filter((l) => l.status !== 'CANCELADO');
  if (!alive.length) return 'CANCELADO';

  const has = (s: LineStatus) => alive.some((l) => l.status === s);
  if (has('PENDIENTE') || has('EN_PREPARACION')) return 'EN_PREPARACION';
  if (has('SIN_STOCK')) return alive.some((l) => l.status === 'ENTREGADO') ? 'PARCIAL' : 'ABIERTO';
  if (alive.every((l) => l.status === 'ENTREGADO')) {
    return lines.length !== alive.length ? 'PARCIAL' : 'ENTREGADO';
  }
  if (alive.some((l) => l.status === 'ENTREGADO')) return 'PARCIAL';
  return 'LISTO';
}

/** Un pedido cerrado no admite más cambios: ni líneas, ni pagos, ni despacho. */
export function isOrderClosed(status: OrderStatus): boolean {
  return status === 'ENTREGADO' || status === 'CANCELADO';
}

/**
 * Una línea con reserva viva es exactamente la que hay que liberar al cancelar.
 *
 * Se deriva del estado y no se guarda aparte: un campo `reserved: boolean` puede quedar en `true`
 * después de un despacho fallido y bloquear el stock de una pieza que ya salió. El estado de la
 * línea es el único que no se puede desincronizar, porque cambia en la misma transacción que el
 * movimiento del ledger.
 */
export function lineHoldsReservation(status: LineStatus): boolean {
  return status === 'PENDIENTE' || status === 'EN_PREPARACION' || status === 'LISTO';
}

/**
 * Siguiente acción que el sistema debe sugerir, en español y accionable.
 * La UI no decide el flujo: lo lee de aquí, así la app móvil y la web dicen lo mismo.
 */
export function nextAction(status: OrderStatus): { label: string; permission: string } | null {
  switch (status) {
    case 'ABIERTO':
      return { label: 'Buscar existencia en otra bodega', permission: 'inventory.transfer' };
    case 'EN_PREPARACION':
      return { label: 'Preparar en bodega', permission: 'orders.dispatch' };
    case 'LISTO':
      return { label: 'Marcar entregado', permission: 'orders.dispatch' };
    case 'PARCIAL':
      return { label: 'Completar lo pendiente', permission: 'orders.dispatch' };
    default:
      return null;
  }
}

// ───────────────────── Contrato de pedidos (API ↔ web) ─────────────────────

const MONEY_MAX = 100_000_000;
const QUANTITY_MAX = 10_000;

export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  PENDIENTE: 'Pendiente',
  EN_PREPARACION: 'En preparación',
  LISTO: 'Listo',
  ENTREGADO: 'Entregado',
  SIN_STOCK: 'Sin stock',
  CANCELADO: 'Cancelado',
};

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  ABIERTO: 'Abierto',
  EN_PREPARACION: 'En preparación',
  LISTO: 'Listo',
  ENTREGADO: 'Entregado',
  PARCIAL: 'Parcial',
  CANCELADO: 'Cancelado',
};

export const ORDER_CHANNEL_LABEL: Record<OrderChannel, string> = {
  MOSTRADOR: 'Mostrador',
  TELEFONO: 'Teléfono',
  WHATSAPP: 'WhatsApp',
  CATALOGO: 'Catálogo',
  MOVIL: 'Móvil',
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  EFECTIVO: 'Efectivo',
  TARJETA: 'Tarjeta',
  TRANSFERENCIA: 'Transferencia',
  CREDITO: 'Crédito',
  MIXTO: 'Mixto',
};

/**
 * Folio legible: `PD-0001`.
 *
 * El número es la secuencia interna y nunca se reutiliza; el prefijo lo configura el negocio para
 * que el folio diga algo en la calle ("PD" de Partes y Despacho, "FV" de factura de venta).
 */
export function orderCode(prefix: string, number: number): string {
  return `${prefix}-${String(number).padStart(4, '0')}`;
}

export const orderItemSchema = z.object({
  variantId: z.string().uuid('Elige una pieza'),
  quantity: z
    .number()
    .int()
    .min(1, 'La cantidad tiene que ser al menos 1')
    .max(QUANTITY_MAX, 'Demasiadas unidades en una línea'),
  /** Bodega de la que sale. Si falta, el servidor elige la que tenga existencia. */
  warehouseId: z.string().uuid().optional(),
  /** Solo con `orders.price.override`; el servidor vuelve a comprobarlo. */
  unitPriceCents: z.number().int().min(0).max(MONEY_MAX).optional(),
  discountCents: z.number().int().min(0).max(MONEY_MAX).optional(),
});

export const orderCreateSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    customerName: z.string().trim().max(160).optional(),
    customerPhone: z.string().trim().max(40).optional(),
    customerTaxId: z.string().trim().max(40).optional(),
    channel: z.enum(ORDER_CHANNELS).default('MOSTRADOR'),
    warehouseId: z.string().uuid().optional(),
    notes: z.string().trim().max(600).optional(),
    /** Clave del cliente: un reintento por mala señal devuelve el mismo pedido, no dos. */
    idempotencyKey: z.string().trim().min(8).max(120).optional(),
    items: z.array(orderItemSchema).min(1, 'Agrega al menos una pieza').max(80),
  })
  .refine((v) => Boolean(v.customerName?.trim() || v.customerId), {
    message: 'Escribe el nombre del cliente o elige uno',
    path: ['customerName'],
  })
  .refine((v) => new Set(v.items.map((i) => i.variantId)).size === v.items.length, {
    message: 'Hay una pieza repetida: junta las cantidades en una sola línea',
    path: ['items'],
  });
export type OrderCreateData = z.output<typeof orderCreateSchema>;

export const orderListQuerySchema = z.object({
  q: z.string().trim().max(160).default(''),
  status: z.enum(ORDER_STATUSES).optional(),
  channel: z.enum(ORDER_CHANNELS).optional(),
  warehouseId: z.string().uuid().optional(),
  /** `true` deja solo lo que todavía tiene trabajo en bodega. */
  open: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});
export type OrderListQuery = z.output<typeof orderListQuerySchema>;

export const orderCancelSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

/**
 * Cambio de estado de una línea.
 *
 * La cantidad no viaja: una línea se entrega completa o no se entrega. Permitir entregar 2 de 3
 * obliga a partir la línea en dos, y ahí el total del pedido deja de cuadrar con lo cobrado.
 */
export const orderLineStatusSchema = z.object({
  status: z.enum(LINE_STATUSES),
});

export const paymentCreateSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountCents: z.number().int().min(1, 'El pago tiene que ser mayor que cero').max(MONEY_MAX),
  /** Efectivo recibido: sirve para calcular el cambio sin que el cajero haga la resta. */
  receivedCents: z.number().int().min(0).max(MONEY_MAX).optional(),
  reference: z.string().trim().max(80).optional(),
});
export type PaymentCreateData = z.output<typeof paymentCreateSchema>;

export interface OrderCustomerRef {
  id: string;
  name: string;
  phone: string | null;
}

export interface OrderLineRow {
  id: string;
  variantId: string;
  sku: string;
  name: string;
  variantTitle: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number | null;
  discountCents: number;
  totalCents: number;
  status: LineStatus;
  warehouseId: string;
  warehouseCode: string;
  binLocation: string | null;
  reservedUntil: string | null;
  preparedAt: string | null;
  deliveredAt: string | null;
}

export interface OrderSummary {
  id: string;
  number: number;
  code: string;
  status: OrderStatus;
  channel: OrderChannel;
  customerName: string;
  customerPhone: string | null;
  customer: OrderCustomerRef | null;
  warehouseId: string;
  warehouseCode: string;
  totalCents: number;
  paidCents: number;
  lineCount: number;
  units: number;
  /** Líneas que todavía esperan algo: es el número que mira el bodeguero. */
  pendingUnits: number;
  createdAt: string;
  closedAt: string | null;
  sellerName: string;
  /** Lo que falta cobrar. Negativo = cambio pendiente de entregar. */
  balanceCents: number;
}

export interface OrderPaymentRow {
  id: string;
  method: PaymentMethod;
  amountCents: number;
  receivedCents: number | null;
  changeCents: number | null;
  reference: string | null;
  createdAt: string;
}

export interface OrderEventRow {
  id: string;
  type: string;
  detail: Record<string, unknown> | null;
  actorName: string | null;
  createdAt: string;
}

export interface OrderDetail extends OrderSummary {
  customerTaxId: string | null;
  notes: string | null;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  lines: OrderLineRow[];
  payments: OrderPaymentRow[];
  events: OrderEventRow[];
  /** Siguiente paso sugerido; `null` cuando ya no hay nada que hacer. */
  next: { label: string; permission: string } | null;
}

export interface OrderListResponse {
  items: OrderSummary[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Totales del pedido a partir de sus líneas.
 *
 * El descuento de cabecera se reparte con `allocateProportionally` para que la suma de líneas dé
 * exactamente el total: si se calculara línea por línea con `total * 0.12`, tres líneas de 3.33
 * sumarían 9.99 y el recibo no cerraría contra el pago.
 */
export function orderTotals(
  lines: Array<{ quantity: number; unitPriceCents: number; discountCents: number }>,
  taxRateBps: number,
) {
  const lineTotals = lines.map((l) => l.quantity * l.unitPriceCents - l.discountCents);
  const total = lineTotals.reduce((a, b) => a + b, 0);
  const { subtotal, tax } = splitTaxIncluded(total, taxRateBps);
  const discounts = lines.reduce((a, l) => a + l.discountCents, 0);
  return { totalCents: total, subtotalCents: subtotal, taxCents: tax, discountCents: discounts };
}

/** Reparte un descuento de cabecera entre las líneas sin perder centavos. */
export function spreadDiscount(lines: number[], discountCents: number): number[] {
  return allocateProportionally(discountCents, lines);
}
