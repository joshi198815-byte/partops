import { randomUUID } from 'node:crypto';
import {
  catalogListQuerySchema,
  compatibilityRangeSchema,
  type Permission,
  partCreateSchema,
  partVariantInputSchema,
} from '@partops/contracts';
import { type BaseClient, createBaseClient, systemTx, type TxClient, tenantTx } from '@partops/db';
import { Client } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../common/context.js';
import type { DatabaseService } from '../../infra/database.module.js';
import type { StoredFile } from '../../infra/storage.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { SearchService } from '../search/search.service.js';
import { CatalogService } from './catalog.service.js';
import { ImagesService } from './images.service.js';

/**
 * Catálogo contra Postgres real.
 *
 * Lo que se comprueba aquí no lo puede comprobar un mock: la unicidad de SKU y OEM la decide una
 * consulta con `regexp_replace`, el listado arma el stock con `LATERAL` sobre las bodegas del
 * usuario, y la compatibilidad por rango choca con la trampa de los `NULL` en la clave única del
 * vehículo. Un doble devolvería siempre lo que el test le pidiera.
 *
 * Los casos son los del mostrador: el mismo repuesto que llega dos veces, la pieza que se vendió y
 * no puede borrarse, y la foto de 4 MB que sale del teléfono con la ubicación de la bodega dentro.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

/** Almacenamiento en memoria: el test no debe escribir en `var/uploads` ni en R2. */
class FakeStorage {
  readonly files = new Map<string, Buffer>();
  private seq = 0;

  tenantPrefix(tenantId: string, kind: string, ownerId: string) {
    return `${tenantId}/${kind}/${ownerId}`;
  }

  async put(prefix: string, data: Buffer, extension: string, _contentType: string): Promise<StoredFile> {
    this.seq += 1;
    const key = `${prefix}/img-${this.seq}${extension}`;
    this.files.set(key, data);
    return { key, url: `/api/media/${key}`, bytes: data.byteLength };
  }

  async remove(key: string) {
    this.files.delete(key);
  }

  /** Equivalente al de `ImagesService`: solo hace falta la parte de `/api/media/`. */
  keyFromUrl(url: string) {
    return url.match(/\/api\/media\/(.+)$/)?.[1] ?? null;
  }
}

describe.skipIf(skip)('CatalogService: piezas, variantes, compatibilidad e imágenes', () => {
  let base: BaseClient;
  let catalog: CatalogService;
  let storage: FakeStorage;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  let warehouseId = '';
  let otherWarehouseId = '';

  const ALL: Permission[] = [
    'catalog.view',
    'catalog.create',
    'catalog.update',
    'catalog.archive',
    'catalog.cost.view',
    'inventory.view',
    'inventory.adjust',
  ];

  const ctx = (permissions: Permission[] = ALL, warehouses: string[] = []): Ctx =>
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
        tenantSlug: 'bodega-catalogo',
        role: 'propietario',
        permissions: new Set(permissions),
        warehouseIds: warehouses,
      },
    }) as Ctx;

  /** Cada pieza con un SKU único: los tests comparten negocio y el SKU es único por negocio. */
  let seq = 0;
  function newPart(overrides: Record<string, unknown> = {}) {
    seq += 1;
    return partCreateSchema.parse({
      name: `Pieza de prueba ${seq}`,
      categoryName: 'Capo',
      variants: [{ sku: `SKU-${seq}`, price: 450, cost: 300 }],
      ...overrides,
    });
  }

  /** Etiqueta única por caso: el SKU y el OEM son únicos por negocio y los tests lo comparten. */
  function tag() {
    seq += 1;
    return seq;
  }

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 8 });
    const db = {
      client: base,
      tx: <T>(t: string, fn: (tx: TxClient) => Promise<T>) => tenantTx(base, t, fn),
    } as unknown as DatabaseService;
    storage = new FakeStorage();
    const images = new ImagesService(storage as never);
    catalog = new CatalogService(db, images, new InventoryService(), new SearchService(db));

    await systemTx(base, async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, slug: `cat-${tenantId.slice(0, 8)}`, name: 'Bodega' } });
      await tx.tenant.create({
        data: { id: otherTenantId, slug: `cat-${otherTenantId.slice(0, 8)}`, name: 'Otra' },
      });
      const wh = await tx.warehouse.create({
        data: { tenantId, code: 'B1', name: 'Central', isDefault: true },
      });
      warehouseId = wh.id;
      const wh2 = await tx.warehouse.create({ data: { tenantId, code: 'B2', name: 'Sucursal' } });
      otherWarehouseId = wh2.id;
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
      /**
       * `stock_movement` es el ledger inmutable: su clave ajena a bodega es `Restrict` a propósito
       * y un trigger bloquea el DELETE, para que borrar una bodega o "corregir" un asiento no pueda
       * vaciar la historia de existencias. El aseo del test apaga el trigger y lo vuelve a encender.
       */
      await client.query('ALTER TABLE "stock_movement" DISABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "stock_movement" WHERE "tenantId" = ANY($1)', [
        [tenantId, otherTenantId],
      ]);
      await client.query('ALTER TABLE "stock_movement" ENABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "search_event" WHERE "tenantId" = ANY($1)', [
        [tenantId, otherTenantId],
      ]);
      await client.query('DELETE FROM "audit_log" WHERE "tenantId" = ANY($1)', [[tenantId, otherTenantId]]);
      await client.query('DELETE FROM "tenant" WHERE "id" = ANY($1)', [[tenantId, otherTenantId]]);
    } finally {
      await client.end();
    }
  });

  it('crea la pieza con sus variantes en orden y calcula el rango de precio', async () => {
    const n = tag();
    const input = newPart({
      name: `Capó delantero ${n}`,
      variants: [
        { sku: `capó #${n}a`, price: '450', cost: '300' },
        { sku: `CAPO #${n}B`, price: '520.50' },
      ],
    });
    const part = await catalog.create(ctx(), input);

    expect(part.variants).toHaveLength(2);
    // El acento se cae pero no se come la letra: "capó" y "capo" son el mismo SKU dictado.
    expect(part.variants[0]?.sku).toBe(`CAPO-${n}A`);
    expect(part.variants.map((v) => v.priceCents)).toEqual([45000, 52050]);
    expect(part.priceMin).toBe(45000);
    expect(part.priceMax).toBe(52050);
    expect(part.sku).toBe(`CAPO-${n}A`);
    expect(part.category).toBe('Capo');
  });

  it('rechaza el SKU repetido con el código en el mensaje, para que la pantalla lo señale', async () => {
    const input = newPart({ variants: [{ sku: `DUP-${randomUUID().slice(0, 6)}`, price: 100 }] });
    await catalog.create(ctx(), input);

    await expect(catalog.create(ctx(), input)).rejects.toMatchObject({
      response: { code: 'DUPLICATE_SKU' },
    });
  });

  it('rechaza el mismo OEM en otra pieza pero lo permite entre variantes de la misma', async () => {
    const oem = `53301-${randomUUID().slice(0, 6).toUpperCase()}`;
    const first = newPart({ variants: [{ sku: `OEM-A-${seq}`, price: 100, oemNumbers: [oem] }] });
    const part = await catalog.create(ctx(), first);

    // Equivalente del mismo capó: el mostrador los quiere juntos, con el mismo código.
    const withEquivalent = await catalog.createVariant(
      ctx(),
      part.id,
      partVariantInputSchema.parse({ sku: `OEM-B-${seq}`, price: 120, oemNumbers: [oem.toLowerCase()] }),
    );
    expect(withEquivalent.variants).toHaveLength(2);

    const other = newPart({ variants: [{ sku: `OEM-C-${seq}`, price: 100, oemNumbers: [oem] }] });
    await expect(catalog.create(ctx(), other)).rejects.toMatchObject({
      response: { code: 'DUPLICATE_OEM' },
    });
  });

  it('lista por código OEM y por marca, con facetas que no se recortan entre sí', async () => {
    const brand = `Marca-${randomUUID().slice(0, 5)}`;
    const oem = `04465-${randomUUID().slice(0, 6).toUpperCase()}`;
    await catalog.create(
      ctx(),
      newPart({ brand, variants: [{ sku: `FAC-${seq}`, price: 100, oemNumbers: [oem] }] }),
    );

    const byCode = await catalog.list(ctx(), catalogListQuerySchema.parse({ q: oem.replace('-', ' ') }));
    expect(byCode.items).toHaveLength(1);
    expect(byCode.items[0]?.brand).toBe(brand);

    const byBrand = await catalog.list(ctx(), catalogListQuerySchema.parse({ brand }));
    expect(byBrand.total).toBe(1);
    // Con la marca filtrada, la faceta de categorías sigue contando el resto del catálogo.
    const categories = byBrand.facets.categories.map((c) => c.name);
    expect(categories).toContain('Capo');
  });

  it('filtra por existencia y respeta las bodegas asignadas al usuario', async () => {
    const part = await catalog.create(ctx(), newPart({ name: `Filtro stock ${randomUUID().slice(0, 4)}` }));
    const variantId = part.variants[0]!.id;
    await catalog.adjustStock(ctx(), part.id, variantId, { warehouseId, onHand: 5 });

    const withStock = await catalog.list(ctx(), catalogListQuerySchema.parse({ stock: 'CON', q: part.name }));
    expect(withStock.items.map((i) => i.id)).toContain(part.id);

    // El usuario solo ve la sucursal, donde nunca entró nada: para él la pieza está agotada.
    const scoped = await catalog.detail(ctx(ALL, [otherWarehouseId]), part.id);
    expect(scoped.onHand).toBe(0);
    expect(scoped.outOfStock).toBe(true);

    const out = await catalog.list(
      ctx(ALL, [otherWarehouseId]),
      catalogListQuerySchema.parse({ stock: 'AGOTADO', q: part.name }),
    );
    expect(out.items.map((i) => i.id)).toContain(part.id);
  });

  it('aplica un rango de años sin duplicar el vehículo ni la compatibilidad al reenviar', async () => {
    const part = await catalog.create(ctx(), newPart());
    const range = compatibilityRangeSchema.parse({
      brand: 'Toyota',
      model: 'Hilux',
      yearStart: 2005,
      yearEnd: 2015,
      engine: '2.7L',
    });

    const first = await catalog.addCompatibility(ctx(), part.id, [range]);
    expect(first).toEqual({ added: 1, skipped: 0 });

    // El doble envío desde el teléfono en el pasillo no ensucia: mismo rango, misma aplicación.
    const second = await catalog.addCompatibility(ctx(), part.id, [range]);
    expect(second).toEqual({ added: 0, skipped: 1 });

    const detail = await catalog.detail(ctx(), part.id);
    expect(detail.vehicles).toHaveLength(1);
    expect(detail.vehicles[0]).toMatchObject({ brand: 'Toyota', model: 'Hilux', engine: '2.7L' });

    // Sin motor es OTRO vehículo: en Postgres dos NULL no son iguales y aquí se nota.
    const noEngine = await catalog.addCompatibility(ctx(), part.id, [
      compatibilityRangeSchema.parse({ brand: 'Toyota', model: 'Hilux', yearStart: 2005, yearEnd: 2015 }),
    ]);
    expect(noEngine.added).toBe(1);
  });

  it('ajusta por existencia final y deja el motivo en el ledger', async () => {
    const part = await catalog.create(ctx(), newPart());
    const variantId = part.variants[0]!.id;

    await catalog.adjustStock(ctx(), part.id, variantId, { warehouseId, onHand: 5, reason: 'Conteo' });
    // La persona escribe "quedan 2", no "resta 3".
    const result = await catalog.adjustStock(ctx(), part.id, variantId, {
      warehouseId,
      onHand: 2,
      reason: 'Se rompió una',
    });
    expect(result).toMatchObject({ onHand: 2, reserved: 0, available: 2, delta: -3 });

    const detail = await catalog.detail(ctx(), part.id);
    const movement = detail.movements.find((m) => m.type === 'AJUSTE' && m.delta === -3);
    expect(movement).toBeDefined();
    expect(movement?.reason).toBe('Se rompió una');
    expect(movement?.balanceAfter).toBe(2);
    expect(movement?.warehouseCode).toBe('B1');
  });

  it('no deja el stock en negativo aunque el ajuste lo pida', async () => {
    const part = await catalog.create(ctx(), newPart());
    const variantId = part.variants[0]!.id;
    await catalog.adjustStock(ctx(), part.id, variantId, { warehouseId, onHand: 1 });

    // Un ajuste negativo sobre existencia 1 pediría -2: el ledger es inmutable, no se corrige solo.
    await expect(
      catalog.adjustStock(ctx(), part.id, variantId, { warehouseId, onHand: -1 }),
    ).rejects.toBeDefined();
    const detail = await catalog.detail(ctx(), part.id);
    expect(detail.onHand).toBe(1);
  });

  it('oculta el costo a quien no tiene el permiso, en la lista y en la ficha', async () => {
    const part = await catalog.create(ctx(), newPart());
    const withoutCost = ctx(ALL.filter((p) => p !== 'catalog.cost.view'));

    const detail = await catalog.detail(withoutCost, part.id);
    expect(detail.variants[0]?.costCents).toBeNull();
    // El precio sí se ve: el vendedor cobra, solo no sabe cuánto costó.
    expect(detail.variants[0]?.priceCents).toBe(45000);
  });

  it('archiva la pieza con historia y borra la que nunca se movió', async () => {
    const sold = await catalog.create(ctx(), newPart());
    await catalog.adjustStock(ctx(), sold.id, sold.variants[0]!.id, { warehouseId, onHand: 3 });
    await expect(catalog.remove(ctx(), sold.id)).resolves.toEqual({ archived: true });

    const archived = await catalog.detail(ctx(), sold.id);
    expect(archived.status).toBe('ARCHIVADO');
    // Sigue existiendo: el recibo viejo no puede apuntar a la nada.
    expect(archived.id).toBe(sold.id);

    const fresh = await catalog.create(ctx(), newPart());
    await expect(catalog.remove(ctx(), fresh.id)).resolves.toEqual({ archived: false });
    await expect(catalog.detail(ctx(), fresh.id)).rejects.toMatchObject({
      response: { code: 'PART_NOT_FOUND' },
    });
  });

  it('no deja ver ni tocar piezas de otro negocio', async () => {
    const part = await catalog.create(ctx(), newPart());
    const intruder = { ...ctx(), tenant: { ...ctx().tenant, tenantId: otherTenantId } } as Ctx;

    await expect(catalog.detail(intruder, part.id)).rejects.toMatchObject({
      response: { code: 'PART_NOT_FOUND' },
    });
    const list = await catalog.list(intruder, catalogListQuerySchema.parse({ q: part.name }));
    expect(list.items).toHaveLength(0);
  });

  it('procesa la imagen a AVIF y WebP, sin pasar de 1400 px y con el EXIF fuera', async () => {
    const part = await catalog.create(ctx(), newPart());

    // Foto de teléfono: grande, con EXIF (la orientación y la fecha viajan ahí).
    const original = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 90, g: 110, b: 130 } },
    })
      .jpeg({ quality: 95 })
      .withMetadata()
      .toBuffer();

    const image = await catalog.addImage(ctx(), part.id, {
      buffer: original,
      size: original.byteLength,
      mimetype: 'image/jpeg',
      originalname: 'capo.jpg',
    });

    expect(image.url).toMatch(/\.avif$/);
    const key = image.url.replace('/api/media/', '');
    const avif = storage.files.get(key);
    expect(avif).toBeDefined();
    // AVIF del mismo contenido pesa una fracción de un JPEG de 3000 px: es el punto de recompilar.
    expect(avif!.byteLength).toBeLessThan(original.byteLength / 4);

    const meta = await sharp(avif!).metadata();
    expect(meta.width).toBe(1400);
    expect(meta.height).toBe(933);
    expect(meta.exif).toBeUndefined();

    const row = await systemTx(base, (tx) =>
      tx.partImage.findFirst({ where: { partId: part.id }, select: { fallbackUrl: true, width: true } }),
    );
    expect(row?.fallbackUrl).toMatch(/\.webp$/);
    expect(row?.width).toBe(1400);
  });

  it('rechaza un archivo que dice ser imagen y no lo es', async () => {
    const part = await catalog.create(ctx(), newPart());
    await expect(
      catalog.addImage(ctx(), part.id, {
        buffer: Buffer.from('esto no es una imagen'),
        size: 21,
        mimetype: 'image/jpeg',
        originalname: 'falsa.jpg',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_IMAGE' } });
  });
});
