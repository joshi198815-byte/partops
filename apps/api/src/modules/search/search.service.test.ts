import { randomUUID } from 'node:crypto';
import type { Permission } from '@partops/contracts';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../common/context.js';
import type { DatabaseService } from '../../infra/database.module.js';
import { SearchService } from './search.service.js';

/**
 * Búsqueda contra Postgres real.
 *
 * Lo que se prueba aquí no se puede probar con mocks: el ranking combina `ts_rank_cd`, `similarity`
 * de trigramas y un `EXISTS` de compatibilidad vehicular, y el texto de búsqueda lo genera un
 * trigger de la base. Un mock devolvería lo que el test le pidiera y no probaría nada.
 *
 * Los casos son los del mostrador: el código exacto manda, la errata encuentra, el año filtra y lo
 * que no existe queda registrado como demanda.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

describe.skipIf(skip)('SearchService: ranking, facetas y demanda', () => {
  let base: BaseClient;
  /**
   * El servicio se construye en `beforeAll`: su constructor pide la base y crear el cliente al
   * cargar el módulo dejaría conexiones abiertas en un proceso donde quizá no hay `DATABASE_URL`.
   */
  let search: SearchService;

  const tenantId = randomUUID();
  let otherTenantId = '';
  let warehouseId = '';
  let otherWarehouseId = '';

  const ctx = (permissions: Permission[] = ['catalog.view', 'demand.view']): Ctx =>
    ({
      user: {
        id: 'user-test',
        email: 'test@partops.test',
        name: 'Prueba',
        emailVerified: true,
        mustChangePassword: false,
      },
      sessionId: 'session-test',
      tenant: {
        tenantId,
        tenantName: 'Bodega de prueba',
        tenantSlug: 'bodega-prueba',
        role: 'propietario',
        permissions: new Set(permissions),
        warehouseIds: [],
      },
    }) as Ctx;

  async function seedVehicle(brand: string, model: string, start: number, end: number) {
    return systemTx(base, async (tx) => {
      const b = await tx.vehicleBrand.upsert({
        where: { name: brand },
        update: {},
        create: { name: brand },
      });
      const m = await tx.vehicleModel.upsert({
        where: { brandId_name: { brandId: b.id, name: model } },
        update: {},
        create: { brandId: b.id, name: model },
      });
      const existing = await tx.vehicle.findFirst({
        where: { modelId: m.id, yearStart: start, yearEnd: end },
        select: { id: true },
      });
      if (existing) return existing.id;
      const v = await tx.vehicle.create({ data: { modelId: m.id, yearStart: start, yearEnd: end } });
      return v.id;
    });
  }

  async function seedPart(args: {
    tenant: string;
    name: string;
    category?: string;
    sku: string;
    oem?: string[];
    vehicles?: string[];
    stock?: number;
  }) {
    return systemTx(base, async (tx) => {
      const slug = `${args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 6)}`;
      let categoryId: string | null = null;
      if (args.category) {
        const c = await tx.partCategory.upsert({
          where: { tenantId_slug: { tenantId: args.tenant, slug: args.category.toLowerCase() } },
          update: {},
          create: { tenantId: args.tenant, name: args.category, slug: args.category.toLowerCase() },
        });
        categoryId = c.id;
      }
      const part = await tx.part.create({
        data: { tenantId: args.tenant, name: args.name, slug, categoryId, brand: 'Genérico' },
      });
      // La variante dispara el trigger que llena `searchText` con nombre, SKU, OEM y aplicaciones.
      const variant = await tx.partVariant.create({
        data: {
          tenantId: args.tenant,
          partId: part.id,
          sku: args.sku,
          title: args.name,
          priceCents: 45000,
          costCents: 30000,
          oemNumbers: args.oem ?? [],
        },
      });
      for (const vehicleId of args.vehicles ?? []) {
        await tx.partCompatibility.create({
          data: { tenantId: args.tenant, partId: part.id, vehicleId },
        });
      }
      if (args.stock) {
        await tx.inventoryLevel.create({
          data: {
            tenantId: args.tenant,
            variantId: variant.id,
            warehouseId,
            onHand: args.stock,
            reserved: 0,
            reorderPoint: 2,
            binLocation: 'A-3',
          },
        });
      }
      return { partId: part.id, variantId: variant.id };
    });
  }

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 8 });
    const db = {
      client: base,
      tx: (t: string, fn: never) => tenantTx(base, t, fn),
    } as unknown as DatabaseService;
    search = new SearchService(db);

    otherTenantId = randomUUID();
    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `busq-${tenantId.slice(0, 8)}`, name: 'Bodega' },
      });
      await tx.tenant.create({
        data: { id: otherTenantId, slug: `busq-${otherTenantId.slice(0, 8)}`, name: 'Otra' },
      });
      const wh = await tx.warehouse.create({
        data: { tenantId, code: 'B1', name: 'Central', isDefault: true },
      });
      warehouseId = wh.id;
      const wh2 = await tx.warehouse.create({ data: { tenantId, code: 'B2', name: 'Sucursal' } });
      otherWarehouseId = wh2.id;
    });

    const corolla = await seedVehicle('Toyota', 'Corolla', 2003, 2008);
    const corollaNew = await seedVehicle('Toyota', 'Corolla', 2009, 2013);
    const hilux = await seedVehicle('Toyota', 'Hilux', 2005, 2015);
    const sentra = await seedVehicle('Nissan', 'Sentra', 2007, 2012);

    await seedPart({
      tenant: tenantId,
      name: 'Capó delantero',
      category: 'Capo',
      sku: 'CAP-COR-0308',
      oem: ['53301-02040'],
      vehicles: [corolla],
      stock: 3,
    });
    await seedPart({
      tenant: tenantId,
      name: 'Capó delantero',
      category: 'Capo',
      sku: 'CAP-COR-0913',
      oem: ['53301-02330'],
      vehicles: [corollaNew],
      stock: 1,
    });
    await seedPart({
      tenant: tenantId,
      name: 'Pastillas de freno delanteras',
      category: 'Pastillas',
      sku: 'PAS-HIL-05',
      oem: ['04465-0K290'],
      vehicles: [hilux],
      stock: 8,
    });
    await seedPart({
      tenant: tenantId,
      name: 'Faro delantero derecho',
      category: 'Faro',
      sku: 'FAR-SEN-0712',
      oem: ['26010-ET000'],
      vehicles: [sentra],
    });

    // El mismo OEM en otro negocio: no debe aparecer nunca en los resultados del primero.
    await seedPart({
      tenant: otherTenantId,
      name: 'Capó delantero',
      category: 'Capo',
      sku: 'CAP-AJENO',
      oem: ['53301-02040'],
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
      await client.query('DELETE FROM "search_event" WHERE "tenantId" = ANY($1)', [
        [tenantId, otherTenantId],
      ]);
      await client.query('DELETE FROM "tenant" WHERE "id" = ANY($1)', [[tenantId, otherTenantId]]);
    } finally {
      await client.end();
    }
  });

  it('el código OEM exacto sale primero, aunque el texto no coincida', async () => {
    const res = await search.run(ctx(), { q: '04465-0K290' });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]?.name).toBe('Pastillas de freno delanteras');
    expect(res.hits[0]?.codeMatch).toBe(true);
  });

  it('tolera el código escrito con espacio en vez de guion', async () => {
    const res = await search.run(ctx(), { q: '04465 0k290' });
    expect(res.hits.map((h) => h.name)).toContain('Pastillas de freno delanteras');
  });

  it('encuentra por nombre en lenguaje de mostrador aunque el catálogo diga otra palabra', async () => {
    // En el catálogo está "Capó"; el vendedor escribe "cubierta", que es el sinónimo local.
    const res = await search.run(ctx(), { q: 'cubierta corolla 2009' });
    expect(res.hits.map((h) => h.name)).toContain('Capó delantero');
    expect(res.parsed.synonym).toBe(true);
  });

  it('el año filtra por compatibilidad: un capó de 2003–2008 no aplica a un 2009', async () => {
    const res = await search.run(ctx(), { q: 'capo corolla 2009' });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]?.variants[0]?.sku).toBe('CAP-COR-0913');
  });

  it('infiere la marca del modelo cuando no se escribe', async () => {
    const res = await search.run(ctx(), { q: 'capo corolla' });
    expect(res.parsed.brand).toBe('Toyota');
    expect(res.parsed.model).toBe('Corolla');
    expect(res.hits).toHaveLength(2);
  });

  it('corrige la errata del modelo y la ofrece como sugerencia', async () => {
    const res = await search.run(ctx(), { q: 'capo toyota corola 2009' });
    expect(res.parsed.suggestions).toContain('corolla');
    expect(res.hits.map((h) => h.name)).toContain('Capó delantero');
  });

  it('trae existencia y ubicación de cada bodega, y lo disponible descuenta la reserva', async () => {
    const res = await search.run(ctx(), { q: 'capo corolla 2009' });
    const variant = res.hits[0]?.variants[0];
    expect(variant?.totalAvailable).toBe(1);
    const central = variant?.availability.find((a) => a.warehouseCode === 'B1');
    expect(central).toMatchObject({ available: 1, binLocation: 'A-3', reorderPoint: 2 });
    // La segunda bodega aparece con 0: saber dónde NO hay también es información de mostrador.
    expect(variant?.availability.find((a) => a.warehouseCode === 'B2')?.available).toBe(0);
  });

  it('no filtra piezas de otro negocio, ni siquiera por el mismo OEM', async () => {
    const res = await search.run(ctx(), { q: '53301-02040' });
    expect(res.hits.map((h) => h.name)).toEqual(['Capó delantero']);
    expect(res.hits[0]?.variants.map((v) => v.sku)).not.toContain('CAP-AJENO');
  });

  it('respeta las bodegas asignadas al usuario', async () => {
    const c = ctx();
    c.tenant.warehouseIds = [otherWarehouseId];
    const res = await search.run(c, { q: 'capo corolla 2009' });
    const variant = res.hits[0]?.variants[0];
    expect(variant?.availability.map((a) => a.warehouseCode)).toEqual(['B2']);
    expect(variant?.totalAvailable).toBe(0);
  });

  it('oculta el costo a quien no puede verlo', async () => {
    const visible = await search.run(ctx(['catalog.view', 'demand.view', 'catalog.cost.view']), {
      q: 'capo corolla 2009',
    });
    expect(visible.hits[0]?.variants[0]?.costCents).toBe(30000);

    const hidden = await search.run(ctx(['catalog.view']), { q: 'capo corolla 2009' });
    expect(hidden.hits[0]?.variants[0]?.costCents).toBeNull();
  });

  it('ofrece facetas de marca y modelo del texto, y no se recortan al filtrar', async () => {
    const all = await search.run(ctx(), { q: 'delantero' });
    expect(all.facets.brands.map((b) => b.name).sort()).toEqual(['Nissan', 'Toyota']);

    const filtered = await search.run(ctx(), { q: 'delantero', brand: 'Nissan' });
    expect(filtered.hits.every((h) => h.vehicles.some((v) => v.brand === 'Nissan'))).toBe(true);
    // El filtro no debe borrar la otra marca de la barra: si lo hiciera, no habría vuelta atrás.
    expect(filtered.facets.brands.map((b) => b.name)).toContain('Toyota');
  });

  it('las facetas cuadran con los resultados cuando hay año en el texto', async () => {
    // Dos capós de Corolla existen, pero solo uno aplica a 2009. La faceta no puede decir "2".
    const res = await search.run(ctx(), { q: 'capo corolla 2009' });
    expect(res.hits).toHaveLength(1);
    const toyota = res.facets.brands.find((b) => b.name === 'Toyota');
    expect(toyota?.count).toBe(1);
  });

  it('registra la búsqueda sin resultado como demanda incumplida', async () => {
    await search.run(ctx(), { q: 'turbo mitsubishi l200 2015' });
    const demand = await search.demand(ctx());
    const row = demand.find((d) => d.term.includes('turbo'));
    expect(row).toBeDefined();
    expect(row?.missedCount).toBeGreaterThanOrEqual(1);
    expect(row?.model).toBe('L200');
  });

  it('una búsqueda con resultados no aparece en demanda', async () => {
    await search.run(ctx(), { q: 'pastillas hilux' });
    const demand = await search.demand(ctx());
    expect(demand.some((d) => d.term.includes('pastillas'))).toBe(false);
  });

  it('una consulta vacía devuelve el catálogo en vez de fallar', async () => {
    const res = await search.run(ctx(), { q: '' });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.total).toBe(res.hits.length);
  });
});
