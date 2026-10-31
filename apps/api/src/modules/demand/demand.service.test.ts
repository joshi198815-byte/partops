import { randomUUID } from 'node:crypto';
import type { Permission } from '@partops/contracts';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../common/context.js';
import type { DatabaseService } from '../../infra/database.module.js';
import { SearchService } from '../search/search.service.js';
import { DemandService } from './demand.service.js';
import { StockWatchService } from './stock-watch.service.js';

/**
 * Demanda contra Postgres real.
 *
 * Lo que se prueba aquí no se puede probar con mocks porque todo depende de fechas: el día del
 * negocio sale de `AT TIME ZONE`, el rollup compara rangos de `timestamp`, y la retención borra por
 * antigüedad. Un mock devolvería las fechas que el test le pidiera y no probaría nada de eso.
 *
 * Los cuatro casos del guion de T13:
 *  - dos variantes de la misma consulta agrupan,
 *  - una consulta con resultados no cuenta como demanda incumplida,
 *  - el rollup cuadra exactamente con los eventos,
 *  - la retención borra eventos y no toca los agregados.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

describe.skipIf(skip)('DemandService: agrupación, rollup y retención', () => {
  let base: BaseClient;
  let demand: DemandService;
  let watches: StockWatchService;

  const tenantId = randomUUID();
  let variantId = '';

  const ctx = (permissions: Permission[] = ['catalog.view', 'demand.view', 'demand.watch.manage']): Ctx =>
    ({
      user: {
        id: 'user-demand',
        email: 'demand@partops.test',
        name: 'Prueba',
        emailVerified: true,
        mustChangePassword: false,
      },
      sessionId: 'session-demand',
      tenant: {
        tenantId,
        tenantName: 'Bodega con Demanda',
        tenantSlug: 'bodega-demanda',
        role: 'propietario',
        permissions: new Set(permissions),
        warehouseIds: [],
      },
    }) as Ctx;

  /** Inserta un evento con la fecha que haga falta: el rollup y la purga dependen de ella. */
  async function event(args: {
    raw: string;
    normalized: string;
    resultCount: number;
    at?: Date;
    brand?: string | null;
    model?: string | null;
    year?: number | null;
  }) {
    await systemTx(base, (tx) =>
      tx.searchEvent.create({
        data: {
          tenantId,
          rawQuery: args.raw,
          normalized: args.normalized,
          brand: args.brand ?? null,
          model: args.model ?? null,
          year: args.year ?? null,
          resultCount: args.resultCount,
          source: 'MOSTRADOR',
          createdAt: args.at ?? new Date(),
        },
      }),
    );
  }

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 8 });
    const db = {
      client: base,
      tx: (t: string, fn: never, options?: never) => tenantTx(base, t, fn, options),
      system: (fn: never, options?: never) => systemTx(base, fn, options),
    } as unknown as DatabaseService;

    demand = new DemandService(db, new SearchService(db));
    watches = new StockWatchService(db);

    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `dem-${tenantId.slice(0, 8)}`,
          name: 'Bodega con Demanda',
          catalogEnabled: true,
        },
      });
      const wh = await tx.warehouse.create({
        data: { tenantId, code: 'B1', name: 'Central', isDefault: true, sellsOnline: true },
      });
      const category = await tx.partCategory.create({
        data: { tenantId, name: 'Pastillas', slug: 'pastillas' },
      });
      const part = await tx.part.create({
        data: { tenantId, name: 'Pastillas de freno', slug: 'pastillas-freno', categoryId: category.id },
      });
      const variant = await tx.partVariant.create({
        data: {
          tenantId,
          partId: part.id,
          sku: 'PAS-001',
          title: 'Delanteras',
          priceCents: 25000,
          costCents: 15000,
        },
      });
      variantId = variant.id;
      await tx.inventoryLevel.create({
        data: { tenantId, variantId: variant.id, warehouseId: wh.id, onHand: 4, reserved: 0 },
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
      await client.query('DELETE FROM "demand_daily" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "search_event" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "stock_watch" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
    } finally {
      await client.end();
    }
  });

  it('dos formas de escribir la misma consulta agrupan en un solo término', async () => {
    // "cubierta" y "capó" llegan ya canonizados a "capo": el panel no debe listarlos por separado.
    await event({
      raw: 'capo corolla',
      normalized: 'capo',
      resultCount: 0,
      brand: 'Toyota',
      model: 'Corolla',
    });
    await event({
      raw: 'Cubierta Corolla',
      normalized: 'capo',
      resultCount: 0,
      brand: 'Toyota',
      model: 'Corolla',
    });

    const panel = await demand.overview(ctx());
    const row = panel.topTerms.find((t) => t.term === 'capo');
    expect(row).toMatchObject({ searches: 2, missedCount: 2 });
  });

  it('una consulta con resultados no aparece como demanda incumplida', async () => {
    await event({ raw: 'pastillas', normalized: 'pastillas', resultCount: 3 });

    const panel = await demand.overview(ctx());
    expect(panel.topTerms.some((t) => t.term === 'pastillas')).toBe(false);
    // Pero sí cuenta en el total: se buscó y se encontró, que es la mitad de la conversión.
    expect(panel.totals.withResults).toBeGreaterThanOrEqual(1);
  });

  it('el rollup cuadra al evento: mismas cuentas por término y por día', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await event({ raw: 'faro sentra', normalized: 'faro', resultCount: 0, at: yesterday });
    await event({ raw: 'faro sentra', normalized: 'faro', resultCount: 2, at: yesterday });
    await event({ raw: 'faro sentra', normalized: 'faro', resultCount: 0 });

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());
    const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(
      new Date(Date.now() - 2 * 86_400_000),
    );

    await demand.rollupTenant(tenantId, 'America/Guatemala', from, today);

    const rows = await systemTx(
      base,
      (tx) =>
        tx.$queryRaw<{ day: string; term: string; searches: number; missed: number }[]>`
        SELECT to_char("day", 'YYYY-MM-DD') AS "day", "term", "searches", "missedCount" AS "missed"
        FROM "demand_daily" WHERE "tenantId" = ${tenantId} AND "term" = 'faro' ORDER BY "day"`,
    );

    // Dos días distintos: ayer y hoy. El término agrupa los tres eventos en dos filas.
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, r) => n + Number(r.searches), 0)).toBe(3);
    expect(rows.reduce((n, r) => n + Number(r.missed), 0)).toBe(2);

    // Recalcular el mismo rango no duplica: el rollup borra e inserta.
    await demand.rollupTenant(tenantId, 'America/Guatemala', from, today);
    const again = await systemTx(
      base,
      (tx) =>
        tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM "demand_daily" WHERE "tenantId" = ${tenantId} AND "term" = 'faro'`,
    );
    expect(Number(again[0]?.count ?? 0)).toBe(2);
  });

  it('la retención borra eventos viejos y deja intactos los agregados', async () => {
    const old = new Date();
    old.setDate(old.getDate() - 45);
    await event({ raw: 'radiador viejo', normalized: 'radiador', resultCount: 0, at: old });

    // El agregado del día viejo se escribe antes de purgar: así se comprueba que sobrevive.
    const oldDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(old);
    await demand.rollupTenant(tenantId, 'America/Guatemala', oldDay, oldDay);

    const result = await demand.runDaily();
    expect(result.purgedEvents).toBeGreaterThanOrEqual(1);

    const left = await systemTx(base, (tx) =>
      tx.searchEvent.count({ where: { tenantId, normalized: 'radiador' } }),
    );
    expect(left).toBe(0);

    const aggregate = await systemTx(base, (tx) =>
      tx.demandDaily.findMany({ where: { tenantId, term: 'radiador' } }),
    );
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]?.searches).toBe(1);
  });

  it('el panel clasifica la demanda por vehículo y por categoría del catálogo', async () => {
    await event({
      raw: 'pastillas hilux',
      normalized: 'pastillas',
      resultCount: 0,
      brand: 'Toyota',
      model: 'Hilux',
    });

    const panel = await demand.overview(ctx());
    const vehicle = panel.byVehicle.find((v) => v.brand === 'Toyota' && v.model === 'Hilux');
    expect(vehicle?.missed).toBeGreaterThanOrEqual(1);

    const category = panel.byCategory.find((c) => c.category === 'Pastillas');
    expect(category?.missed).toBeGreaterThanOrEqual(1);
  });

  it('la bandeja agrupa avisos por pieza y marca solo los que se enviaron', async () => {
    const first = await watches.register(
      tenantId,
      { name: 'Ana Pérez', phone: '+50255550001', variantId },
      '+50255550001',
    );
    expect(first.ok).toBe(true);

    // El mismo teléfono dos veces sobre la misma pieza no se duplica en la lista.
    await watches.register(tenantId, { name: 'Ana P.', phone: '+50255550001', variantId }, '+50255550001');
    await watches.register(tenantId, { name: 'Beto Ruiz', phone: '+50255550002', variantId }, '+50255550002');

    const tray = await watches.tray(ctx());
    expect(tray.pending).toBe(2);
    const group = tray.groups.find((g) => g.variantId === variantId);
    expect(group).toMatchObject({ pending: 2, availableNow: true, sku: 'PAS-001' });

    const notification = await watches.notification(
      ctx(),
      `variant:${variantId}`,
      'https://partops.autos/c/x',
    );
    expect(notification.customers).toHaveLength(2);
    expect(notification.customers[0]?.whatsappUrl).toContain('wa.me/50255550001');
    expect(notification.broadcastText).toContain('Pastillas de freno');
    // El texto del anuncio no lleva teléfonos: se publica, no se volca.
    expect(notification.broadcastText).not.toContain('55550001');

    const marked = await watches.markNotified(
      ctx(),
      notification.customers.map((c) => c.id),
    );
    expect(marked.updated).toBe(2);

    const after = await watches.tray(ctx());
    expect(after.pending).toBe(0);
  });

  it('un aviso sobre una variante de otro negocio se rechaza', async () => {
    const foreign = randomUUID();
    await expect(
      watches.register(tenantId, { name: 'Ana', phone: '+50255550003', variantId: foreign }, '+50255550003'),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });
});
