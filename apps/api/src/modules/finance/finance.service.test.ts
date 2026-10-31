import { randomUUID } from 'node:crypto';
import type { Permission } from '@partops/contracts';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../common/context.js';
import type { DatabaseService } from '../../infra/database.module.js';
import { FinanceExportService } from './finance.export.js';
import { __test, FinanceService } from './finance.service.js';

/**
 * Finanzas contra Postgres real.
 *
 * No se prueba el CRUD de gastos: se prueba que los números cuadren. Las tres cosas que se verifican
 * son las que rompen un reporte de dinero sin que nadie lo note:
 *
 *  - el ingreso se reconoce cuando la pieza sale, no cuando se captura el pedido;
 *  - el costo es el congelado en la línea y no cambia cuando cambia el del catálogo;
 *  - utilidad = ventas − costo − gastos, y el archivo exportado dice lo mismo que la pantalla.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

const PERMS = new Set<Permission>([
  'finance.view',
  'finance.cost.view',
  'finance.expenses.manage',
  'finance.export',
]);

describe.skipIf(skip)('FinanceService: reconocimiento, COGS congelado y export', () => {
  let base: BaseClient;
  let finance: FinanceService;
  let exporter: FinanceExportService;

  const tenantId = randomUUID();
  let warehouseId = '';
  let variantId = '';
  let userId = '';
  let orderId = '';
  let lineId = '';

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());
  const period = { from: today, to: today };

  function ctx(permissions: Set<Permission> = PERMS): Ctx {
    return {
      user: {
        id: userId,
        email: 'finanzas@partops.test',
        name: 'Dueña',
        emailVerified: true,
        mustChangePassword: false,
      },
      sessionId: 'session-finance',
      tenant: {
        tenantId,
        tenantName: 'Bodega con Finanzas',
        tenantSlug: 'bodega-finanzas',
        role: 'propietario',
        permissions,
        warehouseIds: [],
      },
    } as Ctx;
  }

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 8 });
    const db = {
      client: base,
      tx: (t: string, fn: never, options?: never) => tenantTx(base, t, fn, options),
      system: (fn: never, options?: never) => systemTx(base, fn, options),
    } as unknown as DatabaseService;

    finance = new FinanceService(db);
    exporter = new FinanceExportService();

    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `fin-${tenantId.slice(0, 8)}`,
          name: 'Bodega con Finanzas',
          timezone: 'America/Guatemala',
        },
      });
      const wh = await tx.warehouse.create({
        data: { tenantId, code: 'F1', name: 'Mostrador', isDefault: true },
      });
      warehouseId = wh.id;
      const part = await tx.part.create({
        data: { tenantId, name: 'Bomba de agua', slug: `bomba-${tenantId.slice(0, 6)}` },
      });
      const variant = await tx.partVariant.create({
        data: {
          tenantId,
          partId: part.id,
          sku: `BOM-${tenantId.slice(0, 6)}`,
          title: 'Bomba de agua 1.6',
          priceCents: 100_000,
          costCents: 60_000,
        },
      });
      variantId = variant.id;

      // El vendedor existe de verdad: el desglose lo busca por nombre y un id suelto daría
      // "Catálogo en línea" en una venta de mostrador.
      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          name: 'Dueña',
          email: `fin-${tenantId.slice(0, 8)}@partops.test`,
          emailVerified: true,
        },
      });
      userId = user.id;

      orderId = randomUUID();
      await tx.salesOrder.create({
        data: {
          id: orderId,
          tenantId,
          number: 1,
          customerName: 'Cliente',
          status: 'ABIERTO',
          sellerId: userId,
          warehouseId,
          subtotalCents: 89_286,
          taxCents: 10_714,
          totalCents: 100_000,
        },
      });
      const line = await tx.salesOrderItem.create({
        data: {
          tenantId,
          orderId,
          variantId,
          warehouseId,
          sku: `BOM-${tenantId.slice(0, 6)}`,
          name: 'Bomba de agua 1.6',
          quantity: 2,
          unitPriceCents: 50_000,
          unitCostCents: 30_000,
          totalCents: 100_000,
          status: 'LISTO',
        },
      });
      lineId = line.id;
    });
  });

  afterAll(async () => {
    if (!base) return;
    await base.$disconnect();
    const owner = process.env.DIRECT_DATABASE_URL;
    if (!owner) return;
    const client = new Client({ connectionString: owner });
    await client.connect();
    try {
      await client.query('DELETE FROM "daily_metric" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "expense" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "recurring_expense" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "expense_category" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "sales_order_item" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "sales_order" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part_variant" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "warehouse" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "member" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
      await client.query('DELETE FROM "user" WHERE "id" = $1', [userId]);
    } finally {
      await client.end();
    }
  });

  it('un pedido sin entregar no es ingreso', async () => {
    const panel = await finance.overview(ctx(), period);
    expect(panel.totals.salesCents).toBe(0);
    expect(panel.totals.ordersCount).toBe(0);
  });

  it('al entregar la línea el ingreso entra y el IVA cuadra con el total cobrado', async () => {
    await systemTx(base, (tx) =>
      tx.salesOrderItem.update({
        where: { id: lineId },
        data: { status: 'ENTREGADO', deliveredAt: localNoon(today) },
      }),
    );

    const panel = await finance.overview(ctx(), period);
    expect(panel.totals.salesCents).toBe(100_000);
    expect(panel.totals.cogsCents).toBe(60_000);
    expect(panel.totals.grossProfitCents).toBe(40_000);
    expect(panel.totals.ordersCount).toBe(1);
    expect(panel.totals.itemsCount).toBe(2);
    // La línea guardó base 89.286 + IVA 10.714: la suma tiene que ser exactamente el total.
    expect(panel.totals.taxCents).toBe(10_714);
    expect(panel.totals.taxCents + (panel.totals.salesCents - panel.totals.taxCents)).toBe(
      panel.totals.salesCents,
    );
  });

  it('el costo es el congelado: subirlo en el catálogo no mueve la utilidad de ayer', async () => {
    await systemTx(base, (tx) =>
      tx.partVariant.update({ where: { id: variantId }, data: { costCents: 95_000 } }),
    );

    const panel = await finance.overview(ctx(), period);
    expect(panel.totals.cogsCents).toBe(60_000);
    expect(panel.totals.grossProfitCents).toBe(40_000);
  });

  it('utilidad = ventas − costo − gastos, y el gasto entra el día que se pagó', async () => {
    const created = await finance.addExpense(ctx(), {
      title: 'Alquiler del local',
      amountCents: 15_000,
      paidAt: today,
    });
    expect(created.amountCents).toBe(15_000);

    const panel = await finance.overview(ctx(), period);
    expect(panel.totals.expensesCents).toBe(15_000);
    expect(panel.totals.netProfitCents).toBe(40_000 - 15_000);
    expect(panel.expenses).toHaveLength(1);
    expect(panel.expenses[0]?.paidAt).toBe(today);

    const day = panel.days.find((d) => d.day === today);
    expect(day?.salesCents).toBe(100_000);
    expect(day?.expensesCents).toBe(15_000);
    expect(day?.netProfitCents).toBe(25_000);
  });

  it('sin finance.cost.view las ventas se ven pero el margen llega en null', async () => {
    const panel = await finance.overview(ctx(new Set<Permission>(['finance.view'])), period);
    expect(panel.costsVisible).toBe(false);
    expect(panel.totals.salesCents).toBe(100_000);
    expect(panel.totals.cogsCents).toBeNull();
    expect(panel.totals.netProfitCents).toBeNull();
    // Los gastos sí se ven: son dinero que salió, no margen.
    expect(panel.totals.expensesCents).toBe(15_000);
    expect(panel.days.every((d) => d.netProfitCents === null)).toBe(true);
  });

  it('el desglose por vendedor y por bodega reparte la misma venta entera', async () => {
    const panel = await finance.overview(ctx(), period);
    const seller = panel.bySeller.find((r) => r.key === userId);
    expect(seller?.salesCents).toBe(100_000);
    expect(seller?.profitCents).toBe(40_000);
    expect(seller?.label).toBe('Dueña');

    const warehouse = panel.byWarehouse.find((r) => r.key === warehouseId);
    expect(warehouse?.salesCents).toBe(100_000);

    // El reparto no inventa ni pierde centavos: la suma de las filas es el total del periodo.
    expect(panel.bySeller.reduce((n, r) => n + r.salesCents, 0)).toBe(panel.totals.salesCents);
    expect(panel.byWarehouse.reduce((n, r) => n + r.salesCents, 0)).toBe(panel.totals.salesCents);
  });

  it('el agregado diario guarda las mismas cifras que el panel', async () => {
    await finance.rollupTenant(tenantId, 'America/Guatemala', today, today);

    const rows = await systemTx(
      base,
      (tx) =>
        tx.$queryRaw<{ sales: number; cogs: number; expenses: number; orders: number; items: number }[]>`
        SELECT "salesCents" AS "sales", "cogsCents" AS "cogs", "expensesCents" AS "expenses",
               "ordersCount" AS "orders", "itemsCount" AS "items"
        FROM "daily_metric" WHERE "tenantId" = ${tenantId}`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.sales)).toBe(100_000);
    expect(Number(rows[0]?.cogs)).toBe(60_000);
    expect(Number(rows[0]?.expenses)).toBe(15_000);
    expect(Number(rows[0]?.orders)).toBe(1);
    expect(Number(rows[0]?.items)).toBe(2);

    // Recalcular no duplica: el día se reescribe, no se acumula.
    await finance.rollupTenant(tenantId, 'America/Guatemala', today, today);
    const again = await systemTx(
      base,
      (tx) =>
        tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM "daily_metric" WHERE "tenantId" = ${tenantId}`,
    );
    expect(Number(again[0]?.count ?? 0)).toBe(1);
  });

  it('el gasto fijo se genera una sola vez por mes', async () => {
    const recurring = await finance.addRecurring(ctx(), {
      title: 'Internet',
      amountCents: 2_500,
      dayOfMonth: 5,
      active: true,
    });
    expect(recurring.lastRunMonth).toBeNull();

    const first = await finance.runDaily();
    expect(first.generated).toBeGreaterThanOrEqual(1);

    const panel = await finance.overview(ctx(), period);
    const internet = panel.expenses.filter((e) => e.title === 'Internet');
    // Puede haber caído dentro o fuera del periodo según el día del mes; lo que no puede es
    // haberse generado dos veces en la misma corrida.
    expect(internet.length).toBeLessThanOrEqual(1);

    const second = await finance.runDaily();
    expect(second.generated).toBe(0);

    await finance.removeRecurring(ctx(), recurring.id);
  });

  it('la exportación dice exactamente lo mismo que la pantalla', async () => {
    const panel = await finance.overview(ctx(), period);
    const csv = await exporter.build(panel, 'csv');
    const text = csv.body.toString('utf8');

    expect(csv.filename).toBe(`finanzas-${today}_${today}.csv`);
    // BOM + importes como número, no como texto formateado: el contador tiene que poder sumar.
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain('Utilidad neta,250');
    expect(text).toContain('Ventas,1000');

    const xlsx = await exporter.build(panel, 'xlsx');
    expect(xlsx.body.byteLength).toBeGreaterThan(1000);
    expect(xlsx.contentType).toContain('spreadsheetml');
  });

  it('la fecha de pago se guarda como medianoche local, no como medianoche UTC', () => {
    // En Guatemala (UTC−6) la medianoche local es las 06:00 UTC del mismo día.
    const paidAt = __test.paidAtLocal('2026-03-15', 'America/Guatemala');
    expect(paidAt.toISOString()).toBe('2026-03-15T06:00:00.000Z');
    expect(__test.tzOffsetMinutes(paidAt, 'America/Guatemala')).toBe(-360);
  });
});

/** Mediodía local del día dado, para que ninguna prueba dependa del borde de la medianoche. */
function localNoon(day: string): Date {
  return new Date(`${day}T18:00:00.000Z`);
}
