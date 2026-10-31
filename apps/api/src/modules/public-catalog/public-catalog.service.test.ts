import { randomUUID } from 'node:crypto';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../infra/database.module.js';
import type { PushService } from '../../infra/push.service.js';
import type { RealtimeService } from '../../infra/realtime.service.js';
import { StockWatchService } from '../demand/stock-watch.service.js';
import { DispatchNotifier } from '../dispatch/dispatch.notifier.js';
import { DispatchService } from '../dispatch/dispatch.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { PublicCatalogService } from './public-catalog.service.js';
import { PublicGuardService } from './public-guard.service.js';

/**
 * Catálogo público contra Postgres.
 *
 * Cuatro cosas que solo se pueden probar con la base de verdad:
 *
 *  1. **El slug de otro negocio no revela nada.** Ni sus piezas, ni su existencia, ni la existencia
 *     de que existe. Es el mismo tipo de prueba que el aislamiento por RLS, pero en la única ruta
 *     sin sesión del producto.
 *  2. **Sin existencia no hay pedido.** El botón se apaga en la vitrina y el servidor lo vuelve a
 *     comprobar: la página pudo quedarse abierta desde ayer.
 *  3. **El rate limit corta el abuso.** Seis pedidos por IP por hora; el séptimo ni toca el stock.
 *  4. **El pedido web entra a la misma cola de bodega.** No hay un camino paralelo: si lo hubiera,
 *     la misma pieza se podría reservar dos veces desde dos pantallas distintas.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

function dbLike(base: BaseClient, tenantId: string) {
  const tx: DatabaseService['tx'] = (_, fn, options) => tenantTx(base, tenantId, fn, options);
  const system: DatabaseService['system'] = (fn, options) => systemTx(base, fn, options);
  return { tx, system } as unknown as DatabaseService;
}

function realtimeLike() {
  return { emitUpdate: () => undefined, emitNotice: () => undefined } as unknown as RealtimeService;
}

function pushLike() {
  return {
    publicKey: null,
    available: false,
    notifyWarehouse: async () => ({ sent: 0, failed: 0, removed: 0 }),
  } as unknown as PushService;
}

/** Contexto del empleado que prepara: el pedido web tiene que aparecer en SU cola. */
function ctxLike(tenantId: string, userId: string) {
  return {
    user: {
      id: userId,
      email: 'bodega@partops.local',
      name: 'Bodeguero',
      emailVerified: true,
      mustChangePassword: false,
    },
    sessionId: 'test',
    tenant: {
      tenantId,
      tenantName: 'Test',
      tenantSlug: `t-${tenantId.slice(0, 6)}`,
      role: 'bodeguero',
      permissions: new Set(['orders.view', 'orders.dispatch', 'inventory.view']),
      warehouseIds: [] as string[],
    },
  } as never;
}

describe.skipIf(skip)('catálogo público: aislamiento, existencia y cola de bodega', () => {
  let base: BaseClient;
  const inventory = new InventoryService();

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const slug = `pub-${tenantId.slice(0, 8)}`;
  const otherSlug = `pub-otro-${otherTenantId.slice(0, 8)}`;

  let service: PublicCatalogService;
  let guard: PublicGuardService;
  let dispatch: DispatchService;
  let orders: OrdersService;
  let warehouseId = '';
  let staffCtx: ReturnType<typeof ctxLike>;
  let variantId = '';
  let scarceVariantId = '';
  let offlineVariantId = '';
  let partSlug = '';
  let seq = 0;

  const order = (over: Partial<Parameters<PublicCatalogService['order']>[1]> = {}) => ({
    customerName: 'Taller La Esquina',
    customerPhone: '5555-1234',
    idempotencyKey: randomUUID(),
    items: [{ variantId, quantity: 1 }],
    ...over,
  });

  const ip = () => `10.0.${seq}.${(seq * 7) % 255}`;

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 20 });

    const db = dbLike(base, tenantId);
    const realtime = realtimeLike();
    const push = pushLike();
    orders = new OrdersService(db, inventory, realtime, new DispatchNotifier(realtime, push));
    dispatch = new DispatchService(db, orders, realtime, push);
    guard = new PublicGuardService(db);
    service = new PublicCatalogService(db, orders, guard, new StockWatchService(db));

    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug,
          name: 'Repuestos El Tornillo',
          catalogEnabled: true,
          whatsapp: '5555-0000',
          catalogTagline: 'Piezas para tu carro, hoy',
        },
      });
      await tx.tenant.create({
        data: {
          id: otherTenantId,
          slug: otherSlug,
          name: 'Bodega Ajena',
          catalogEnabled: true,
        },
      });

      const warehouse = await tx.warehouse.create({
        data: { tenantId, code: 'CEN', name: 'Central', isDefault: true, sellsOnline: true },
      });
      warehouseId = warehouse.id;

      // Segunda bodega que NO vende en línea: su existencia no debe publicarse ni reservarse desde
      // la vitrina, aunque tenga la pieza.
      await tx.warehouse.create({
        data: { tenantId, code: 'BOD', name: 'Bodega interna', sellsOnline: false },
      });

      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          email: `pub-${tenantId.slice(0, 8)}@partops.local`,
          name: 'Bodeguero',
          emailVerified: true,
        },
      });

      const part = await tx.part.create({
        data: {
          tenantId,
          name: 'Filtro de aceite',
          slug: `filtro-${tenantId.slice(0, 8)}`,
          brand: 'Toyota',
          searchText: 'Filtro de aceite Toyota OEM-9001',
        },
      });
      partSlug = part.slug;

      const variant = await tx.partVariant.create({
        data: {
          tenantId,
          partId: part.id,
          sku: `PUB-${tenantId.slice(0, 6)}-1`,
          title: '1.8L',
          partNumber: '90915-YZZD4',
          oemNumbers: ['OEM-9001'],
          priceCents: 12_500,
          costCents: 8_000,
        },
      });
      variantId = variant.id;

      const scarce = await tx.partVariant.create({
        data: {
          tenantId,
          partId: part.id,
          sku: `PUB-${tenantId.slice(0, 6)}-2`,
          title: '2.0L',
          priceCents: 15_000,
          costCents: 9_000,
        },
      });
      scarceVariantId = scarce.id;

      const otherPart = await tx.part.create({
        data: { tenantId: otherTenantId, name: 'Pieza ajena', slug: `ajena-${otherTenantId.slice(0, 8)}` },
      });
      const otherVariant = await tx.partVariant.create({
        data: {
          tenantId: otherTenantId,
          partId: otherPart.id,
          sku: `AJA-${otherTenantId.slice(0, 6)}`,
          title: 'Única',
          priceCents: 99_000,
        },
      });
      const otherWarehouse = await tx.warehouse.create({
        data: { tenantId: otherTenantId, code: 'AJ', name: 'Ajena', isDefault: true, sellsOnline: true },
      });
      offlineVariantId = otherVariant.id;

      staffCtx = ctxLike(tenantId, user.id);
      expect(otherWarehouse.id).toBeTruthy();
    });

    // Existencia: 8 del filtro, 1 de la variante escasa. La bodega interna tiene 50 de una pieza
    // que no se publica.
    await seed(variantId, 8);
    await seed(scarceVariantId, 1);
    await tenantTx(base, otherTenantId, async (tx) => {
      const warehouse = await tx.warehouse.findFirstOrThrow({ where: { tenantId: otherTenantId } });
      await inventory.apply(tx, {
        tenantId: otherTenantId,
        variantId: offlineVariantId,
        warehouseId: warehouse.id,
        onHandDelta: 5,
        type: 'COMPRA',
      });
    });
  });

  async function seed(id: string, qty: number) {
    seq += 1;
    await tenantTx(base, tenantId, (tx) =>
      inventory.apply(tx, {
        tenantId,
        variantId: id,
        warehouseId,
        onHandDelta: qty,
        type: 'COMPRA',
        reason: 'Carga de prueba',
      }),
    );
  }

  afterAll(async () => {
    if (!base) return;
    await base.$disconnect();
    const owner = process.env.DIRECT_DATABASE_URL;
    if (!owner) return;
    const client = new Client({ connectionString: owner });
    await client.connect();
    try {
      await client.query('ALTER TABLE "stock_movement" DISABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "stock_movement" WHERE "tenantId" = ANY($1::text[])', [
        [tenantId, otherTenantId],
      ]);
      await client.query('ALTER TABLE "stock_movement" ENABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "inventory_level" WHERE "tenantId" = ANY($1::text[])', [
        [tenantId, otherTenantId],
      ]);
      await client.query('DELETE FROM "public_hit" WHERE "tenantId" = ANY($1::text[])', [
        [tenantId, otherTenantId],
      ]);
      await client.query('DELETE FROM "tenant" WHERE "id" = ANY($1::text[])', [[tenantId, otherTenantId]]);
    } finally {
      await client.end();
    }
  });

  it('la vitrina publica existencia como disponibilidad, nunca como número', async () => {
    const page = await service.list(slug, { q: '', page: 1 });
    const item = page.items.find((i) => i.slug === partSlug);
    expect(item).toBeDefined();
    expect(item?.availability).toBe('HAY');
    // La variante con 1 unidad se publica como "últimas", no como "1".
    const scarce = item?.variants.find((v) => v.id === scarceVariantId);
    expect(scarce?.availability.map((a) => a.bucket)).toEqual(['POCAS']);
    expect(JSON.stringify(page)).not.toContain('costCents');
  });

  it('un negocio sin catálogo publicado responde igual que uno inexistente', async () => {
    await systemTx(base, (tx) =>
      tx.tenant.update({ where: { id: otherTenantId }, data: { catalogEnabled: false } }),
    );
    await expect(service.list(otherSlug, { q: '', page: 1 })).rejects.toThrowError(/no existe/i);
    await expect(service.list('no-existe-esta-bodega', { q: '', page: 1 })).rejects.toThrowError(
      /no existe/i,
    );
    await systemTx(base, (tx) =>
      tx.tenant.update({ where: { id: otherTenantId }, data: { catalogEnabled: true } }),
    );
  });

  it('la pieza de otro negocio no aparece ni por enlace directo en el slug ajeno', async () => {
    // La ficha se busca SIEMPRE dentro del negocio del slug: pedir el slug ajeno con el slug de la
    // pieza propia tiene que dar 404, no la pieza.
    await expect(service.part(otherSlug, partSlug)).rejects.toThrowError(/no existe/i);
    // Y al revés, la pieza del otro negocio no está en mi vitrina.
    const mine = await service.list(slug, { q: '', page: 1 });
    expect(mine.items.every((i) => i.slug !== `ajena-${otherTenantId.slice(0, 8)}`)).toBe(true);
  });

  it('una variante que solo está en bodega sin venta en línea no se puede pedir', async () => {
    // Pieza nueva que únicamente tiene existencia en la bodega interna: en la vitrina no existe,
    // y aunque alguien copie su id, el pedido se rechaza antes de tocar el inventario.
    const inner = await tenantTx(base, tenantId, (tx) =>
      tx.warehouse.findFirstOrThrow({ where: { tenantId, code: 'BOD' } }),
    );
    const hidden = await systemTx(base, async (tx) => {
      const part = await tx.part.findFirstOrThrow({ where: { tenantId, slug: partSlug } });
      return tx.partVariant.create({
        data: {
          tenantId,
          partId: part.id,
          sku: `PUB-${tenantId.slice(0, 6)}-INT`,
          title: 'Solo bodega',
          priceCents: 30_000,
        },
      });
    });
    await tenantTx(base, tenantId, (tx) =>
      inventory.apply(tx, {
        tenantId,
        variantId: hidden.id,
        warehouseId: inner.id,
        onHandDelta: 9,
        type: 'COMPRA',
      }),
    );

    // No aparece en la vitrina.
    const page = await service.list(slug, { q: '', page: 1 });
    const item = page.items.find((i) => i.slug === partSlug);
    expect(item?.variants.some((v) => v.id === hidden.id)).toBe(false);

    // Y pedirla da error de negocio, no un pedido que la bodega no puede surtir.
    await expect(
      service.order(slug, order({ items: [{ variantId: hidden.id, quantity: 1 }] }), {
        ip: ip(),
        origin: 'https://partops.gt',
      }),
    ).rejects.toThrowError(/ya no está disponible/i);
  });

  it('el pedido web entra a la misma cola de bodega, con canal CATALOGO', async () => {
    const result = await service.order(slug, order(), { ip: ip(), origin: 'https://partops.gt' });

    expect(result.code).toMatch(/^PD-\d{4}$/);
    expect(result.allAvailable).toBe(true);
    expect(result.whatsappUrl).toContain('wa.me/50255550000');
    expect(result.whatsappUrl).toContain(encodeURIComponent(result.code));

    const queue = await dispatch.queue(staffCtx, { q: '', onlyActionable: true });
    const row = queue.orders.find((o) => o.code === result.code);
    expect(row).toBeDefined();
    expect(row?.channel).toBe('CATALOGO');
    expect(row?.customerName).toBe('Taller La Esquina');
    expect(row?.pendingUnits).toBe(1);
  });

  it('repetir el pedido con la misma clave no reserva dos veces', async () => {
    const key = randomUUID();
    const before = await tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId } },
      }),
    );

    const first = await service.order(slug, order({ idempotencyKey: key }), {
      ip: ip(),
      origin: 'https://partops.gt',
    });
    const second = await service.order(slug, order({ idempotencyKey: key }), {
      ip: ip(),
      origin: 'https://partops.gt',
    });

    expect(second.code).toBe(first.code);

    const after = await tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId } },
      }),
    );
    // Una sola reserva: el reintento del teléfono no aparta otra pieza.
    expect(after.reserved).toBe(before.reserved + 1);
  });

  it('el rate limit corta el séptimo pedido de la misma IP sin tocar el stock', async () => {
    const ip2 = '203.0.113.77';
    for (let i = 0; i < 6; i += 1) {
      expect(await guard.hit(guard.keyFor(ip2), 'PEDIDO', tenantId)).toBe(true);
    }
    expect(await guard.hit(guard.keyFor(ip2), 'PEDIDO', tenantId)).toBe(false);

    const stockBefore = await tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId } },
      }),
    );

    await expect(
      service.order(slug, order(), { ip: ip2, origin: 'https://partops.gt' }),
    ).rejects.toThrowError(/varios pedidos/i);

    const stockAfter = await tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUniqueOrThrow({
        where: { variantId_warehouseId: { variantId, warehouseId } },
      }),
    );
    expect(stockAfter.reserved).toBe(stockBefore.reserved);
  });

  it('la búsqueda del visitante registra demanda con origen CATALOGO', async () => {
    await service.trackSearch(slug, 'faro corolla 2009', '198.51.100.9');
    const rows = await tenantTx(base, tenantId, (tx) =>
      tx.searchEvent.findMany({ where: { tenantId, source: 'CATALOGO' } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.resultCount).toBe(0);
  });

  /**
   * El selector de vehículo.
   *
   * Las marcas del selector tienen que salir de la COMPATIBILIDAD, no de la marca de la pieza: un
   * cliente que elige "Toyota" busca piezas que le queden a un Toyota, y una pieza de marca
   * genérica compatible con ese modelo tiene que aparecer igual.
   */
  it('el selector de vehículo ofrece marcas compatibles y filtra por año', async () => {
    const suffix = tenantId.slice(0, 8);
    const brandName = `Marca-${suffix}`;
    const modelName = `Modelo-${suffix}`;

    const vehicle = await systemTx(base, async (tx) => {
      const brand = await tx.vehicleBrand.create({ data: { name: brandName } });
      const model = await tx.vehicleModel.create({
        data: { brandId: brand.id, name: modelName },
      });
      const row = await tx.vehicle.create({
        data: { modelId: model.id, yearStart: 2003, yearEnd: 2008, engine: '1.8L' },
      });
      const part = await tx.part.findFirstOrThrow({ where: { tenantId, slug: partSlug } });
      await tx.partCompatibility.create({
        data: { tenantId, partId: part.id, vehicleId: row.id },
      });
      return row;
    });

    // La marca de la PIEZA es "Toyota"; la marca del VEHÍCULO es la recién creada. El selector debe
    // ofrecer la segunda y no la primera.
    const all = await service.list(slug, { q: '', page: 1 });
    const offered = all.facets.vehicles.brands.map((b) => b.name);
    expect(offered).toContain(brandName);

    const forVehicle = await service.list(slug, {
      q: '',
      brand: brandName,
      model: modelName,
      year: 2005,
      page: 1,
    });
    expect(forVehicle.items.map((i) => i.slug)).toEqual([partSlug]);

    // Un año fuera del rango no debe traer la pieza: el filtro por año es lo que evita vender una
    // pieza que no le queda al carro del cliente.
    const wrongYear = await service.list(slug, {
      q: '',
      brand: brandName,
      model: modelName,
      year: 2015,
      page: 1,
    });
    expect(wrongYear.items).toHaveLength(0);

    // Limpieza: el vocabulario vehicular es global y sobrevive al borrado del negocio.
    await systemTx(base, (tx) => tx.vehicle.delete({ where: { id: vehicle.id } }));
  });
});
