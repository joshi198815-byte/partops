import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EXPENSE_PRESETS,
  type ExpenseInput,
  type ExpenseUpdate,
  FINANCE_ROLLUP_DAYS,
  type FinanceBreakdownRow,
  type FinanceDayRow,
  type FinanceExpenseCategoryRow,
  type FinanceExpenseRow,
  type FinanceOverview,
  type FinancePaymentRow,
  type FinancePeriod,
  type FinanceRecurringRow,
  type FinanceTotals,
  financeProfit,
  paymentMethodLabel,
  type RecurringExpenseInput,
} from '@partops/contracts';
import { Prisma, type TxClient } from '@partops/db';
import { audit, diff } from '../../common/audit.js';
import type { Ctx } from '../../common/context.js';
import {
  daysBetween,
  daysInRange,
  localBoundary,
  localDay,
  monthOf,
  nextDay,
  shiftDay,
  todayIn,
} from '../../common/time.js';
import { DatabaseService } from '../../infra/database.module.js';

/**
 * Finanzas.
 *
 * Dos ideas sostienen el módulo y conviene tenerlas a la vista antes de leer las consultas:
 *
 *  1. **Se reconoce la venta cuando la pieza sale.** El ingreso sale de `sales_order_item` con
 *     `deliveredAt` dentro del periodo, no de la cabecera con `createdAt`. Un pedido capturado y
 *     nunca despachado es una promesa, y contar promesas como ingreso es cómo una bodega descubre
 *     en diciembre que ganó menos de lo que su tablero decía en julio.
 *  2. **El costo es el de la línea.** `unitCostCents` se congeló al vender. Recalcular el histórico
 *     con el costo de hoy haría que la utilidad de marzo cambiara cada vez que el proveedor sube el
 *     precio, y entonces el reporte deja de servir para comparar meses.
 *
 * El IVA se muestra aparte y no se resta de la utilidad: es dinero que se cobra para el Estado, no
 * ganancia, pero tampoco es un gasto del negocio. Restarlo (o no mostrarlo) hace que el dueño
 * confunda facturación con utilidad, que es el error más caro del oficio.
 */

interface RawDayRow {
  day: string;
  sales: string | null;
  cogs: string | null;
  orders: bigint;
  items: bigint;
  tax: string | null;
}

interface RawGroupRow {
  key: string | null;
  label: string | null;
  sales: string | null;
  cogs: string | null;
  orders: bigint;
  items: bigint;
}

interface RawExpenseRow {
  id: string;
  title: string;
  amountCents: number;
  paidAt: string;
  categoryId: string | null;
  categoryName: string | null;
  notes: string | null;
  createdByName: string | null;
}

interface RawPaymentRow {
  method: string;
  amount: string | null;
  count: bigint;
}

/** Fila diaria con el IVA separado: se necesita para el total y para la exportación. */
type DailyRow = FinanceDayRow & { taxCents: number };

@Injectable()
export class FinanceService {
  private readonly log = new Logger(FinanceService.name);

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  // ───────────────────────────── Panel ─────────────────────────────

  /**
   * Todo el reporte en una llamada.
   *
   * Son seis consultas cortas en paralelo y no una con seis `UNION`: cada una se lee sola y el
   * planificador las reparte en conexiones distintas del pool. El panel se abre decenas de veces al
   * día; ahorrar dos milisegundos no paga perder la posibilidad de explicar de dónde sale un número.
   */
  async overview(ctx: Ctx, period: FinancePeriod): Promise<FinanceOverview> {
    const tenantId = ctx.tenant.tenantId;
    const costsVisible = ctx.tenant.permissions.has('finance.cost.view');
    const [
      tenant,
      days,
      bySeller,
      byWarehouse,
      byPaymentMethod,
      expenseRows,
      expensesByCategory,
      categories,
      recurring,
    ] = await Promise.all([
      this.db.tx(tenantId, (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { currency: true, timezone: true },
        }),
      ),
      this.daily(ctx, period),
      this.breakdown(ctx, period, 'seller'),
      this.breakdown(ctx, period, 'warehouse'),
      this.payments(ctx, period),
      this.expenseRows(ctx, period),
      this.expensesByCategory(ctx, period),
      this.categories(ctx),
      this.recurringRows(ctx),
    ]);

    // Los gastos pueden ser de días sin venta: la serie diaria tiene que incluirlos o la utilidad
    // del mes sumaría ventas de días con gastos y se comería el alquiler pagado un domingo.
    const expenseByDay = new Map<string, number>();
    for (const row of expenseRows) {
      expenseByDay.set(row.paidAt, (expenseByDay.get(row.paidAt) ?? 0) + row.amountCents);
    }

    const byDay = new Map(days.map((d) => [d.day, d]));
    const series: FinanceDayRow[] = daysInRange(period.from, period.to).map((day) => {
      const base = byDay.get(day);
      const expensesCents = expenseByDay.get(day) ?? 0;
      const salesCents = base?.salesCents ?? 0;
      const cogsCents = base?.cogsCents ?? 0;
      return {
        day,
        salesCents,
        cogsCents: costsVisible ? cogsCents : null,
        expensesCents,
        netProfitCents: costsVisible
          ? financeProfit(salesCents, cogsCents, expensesCents).netProfitCents
          : null,
        ordersCount: base?.ordersCount ?? 0,
        itemsCount: base?.itemsCount ?? 0,
      };
    });

    const totals = this.totalsOf(days, expenseRows, costsVisible);

    return {
      period,
      currency: tenant?.currency ?? 'GTQ',
      costsVisible,
      totals,
      days: series,
      bySeller,
      byWarehouse,
      byPaymentMethod,
      expenses: expenseRows,
      expensesByCategory,
      categories,
      recurring: recurring.map((r) => ({ ...r, lastRunMonth: r.lastRunMonth ?? null })),
    };
  }

  /**
   * Suma del periodo.
   *
   * Se hace sobre la serie diaria ya cargada (no con otra consulta `SUM`) para que el total sea
   * exactamente la suma de las filas que la persona ve y puede verificar a mano. Una consulta
   * aparte cuadraría casi siempre, y "casi siempre" en dinero no sirve.
   */
  private totalsOf(days: DailyRow[], expenses: FinanceExpenseRow[], costsVisible: boolean): FinanceTotals {
    const salesCents = days.reduce((n, d) => n + d.salesCents, 0);
    const taxCents = days.reduce((n, d) => n + (d.taxCents ?? 0), 0);
    const cogsCents = days.reduce((n, d) => n + (d.cogsCents ?? 0), 0);
    const expensesCents = expenses.reduce((n, e) => n + e.amountCents, 0);
    const ordersCount = days.reduce((n, d) => n + d.ordersCount, 0);
    const itemsCount = days.reduce((n, d) => n + d.itemsCount, 0);
    const profit = financeProfit(salesCents, cogsCents, expensesCents);

    return {
      salesCents,
      taxCents,
      cogsCents: costsVisible ? cogsCents : null,
      grossProfitCents: costsVisible ? profit.grossProfitCents : null,
      expensesCents,
      netProfitCents: costsVisible ? profit.netProfitCents : null,
      grossMarginBps: costsVisible ? profit.grossMarginBps : null,
      ordersCount,
      itemsCount,
      ticketAvgCents: ordersCount > 0 ? Math.round(salesCents / ordersCount) : 0,
    };
  }

  /**
   * Serie diaria de ventas.
   *
   * El IVA se separa línea por línea usando la proporción del pedido (`subtotal / total`), no
   * `ventas × 12 %`: aplicado al total del periodo eso deja centavos sueltos y, peor, mezcla la
   * tasa de hoy con pedidos de cuando la tasa era otra. Por línea, `base + IVA` da exactamente el
   * total cobrado.
   */
  private async daily(ctx: Ctx, period: FinancePeriod): Promise<DailyRow[]> {
    const tenantId = ctx.tenant.tenantId;
    const timezone = await this.timezoneOf(tenantId);

    const rows = await this.db.tx(
      tenantId,
      (tx) =>
        tx.$queryRaw<RawDayRow[]>`
        SELECT
          to_char(${localDay('i."deliveredAt"', timezone)}, 'YYYY-MM-DD') AS "day",
          sum(i."totalCents")::text AS "sales",
          sum(i."unitCostCents" * i."quantity")::text AS "cogs",
          count(DISTINCT i."orderId") AS "orders",
          sum(i."quantity") AS "items",
          sum(
            i."totalCents" - round(
              i."totalCents"::numeric * o."subtotalCents"::numeric / NULLIF(o."totalCents", 0)
            )
          )::text AS "tax"
        FROM "sales_order_item" i
        JOIN "sales_order" o ON o."id" = i."orderId" AND o."tenantId" = i."tenantId"
        WHERE i."tenantId" = ${tenantId}
          AND i."deliveredAt" IS NOT NULL
          AND i."deliveredAt" >= ${localBoundary(period.from, timezone)}
          AND i."deliveredAt" <  ${localBoundary(nextDay(period.to), timezone)}
        GROUP BY 1
        ORDER BY 1`,
    );

    return rows.map((r) => ({
      day: r.day,
      salesCents: num(r.sales),
      cogsCents: num(r.cogs),
      taxCents: num(r.tax),
      expensesCents: 0,
      netProfitCents: 0,
      ordersCount: Number(r.orders ?? 0),
      itemsCount: Number(r.items ?? 0),
    }));
  }

  /** Desglose por vendedor o por bodega. Misma consulta, distinta columna: el resto es idéntico. */
  private async breakdown(
    ctx: Ctx,
    period: FinancePeriod,
    by: 'seller' | 'warehouse',
  ): Promise<FinanceBreakdownRow[]> {
    const tenantId = ctx.tenant.tenantId;
    const costsVisible = ctx.tenant.permissions.has('finance.cost.view');
    const timezone = await this.timezoneOf(tenantId);

    const key = by === 'seller' ? Prisma.sql`o."sellerId"` : Prisma.sql`o."warehouseId"`;
    const label = by === 'seller' ? Prisma.sql`u."name"` : Prisma.sql`w."name"`;

    const rows = await this.db.tx(
      tenantId,
      (tx) =>
        tx.$queryRaw<RawGroupRow[]>`
        SELECT
          ${key} AS "key",
          ${label} AS "label",
          sum(i."totalCents")::text AS "sales",
          sum(i."unitCostCents" * i."quantity")::text AS "cogs",
          count(DISTINCT i."orderId") AS "orders",
          sum(i."quantity") AS "items"
        FROM "sales_order_item" i
        JOIN "sales_order" o ON o."id" = i."orderId" AND o."tenantId" = i."tenantId"
        LEFT JOIN "user" u ON u."id" = o."sellerId"
        LEFT JOIN "warehouse" w ON w."id" = o."warehouseId"
        WHERE i."tenantId" = ${tenantId}
          AND i."deliveredAt" IS NOT NULL
          AND i."deliveredAt" >= ${localBoundary(period.from, timezone)}
          AND i."deliveredAt" <  ${localBoundary(nextDay(period.to), timezone)}
        GROUP BY 1, 2
        ORDER BY sum(i."totalCents") DESC
        LIMIT 50`,
    );

    return rows.map((r) => {
      const salesCents = num(r.sales);
      const cogsCents = num(r.cogs);
      return {
        key: r.key ?? 'sin-asignar',
        // Un vendedor dado de baja o un pedido de invitado del catálogo no tienen nombre. La venta
        // sigue contando: esconderla para que la tabla se vea pareja sería borrar ingresos reales.
        label: r.label ?? (by === 'seller' ? 'Catálogo en línea' : 'Bodega eliminada'),
        salesCents,
        cogsCents: costsVisible ? cogsCents : null,
        profitCents: costsVisible ? salesCents - cogsCents : null,
        ordersCount: Number(r.orders ?? 0),
        itemsCount: Number(r.items ?? 0),
      };
    });
  }

  /**
   * Cobros por forma de pago.
   *
   * Se mide sobre `payment` y no sobre el pedido: una venta al crédito no es efectivo, y un pedido
   * pagado en dos tandas son dos cobros en dos métodos distintos. Lo que el dueño quiere saber el
   * viernes es cuánto entró a la caja, no cuánto se facturó.
   */
  private async payments(ctx: Ctx, period: FinancePeriod): Promise<FinancePaymentRow[]> {
    const tenantId = ctx.tenant.tenantId;
    const timezone = await this.timezoneOf(tenantId);

    const rows = await this.db.tx(
      tenantId,
      (tx) =>
        tx.$queryRaw<RawPaymentRow[]>`
        SELECT p."method"::text AS "method", sum(p."amountCents")::text AS "amount", count(*) AS "count"
        FROM "payment" p
        WHERE p."tenantId" = ${tenantId}
          AND p."createdAt" >= ${localBoundary(period.from, timezone)}
          AND p."createdAt" <  ${localBoundary(nextDay(period.to), timezone)}
        GROUP BY 1
        ORDER BY sum(p."amountCents") DESC`,
    );

    return rows.map((r) => ({
      method: r.method,
      label: paymentMethodLabel(r.method),
      amountCents: num(r.amount),
      count: Number(r.count ?? 0),
    }));
  }

  private async expenseRows(ctx: Ctx, period: FinancePeriod): Promise<FinanceExpenseRow[]> {
    const tenantId = ctx.tenant.tenantId;
    const timezone = await this.timezoneOf(tenantId);

    const rows = await this.db.tx(
      tenantId,
      (tx) =>
        tx.$queryRaw<RawExpenseRow[]>`
        SELECT
          e."id", e."title", e."amountCents", e."notes",
          to_char(${localDay('e."paidAt"', timezone)}, 'YYYY-MM-DD') AS "paidAt",
          e."categoryId",
          c."name" AS "categoryName",
          u."name" AS "createdByName"
        FROM "expense" e
        LEFT JOIN "expense_category" c ON c."id" = e."categoryId"
        LEFT JOIN "user" u ON u."id" = e."createdById"
        WHERE e."tenantId" = ${tenantId}
          AND e."paidAt" >= ${localBoundary(period.from, timezone)}
          AND e."paidAt" <  ${localBoundary(nextDay(period.to), timezone)}
        ORDER BY e."paidAt" DESC, e."createdAt" DESC
        LIMIT 500`,
    );
    return rows.map((r) => ({ ...r, amountCents: Number(r.amountCents) }));
  }

  private async expensesByCategory(ctx: Ctx, period: FinancePeriod): Promise<FinanceExpenseCategoryRow[]> {
    const tenantId = ctx.tenant.tenantId;
    const timezone = await this.timezoneOf(tenantId);

    const rows = await this.db.tx(
      tenantId,
      (tx) =>
        tx.$queryRaw<{ id: string | null; name: string | null; isSystem: boolean; total: string | null }[]>`
        SELECT c."id", c."name", coalesce(c."isSystem", false) AS "isSystem", sum(e."amountCents")::text AS "total"
        FROM "expense" e
        LEFT JOIN "expense_category" c ON c."id" = e."categoryId"
        WHERE e."tenantId" = ${tenantId}
          AND e."paidAt" >= ${localBoundary(period.from, timezone)}
          AND e."paidAt" <  ${localBoundary(nextDay(period.to), timezone)}
        GROUP BY 1, 2, 3
        ORDER BY sum(e."amountCents") DESC`,
    );

    return rows.map((r) => ({
      id: r.id ?? 'sin-categoria',
      name: r.name ?? 'Sin categoría',
      isSystem: r.isSystem,
      expensesCents: num(r.total),
    }));
  }

  /** Categorías del negocio. Se crean las de fábrica aquí: una migración con trigger por alta es
   *  más frágil que un `ON CONFLICT DO NOTHING` en el momento en que de verdad se necesitan. */
  private async categories(ctx: Ctx): Promise<FinanceExpenseCategoryRow[]> {
    await this.ensurePresets(ctx.tenant.tenantId);
    const rows = await this.db.tx(ctx.tenant.tenantId, (tx) =>
      tx.expenseCategory.findMany({
        where: { tenantId: ctx.tenant.tenantId },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, isSystem: true },
      }),
    );
    return rows.map((r) => ({ ...r, expensesCents: 0 }));
  }

  private async recurringRows(ctx: Ctx): Promise<FinanceRecurringRow[]> {
    const rows = await this.db.tx(ctx.tenant.tenantId, (tx) =>
      tx.recurringExpense.findMany({
        where: { tenantId: ctx.tenant.tenantId },
        orderBy: [{ active: 'desc' }, { dayOfMonth: 'asc' }, { title: 'asc' }],
        include: { category: { select: { name: true } } },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      amountCents: r.amountCents,
      categoryId: r.categoryId,
      categoryName: r.category?.name ?? null,
      dayOfMonth: r.dayOfMonth,
      active: r.active,
      lastRunMonth: r.lastRunMonth,
    }));
  }

  // ───────────────────────────── Gastos ─────────────────────────────

  async addExpense(ctx: Ctx, input: ExpenseInput): Promise<FinanceExpenseRow> {
    const tenantId = ctx.tenant.tenantId;
    const timezone = await this.timezoneOf(tenantId);
    const day = input.paidAt ?? todayIn(timezone);

    const created = await this.db.tx(tenantId, async (tx) => {
      await this.assertCategory(tx, tenantId, input.categoryId);
      const expense = await tx.expense.create({
        data: {
          tenantId,
          categoryId: input.categoryId ?? null,
          title: input.title,
          amountCents: input.amountCents,
          paidAt: paidAtLocal(day, timezone),
          notes: input.notes?.trim() || null,
          createdById: ctx.user.id,
        },
      });
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'finance.expense_created',
        entity: 'expense',
        entityId: expense.id,
        after: { title: expense.title, amount: expense.amountCents, paidAt: day },
        ip: ctx.ip,
      });
      return expense;
    });

    return {
      id: created.id,
      title: created.title,
      amountCents: created.amountCents,
      paidAt: day,
      categoryId: created.categoryId,
      categoryName: null,
      notes: created.notes,
      createdByName: ctx.user.name,
    };
  }

  async updateExpense(ctx: Ctx, id: string, input: ExpenseUpdate): Promise<FinanceExpenseRow> {
    const tenantId = ctx.tenant.tenantId;
    const timezone = await this.timezoneOf(tenantId);

    return this.db.tx(tenantId, async (tx) => {
      const before = await tx.expense.findFirst({
        where: { id, tenantId },
        include: { category: { select: { name: true } } },
      });
      if (!before) throw notFound();

      if (input.categoryId) await this.assertCategory(tx, tenantId, input.categoryId);

      const updated = await tx.expense.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
          ...(input.paidAt !== undefined ? { paidAt: paidAtLocal(input.paidAt, timezone) } : {}),
        },
        include: { category: { select: { name: true } } },
      });

      const changes = diff(
        {
          title: before.title,
          amountCents: before.amountCents,
          categoryId: before.categoryId,
          notes: before.notes,
          paidAt: before.paidAt.toISOString(),
        },
        {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
          ...(input.paidAt !== undefined ? { paidAt: updated.paidAt.toISOString() } : {}),
        },
      );
      if (changes) {
        await audit(tx, {
          tenantId,
          userId: ctx.user.id,
          action: 'finance.expense_updated',
          entity: 'expense',
          entityId: id,
          before: changes.before,
          after: changes.after,
          ip: ctx.ip,
        });
      }

      return {
        id: updated.id,
        title: updated.title,
        amountCents: updated.amountCents,
        paidAt: input.paidAt ?? todayIn(timezone),
        categoryId: updated.categoryId,
        categoryName: updated.category?.name ?? null,
        notes: updated.notes,
        createdByName: null,
      };
    });
  }

  async removeExpense(ctx: Ctx, id: string): Promise<void> {
    const tenantId = ctx.tenant.tenantId;
    await this.db.tx(tenantId, async (tx) => {
      const before = await tx.expense.findFirst({ where: { id, tenantId } });
      if (!before) throw notFound();
      await tx.expense.delete({ where: { id } });
      // El gasto se borra, pero la bitácora conserva qué se borró y cuánto: un gasto que
      // desaparece sin rastro es indistinguible de uno que nunca se capturó.
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'finance.expense_deleted',
        entity: 'expense',
        entityId: id,
        before: { title: before.title, amount: before.amountCents },
        ip: ctx.ip,
      });
    });
  }

  async addCategory(ctx: Ctx, name: string): Promise<FinanceExpenseCategoryRow> {
    const tenantId = ctx.tenant.tenantId;
    return this.db.tx(tenantId, async (tx) => {
      const exists = await tx.expenseCategory.findFirst({
        where: { tenantId, name: { equals: name, mode: 'insensitive' } },
      });
      if (exists) return { id: exists.id, name: exists.name, isSystem: exists.isSystem, expensesCents: 0 };

      const created = await tx.expenseCategory.create({
        data: { tenantId, name, isSystem: false },
      });
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'finance.category_created',
        entity: 'expense_category',
        entityId: created.id,
        after: { name: created.name },
        ip: ctx.ip,
      });
      return { id: created.id, name: created.name, isSystem: created.isSystem, expensesCents: 0 };
    });
  }

  async removeCategory(ctx: Ctx, id: string): Promise<void> {
    const tenantId = ctx.tenant.tenantId;
    await this.db.tx(tenantId, async (tx) => {
      const category = await tx.expenseCategory.findFirst({ where: { id, tenantId } });
      if (!category) throw notFound();
      // Las de fábrica no se borran: son las que el reporte espera encontrar y borrar "Fletes"
      // obligaría a recrearla con otro id cada vez que alguien limpia el selector.
      if (category.isSystem) {
        throw new ConflictException({
          code: 'SYSTEM_CATEGORY',
          message: 'Las categorías de fábrica no se pueden eliminar',
        });
      }
      await tx.expense.updateMany({ where: { tenantId, categoryId: id }, data: { categoryId: null } });
      await tx.recurringExpense.updateMany({
        where: { tenantId, categoryId: id },
        data: { categoryId: null },
      });
      await tx.expenseCategory.delete({ where: { id } });
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'finance.category_deleted',
        entity: 'expense_category',
        entityId: id,
        before: { name: category.name },
        ip: ctx.ip,
      });
    });
  }

  // ───────────────────────────── Gastos fijos ─────────────────────────────

  async addRecurring(ctx: Ctx, input: RecurringExpenseInput): Promise<FinanceRecurringRow> {
    const tenantId = ctx.tenant.tenantId;
    return this.db.tx(tenantId, async (tx) => {
      if (input.categoryId) await this.assertCategory(tx, tenantId, input.categoryId);
      const created = await tx.recurringExpense.create({
        data: {
          tenantId,
          title: input.title,
          amountCents: input.amountCents,
          categoryId: input.categoryId ?? null,
          dayOfMonth: input.dayOfMonth,
          active: input.active,
        },
      });
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'finance.recurring_created',
        entity: 'recurring_expense',
        entityId: created.id,
        after: { title: created.title, amount: created.amountCents, dayOfMonth: created.dayOfMonth },
        ip: ctx.ip,
      });
      return {
        id: created.id,
        title: created.title,
        amountCents: created.amountCents,
        categoryId: created.categoryId,
        categoryName: null,
        dayOfMonth: created.dayOfMonth,
        active: created.active,
        lastRunMonth: created.lastRunMonth,
      };
    });
  }

  async updateRecurring(
    ctx: Ctx,
    id: string,
    input: Partial<RecurringExpenseInput>,
  ): Promise<FinanceRecurringRow> {
    const tenantId = ctx.tenant.tenantId;
    return this.db.tx(tenantId, async (tx) => {
      const before = await tx.recurringExpense.findFirst({ where: { id, tenantId } });
      if (!before) throw notFound();
      if (input.categoryId) await this.assertCategory(tx, tenantId, input.categoryId);

      const updated = await tx.recurringExpense.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.dayOfMonth !== undefined ? { dayOfMonth: input.dayOfMonth } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
        include: { category: { select: { name: true } } },
      });
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'finance.recurring_updated',
        entity: 'recurring_expense',
        entityId: id,
        before: { title: before.title, amount: before.amountCents, active: before.active },
        after: { title: updated.title, amount: updated.amountCents, active: updated.active },
        ip: ctx.ip,
      });
      return {
        id: updated.id,
        title: updated.title,
        amountCents: updated.amountCents,
        categoryId: updated.categoryId,
        categoryName: updated.category?.name ?? null,
        dayOfMonth: updated.dayOfMonth,
        active: updated.active,
        lastRunMonth: updated.lastRunMonth,
      };
    });
  }

  async removeRecurring(ctx: Ctx, id: string): Promise<void> {
    const tenantId = ctx.tenant.tenantId;
    await this.db.tx(tenantId, async (tx) => {
      const before = await tx.recurringExpense.findFirst({ where: { id, tenantId } });
      if (!before) throw notFound();
      // Se borra la plantilla, no los gastos ya generados: esos son dinero que salió de verdad.
      await tx.recurringExpense.delete({ where: { id } });
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'finance.recurring_deleted',
        entity: 'recurring_expense',
        entityId: id,
        before: { title: before.title, amount: before.amountCents },
        ip: ctx.ip,
      });
    });
  }

  // ───────────────────────────── Mantenimiento ─────────────────────────────

  /**
   * Materializa los gastos fijos del mes y recalcula el agregado diario.
   *
   * Lo llama el mantenimiento con cerrojo de instancia única. Se puede correr dos veces sin daño:
   * `lastRunMonth` evita duplicar el gasto, y el agregado diario se reescribe por rango.
   */
  async runDaily(): Promise<{ tenants: number; generated: number; days: number }> {
    const tenants = await this.db.system(
      (tx) => tx.$queryRaw<{ id: string; timezone: string }[]>`SELECT "id", "timezone" FROM "tenant"`,
    );

    let generated = 0;
    let days = 0;

    for (const tenant of tenants) {
      try {
        generated += await this.generateRecurring(tenant.id, tenant.timezone);
        const to = todayIn(tenant.timezone);
        const from = shiftDay(to, -FINANCE_ROLLUP_DAYS);
        await this.rollupTenant(tenant.id, tenant.timezone, from, to);
        days += daysBetween(from, to);
      } catch (err) {
        // Un negocio con un gasto fijo raro no puede frenar el cierre de los demás.
        this.log.error(`Finanzas de ${tenant.id} fallaron: ${(err as Error).message}`);
      }
    }

    return { tenants: tenants.length, generated, days };
  }

  /**
   * Crea el gasto del mes por cada plantilla activa que todavía no se generó.
   *
   * Si el día de pago ya pasó, el gasto se fecha el día que correspondía —no hoy— porque el
   * alquiler de marzo es de marzo aunque el mantenimiento corra el día 4. Si aún no llega, se fecha
   * el día programado: el reporte de hoy no lo cuenta hasta que llegue, y tampoco se pierde.
   */
  private async generateRecurring(tenantId: string, timezone: string): Promise<number> {
    const month = monthOf(todayIn(timezone));

    return this.db.tx(tenantId, async (tx) => {
      const pending = await tx.recurringExpense.findMany({
        where: {
          tenantId,
          active: true,
          OR: [{ lastRunMonth: null }, { lastRunMonth: { lt: month } }],
        },
      });

      for (const item of pending) {
        const day = `${month}-${String(item.dayOfMonth).padStart(2, '0')}`;
        await tx.expense.create({
          data: {
            tenantId,
            categoryId: item.categoryId,
            title: item.title,
            amountCents: item.amountCents,
            paidAt: paidAtLocal(day, timezone),
            notes: 'Gasto fijo del mes',
          },
        });
        await tx.recurringExpense.update({ where: { id: item.id }, data: { lastRunMonth: month } });
        await audit(tx, {
          tenantId,
          userId: null,
          action: 'finance.recurring_generated',
          entity: 'recurring_expense',
          entityId: item.id,
          after: { month, amount: item.amountCents, day },
        });
      }

      return pending.length;
    });
  }

  /**
   * Reescribe `daily_metric` para un rango.
   *
   * Borra e inserta en la misma transacción: un día se recalcula completo o no se toca. Es el mismo
   * criterio que el rollup de demanda, y por la misma razón — una corrida que se cae a la mitad no
   * puede dejar el día con la mitad de las ventas.
   */
  async rollupTenant(tenantId: string, timezone: string, from: string, to: string): Promise<number> {
    return this.db.tx(tenantId, async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "daily_metric"
        WHERE "tenantId" = ${tenantId} AND "day" >= ${from}::date AND "day" <= ${to}::date`;

      const inserted = await tx.$executeRaw`
        INSERT INTO "daily_metric"
          ("tenantId", "day", "salesCents", "cogsCents", "expensesCents", "ordersCount", "itemsCount", "missedSearches")
        SELECT
          ${tenantId},
          d."day",
          coalesce(s."sales", 0),
          coalesce(s."cogs", 0),
          coalesce(e."expenses", 0),
          coalesce(s."orders", 0),
          coalesce(s."items", 0),
          coalesce(q."missed", 0)
        FROM (
          SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS "day"
        ) d
        LEFT JOIN (
          SELECT
            ${localDay('i."deliveredAt"', timezone)} AS "day",
            sum(i."totalCents")::int AS "sales",
            sum(i."unitCostCents" * i."quantity")::int AS "cogs",
            count(DISTINCT i."orderId")::int AS "orders",
            sum(i."quantity")::int AS "items"
          FROM "sales_order_item" i
          JOIN "sales_order" o ON o."id" = i."orderId" AND o."tenantId" = i."tenantId"
          WHERE i."tenantId" = ${tenantId}
            AND i."deliveredAt" >= ${localBoundary(from, timezone)}
            AND i."deliveredAt" <  ${localBoundary(nextDay(to), timezone)}
          GROUP BY 1
        ) s ON s."day" = d."day"
        LEFT JOIN (
          SELECT ${localDay('x."paidAt"', timezone)} AS "day", sum(x."amountCents")::int AS "expenses"
          FROM "expense" x
          WHERE x."tenantId" = ${tenantId}
            AND x."paidAt" >= ${localBoundary(from, timezone)}
            AND x."paidAt" <  ${localBoundary(nextDay(to), timezone)}
          GROUP BY 1
        ) e ON e."day" = d."day"
        LEFT JOIN (
          SELECT ${localDay('q."createdAt"', timezone)} AS "day",
                 count(*) FILTER (WHERE q."resultCount" = 0)::int AS "missed"
          FROM "search_event" q
          WHERE q."tenantId" = ${tenantId}
            AND q."createdAt" >= ${localBoundary(from, timezone)}
            AND q."createdAt" <  ${localBoundary(nextDay(to), timezone)}
          GROUP BY 1
        ) q ON q."day" = d."day"
        ON CONFLICT ("tenantId", "day") DO NOTHING`;

      return Number(inserted);
    });
  }

  /** Botón del panel: recalcular sin esperar a la madrugada. Idempotente. */
  async recompute(ctx: Ctx, period?: FinancePeriod): Promise<{ days: number }> {
    const tenantId = ctx.tenant.tenantId;
    const timezone = await this.timezoneOf(tenantId);
    const to = period?.to ?? todayIn(timezone);
    const from = period?.from ?? shiftDay(to, -FINANCE_ROLLUP_DAYS);
    await this.rollupTenant(tenantId, timezone, from, to);
    return { days: daysBetween(from, to) };
  }

  // ───────────────────────────── Apoyo ─────────────────────────────

  /** Crea las categorías de fábrica que falten. `ON CONFLICT` implícito por el unique del negocio. */
  private async ensurePresets(tenantId: string): Promise<void> {
    await this.db.tx(tenantId, async (tx) => {
      const existing = await tx.expenseCategory.count({ where: { tenantId } });
      if (existing >= EXPENSE_PRESETS.length) return;
      await tx.$executeRaw`
        INSERT INTO "expense_category" ("id", "tenantId", "name", "isSystem")
        SELECT gen_random_uuid()::text, ${tenantId}, p."name", true
        FROM unnest(${EXPENSE_PRESETS as unknown as string[]}::text[]) AS p("name")
        ON CONFLICT ("tenantId", "name") DO NOTHING`;
    });
  }

  private async assertCategory(tx: TxClient, tenantId: string, categoryId?: string): Promise<void> {
    if (!categoryId) return;
    const category = await tx.expenseCategory.findFirst({ where: { id: categoryId, tenantId } });
    if (!category) {
      throw new BadRequestException({
        code: 'CATEGORY_NOT_FOUND',
        message: 'Esa categoría no existe en el negocio',
      });
    }
  }

  private async timezoneOf(tenantId: string): Promise<string> {
    const tenant = await this.db.tx(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
    );
    return tenant?.timezone ?? 'America/Guatemala';
  }

  /** Zona del negocio. Público porque el controlador la necesita para calcular el periodo. */
  timezoneOfTenant(tenantId: string): Promise<string> {
    return this.timezoneOf(tenantId);
  }
}

/** Medianoche local de `day`, en el reloj UTC en que están guardadas las columnas `timestamp`. */
function paidAtLocal(day: string, timezone: string): Date {
  // `AT TIME ZONE` en SQL daría lo mismo, pero aquí el valor viaja como Date a Prisma y el
  // desfase se calcula en JS con la misma regla: día local → instante UTC.
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  const offset = tzOffsetMinutes(new Date(utcMidnight), timezone);
  return new Date(utcMidnight - offset * 60_000);
}

function tzOffsetMinutes(date: Date, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.parse(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** `numeric`/`text` de Postgres a número. Nulo es cero: sumar nada no es un error. */
function num(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function notFound() {
  return new NotFoundException({ code: 'EXPENSE_NOT_FOUND', message: 'Ese gasto no existe' });
}

export const __test = { paidAtLocal, tzOffsetMinutes, num };
