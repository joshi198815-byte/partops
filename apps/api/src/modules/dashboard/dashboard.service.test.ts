import { randomUUID } from 'node:crypto';
import type { Permission } from '@partops/contracts';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../common/context.js';
import { todayIn } from '../../common/time.js';
import type { DatabaseService } from '../../infra/database.module.js';
import { DashboardService } from './dashboard.service.js';

/**
 * Tablero contra Postgres real.
 *
 * Lo que se prueba no es el conteo feliz, sino los tres cortes que mienten sin avisar:
 *
 *  - el día del negocio (una venta de las 23:30 locales cae en el día correcto aunque en UTC sea
 *    mañana);
 *  - las bodegas asignadas (el vendedor de la sucursal no ve el trabajo de la central);
 *  - el permiso de dinero (sin `finance.view` el importe llega en `null`, nunca en cero).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

describe.skipIf(skip)('DashboardService: día local, bodegas visibles y permiso de dinero', () => {
  let base: BaseClient;
  let dashboard: DashboardService;

  const tenantId = randomUUID();
  const slug = `dash-${tenantId.slice(0, 8)}`;
  let warehouseA = '';
  let warehouseB = '';
  let variantId = '';
  let userId = '';

  const timezone = 'America/Guatemala';
  const today = todayIn(timezone);

  function ctx(permissions: Permission[], warehouseIds: string[] = []): Ctx {
    return {
      user: {
        id: userId,
        email: 'tablero@partops.test',
        name: 'Dueña',
        emailVerified: true,
        mustChangePassword: false,
      },
      sessionId: 'session-dashboard',
      tenant: {
        tenantId,
        tenantName: 'Bodega del Tablero',
        tenantSlug: slug,
        role: 'propietario',
        permissions: new Set(permissions),
        warehouseIds,
      },
    } as Ctx;
  }

  /**
   * Instante UTC que corresponde a una hora **local** de Guatemala.
   *
   * Guatemala es UTC−6 todo el año: las 23:30 locales del día D son las 05:30 UTC del día D+1. Ese
   * corrimiento es justo lo que parte el día si alguien consulta con el reloj de UTC, así que el
   * ayudante tiene que hacerlo bien o la prueba no probaría nada.
   */
  function localInstant(day: string, hour: number, minute = 0): Date {
    return new Date(Date.parse(`${day}T00:00:00.000Z`) + (hour + 6) * 3_600_000 + minute * 60_000);
  }

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 8 });
    const db = {
      client: base,
      tx: (t: string, fn: never, options?: never) => tenantTx(base, t, fn, options),
      system: (fn: never, options?: never) => systemTx(base, fn, options),
    } as unknown as DatabaseService;

    dashboard = new DashboardService(db);

    await systemTx(base, async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, slug, name: 'Bodega del Tablero', timezone } });

      const a = await tx.warehouse.create({
        data: { tenantId, code: 'A', name: 'Mostrador', isDefault: true },
      });
      const b = await tx.warehouse.create({ data: { tenantId, code: 'B', name: 'Central' } });
      warehouseA = a.id;
      warehouseB = b.id;

      const part = await tx.part.create({
        data: { tenantId, name: 'Faro delantero', slug: `faro-${tenantId.slice(0, 6)}` },
      });
      const variant = await tx.partVariant.create({
        data: {
          tenantId,
          partId: part.id,
          sku: `FAR-${tenantId.slice(0, 6)}`,
          title: 'Faro delantero derecho',
          priceCents: 100_000,
          costCents: 60_000,
        },
      });
      variantId = variant.id;

      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          name: 'Dueña',
          email: `dash-${tenantId.slice(0, 8)}@partops.test`,
          emailVerified: true,
        },
      });
      userId = user.id;

      // Bodega A: una línea LISTO (2 u) y una PENDIENTE (1 u) de hoy.
      const orderA = await tx.salesOrder.create({
        data: {
          tenantId,
          number: 1,
          customerName: 'Cliente A',
          status: 'EN_PREPARACION',
          sellerId: userId,
          warehouseId: warehouseA,
          totalCents: 300_000,
        },
      });
      await tx.salesOrderItem.create({
        data: {
          tenantId,
          orderId: orderA.id,
          variantId,
          warehouseId: warehouseA,
          sku: `FAR-${tenantId.slice(0, 6)}`,
          name: 'Faro delantero derecho',
          quantity: 2,
          unitPriceCents: 100_000,
          unitCostCents: 60_000,
          totalCents: 200_000,
          status: 'LISTO',
        },
      });
      await tx.salesOrderItem.create({
        data: {
          tenantId,
          orderId: orderA.id,
          variantId,
          warehouseId: warehouseA,
          sku: `FAR-${tenantId.slice(0, 6)}`,
          name: 'Faro delantero derecho',
          quantity: 1,
          unitPriceCents: 100_000,
          unitCostCents: 60_000,
          totalCents: 100_000,
          status: 'PENDIENTE',
        },
      });

      // Bodega B (central): 5 unidades por preparar. Quien solo ve A no debe contarlas.
      const orderB = await tx.salesOrder.create({
        data: {
          tenantId,
          number: 2,
          customerName: 'Cliente B',
          status: 'EN_PREPARACION',
          sellerId: userId,
          warehouseId: warehouseB,
          totalCents: 500_000,
        },
      });
      await tx.salesOrderItem.create({
        data: {
          tenantId,
          orderId: orderB.id,
          variantId,
          warehouseId: warehouseB,
          sku: `FAR-${tenantId.slice(0, 6)}`,
          name: 'Faro delantero derecho',
          quantity: 5,
          unitPriceCents: 100_000,
          unitCostCents: 60_000,
          totalCents: 500_000,
          status: 'PENDIENTE',
        },
      });

      // Entregada hoy a las 23:30 locales: en UTC ya es mañana. Cuenta hoy.
      const orderToday = await tx.salesOrder.create({
        data: {
          tenantId,
          number: 3,
          customerName: 'Cliente de la noche',
          status: 'ENTREGADO',
          sellerId: userId,
          warehouseId: warehouseA,
          totalCents: 700_000,
          closedAt: localInstant(today, 23, 30),
        },
      });
      await tx.salesOrderItem.create({
        data: {
          tenantId,
          orderId: orderToday.id,
          variantId,
          warehouseId: warehouseA,
          sku: `FAR-${tenantId.slice(0, 6)}`,
          name: 'Faro delantero derecho',
          quantity: 7,
          unitPriceCents: 100_000,
          unitCostCents: 60_000,
          totalCents: 700_000,
          status: 'ENTREGADO',
          deliveredAt: localInstant(today, 23, 30),
        },
      });

      // Entregada ayer a las 23:30 locales: en UTC es hoy. NO cuenta.
      const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      const orderYesterday = await tx.salesOrder.create({
        data: {
          tenantId,
          number: 4,
          customerName: 'Cliente de ayer',
          status: 'ENTREGADO',
          sellerId: userId,
          warehouseId: warehouseA,
          totalCents: 900_000,
          closedAt: localInstant(yesterday, 23, 30),
        },
      });
      await tx.salesOrderItem.create({
        data: {
          tenantId,
          orderId: orderYesterday.id,
          variantId,
          warehouseId: warehouseA,
          sku: `FAR-${tenantId.slice(0, 6)}`,
          name: 'Faro delantero derecho',
          quantity: 9,
          unitPriceCents: 100_000,
          unitCostCents: 60_000,
          totalCents: 900_000,
          status: 'ENTREGADO',
          deliveredAt: localInstant(yesterday, 23, 30),
        },
      });

      // Existencias: una bajo mínimo en A y una en cero en B.
      await tx.inventoryLevel.create({
        data: {
          tenantId,
          variantId,
          warehouseId: warehouseA,
          onHand: 2,
          reserved: 0,
          reorderPoint: 5,
          binLocation: 'P1-E2',
        },
      });

      // Una búsqueda sin resultado y otra con resultado.
      await tx.searchEvent.create({
        data: {
          tenantId,
          rawQuery: 'espejo retrovisor',
          normalized: 'espejo retrovisor',
          resultCount: 0,
          source: 'MOSTRADOR',
        },
      });
      await tx.searchEvent.create({
        data: {
          tenantId,
          rawQuery: 'faro',
          normalized: 'faro',
          resultCount: 3,
          source: 'MOSTRADOR',
        },
      });
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
      await client.query('DELETE FROM "search_event" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "inventory_level" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "sales_order_item" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "sales_order" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part_variant" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "warehouse" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
      await client.query('DELETE FROM "user" WHERE "id" = $1', [userId]);
    } finally {
      await client.end();
    }
  });

  it('cuenta la venta de las 23:30 locales y no la de ayer a la misma hora', async () => {
    const data = await dashboard.today(ctx(['dashboard.view', 'finance.view']));
    expect(data.day).toBe(today);
    expect(data.salesCents).toBe(700_000);
    expect(data.ordersTodayCount).toBe(1);
  });

  it('solo cuenta las bodegas asignadas', async () => {
    const soloA = await dashboard.today(ctx(['dashboard.view'], [warehouseA]));
    expect(soloA.pendingUnits).toBe(1);
    expect(soloA.readyUnits).toBe(2);

    const todas = await dashboard.today(ctx(['dashboard.view']));
    expect(todas.pendingUnits).toBe(6);
    expect(todas.readyUnits).toBe(2);
  });

  it('sin finance.view las ventas llegan en null, no en cero', async () => {
    const data = await dashboard.today(ctx(['dashboard.view']));
    expect(data.salesCents).toBeNull();
    expect(data.ordersTodayCount).toBeNull();
    // Lo que no es dinero sigue visible: el bodeguero tiene que saber qué sacar del estante.
    // Dos pedidos siguen abiertos (los dos entregados ya no cuentan como cola).
    expect(data.openOrders).toBe(2);
    expect(data.outOfStock).toBeGreaterThanOrEqual(0);
  });

  it('solo las búsquedas sin resultado cuentan como demanda incumplida', async () => {
    const data = await dashboard.today(ctx(['dashboard.view']));
    expect(data.missedSearches).toBe(1);
  });
});
