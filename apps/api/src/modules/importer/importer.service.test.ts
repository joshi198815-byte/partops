import { randomUUID } from 'node:crypto';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import ExcelJS from 'exceljs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../infra/database.module.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { SearchService } from '../search/search.service.js';
import { ImporterService } from './importer.service.js';

/**
 * Importación desde Excel.
 *
 * Lo que se comprueba no es el parseo —eso ya lo cubre `contracts` con las funciones puras—: es
 * que la importación deje la base en un estado coherente. Un importador que crea piezas pero no
 * los movimientos de inventario produce un catálogo que se ve bien y un inventario que no cuadra,
 * y ese descuadre se descubre semanas después, contando a mano.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

function dbLike(base: BaseClient, tenantId: string) {
  const tx: DatabaseService['tx'] = (_, fn, options) => tenantTx(base, tenantId, fn, options);
  return { tx } as unknown as DatabaseService;
}

function ctxLike(tenantId: string) {
  return {
    user: {
      id: '',
      email: 'test@partops.local',
      name: 'Test',
      emailVerified: true,
      mustChangePassword: false,
    },
    sessionId: 'test',
    tenant: {
      tenantId,
      tenantName: 'Test',
      tenantSlug: `t-${tenantId.slice(0, 6)}`,
      role: 'OWNER',
      permissions: new Set(['catalog.import', 'catalog.view', 'inventory.view']),
      warehouseIds: [] as string[],
    },
  } as never;
}

/** Construye un `.xlsx` en memoria con encabezado y filas. Es lo que sube el usuario. */
async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Inventario');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const HEADERS = ['Código', 'Descripción', 'Precio Venta', 'Costo', 'Existencia', 'Bodega', 'Pasillo'];

describe.skipIf(skip)('ImporterService: importación desde Excel', () => {
  let base: BaseClient;
  const inventory = new InventoryService();
  const tenantId = randomUUID();
  const ctx = ctxLike(tenantId);

  let importer: ImporterService;
  let centralId = '';
  let userId = '';

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 20 });
    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `imp-${tenantId.slice(0, 8)}`, name: 'Importaciones' },
      });
      const central = await tx.warehouse.create({
        data: { tenantId, code: 'CEN', name: 'Central', isDefault: true },
      });
      centralId = central.id;
      await tx.warehouse.create({ data: { tenantId, code: 'SUC', name: 'Sucursal Zona 10' } });
      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          email: `imp-${tenantId.slice(0, 8)}@partops.local`,
          name: 'Importador',
          emailVerified: true,
        },
      });
      userId = user.id;
    });
    (ctx as unknown as { user: { id: string } }).user.id = userId;
    importer = new ImporterService(
      dbLike(base, tenantId),
      inventory,
      new SearchService(dbLike(base, tenantId)),
    );
  });

  afterAll(async () => {
    if (!base) return;
    await base.$disconnect();
    const owner = process.env.DIRECT_DATABASE_URL;
    if (!owner) return;
    const client = new Client({ connectionString: owner });
    await client.connect();
    try {
      await client.query('ALTER TABLE "stock_movement" DISABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "stock_movement" WHERE "tenantId" = $1', [tenantId]);
      await client.query('ALTER TABLE "stock_movement" ENABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "import_row_error" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "import_job" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part_compatibility" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "inventory_level" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part_variant" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
    } finally {
      await client.end();
    }
  });

  it('subir no escribe piezas: la vista previa es solo una promesa', async () => {
    const before = await tenantTx(base, tenantId, (tx) => tx.part.count());
    const buffer = await xlsx([
      HEADERS,
      ['CAP-001', 'Capó Corolla', '2,500.00', '1,800.00', '4', 'CEN', 'A-01'],
    ]);

    const result = await importer.upload(ctx, {
      buffer,
      originalname: 'catalogo.xlsx',
      size: buffer.byteLength,
    });

    expect(result.preview.validRows).toBe(1);
    expect(result.preview.parts).toBe(1);
    expect(result.job.status).toBe('PENDIENTE');
    // Las bodegas del negocio viajan para que la UI no obligue a elegir una cuando hay una sola.
    const after = await tenantTx(base, tenantId, (tx) => tx.part.count());
    expect(after).toBe(before);
  });

  it('reconoce los encabezados del Excel real y deja ambiguos los que no entiende', async () => {
    const buffer = await xlsx([
      ['Clave', 'Producto', 'Precio Público', 'Existencia', 'Observaciones internas'],
      ['FAR-001', 'Faro delantero', '950', '2', 'no tocar'],
    ]);
    const result = await importer.upload(ctx, {
      buffer,
      originalname: 'faro.xlsx',
      size: buffer.byteLength,
    });

    expect(result.sheet.mapping.sku).toBe('Clave');
    expect(result.sheet.mapping.name).toBe('Producto');
    expect(result.sheet.mapping.price).toBe('Precio Público');
    expect(result.sheet.unmapped).toContain('Observaciones internas');
  });

  it('confirma todo lo válido y deja afuera la fila mala sin tumbar el lote', async () => {
    const buffer = await xlsx([
      HEADERS,
      ['PST-001', 'Pastillas delanteras', '450', '300', '10', 'CEN', 'B-02'],
      ['PST-002', 'Pastillas traseras', 'sin precio', '300', '5', 'CEN', 'B-03'],
      ['FIL-001', 'Filtro de aceite', '85', '50', '24', 'CEN', 'C-01'],
    ]);
    const uploaded = await importer.upload(ctx, {
      buffer,
      originalname: 'lote.xlsx',
      size: buffer.byteLength,
    });

    const done = await importer.commit(ctx, uploaded.job.id, {
      mode: 'CREAR',
      mapping: uploaded.sheet.mapping,
      warehouseId: null,
    });

    expect(done.status).toBe('PARCIAL');
    expect(done.successRows).toBe(2);
    expect(done.errorRows).toBe(1);
    expect(done.createdParts).toBe(2);
    expect(done.createdVariants).toBe(2);
    // La fila reportada es la que la persona ve en Excel: la 3 del archivo.
    expect(done.rowErrors[0]?.rowNumber).toBe(3);
    expect(done.rowErrors[0]?.message).toContain('Precio');
  });

  it('la existencia inicial entra por el ledger, no escribiendo el saldo', async () => {
    const variants = await tenantTx(base, tenantId, (tx) =>
      tx.partVariant.findMany({
        where: { tenantId, sku: { in: ['PST-001', 'FIL-001'] } },
        select: { id: true, sku: true },
      }),
    );
    const pastillas = variants.find((v) => v.sku === 'PST-001');
    expect(pastillas).toBeTruthy();

    const movements = await tenantTx(base, tenantId, (tx) =>
      tx.stockMovement.findMany({ where: { tenantId, variantId: pastillas!.id } }),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]?.type).toBe('IMPORTACION');
    expect(movements[0]?.delta).toBe(10);
    expect(movements[0]?.balanceAfter).toBe(10);
    expect(movements[0]?.refType).toBe('import_job');

    const level = await tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId: pastillas!.id, warehouseId: centralId } },
      }),
    );
    expect(level?.onHand).toBe(10);
    // El pasillo del Excel es información de bodega, no del catálogo.
    expect(level?.binLocation).toBe('B-02');
  });

  it('dos filas del mismo capó son una pieza con dos variantes, no dos piezas', async () => {
    const buffer = await xlsx([
      ['SKU', 'Nombre', 'Precio', 'Marca Vehículo', 'Modelo', 'Años', 'Existencia', 'Bodega'],
      ['CAP-IZQ', 'Capó Corolla', '2500', 'Toyota', 'Corolla', '2009-2013', '3', 'CEN'],
      ['CAP-DER', 'Capó Corolla', '2500', 'Toyota', 'Corolla', '2009-2013', '2', 'CEN'],
    ]);
    const uploaded = await importer.upload(ctx, {
      buffer,
      originalname: 'capos.xlsx',
      size: buffer.byteLength,
    });
    const done = await importer.commit(ctx, uploaded.job.id, {
      mode: 'CREAR',
      mapping: uploaded.sheet.mapping,
      warehouseId: null,
    });

    expect(done.status, JSON.stringify(done.rowErrors)).toBe('COMPLETADA');
    expect(done.createdParts).toBe(1);
    expect(done.createdVariants).toBe(2);

    const parts = await tenantTx(base, tenantId, (tx) =>
      tx.part.findMany({
        where: { tenantId, name: 'Capó Corolla' },
        select: { id: true, variants: { select: { sku: true } }, compatibilities: true },
      }),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.variants.map((v) => v.sku).sort()).toEqual(['CAP-DER', 'CAP-IZQ']);
    // La compatibilidad se guarda una vez por pieza, no una por variante.
    expect(parts[0]?.compatibilities).toHaveLength(1);
  });

  it('en modo CREAR un SKU repetido se reporta y NO pisa el precio', async () => {
    const before = await tenantTx(base, tenantId, (tx) =>
      tx.partVariant.findUnique({ where: { tenantId_sku: { tenantId, sku: 'PST-001' } } }),
    );

    const buffer = await xlsx([
      HEADERS,
      ['PST-001', 'Pastillas delanteras', '999', '300', '10', 'CEN', 'B-02'],
    ]);
    const uploaded = await importer.upload(ctx, {
      buffer,
      originalname: 'repetido.xlsx',
      size: buffer.byteLength,
    });
    const done = await importer.commit(ctx, uploaded.job.id, {
      mode: 'CREAR',
      mapping: uploaded.sheet.mapping,
      warehouseId: null,
    });

    expect(done.status).toBe('FALLIDA');
    expect(done.rowErrors[0]?.message).toContain('ya existe');

    const after = await tenantTx(base, tenantId, (tx) =>
      tx.partVariant.findUnique({ where: { tenantId_sku: { tenantId, sku: 'PST-001' } } }),
    );
    expect(after?.priceCents).toBe(before?.priceCents);
  });

  it('en modo ACTUALIZAR cambia el precio pero jamás la existencia', async () => {
    const buffer = await xlsx([
      HEADERS,
      ['PST-001', 'Pastillas delanteras', '520', '350', '999', 'CEN', 'B-02'],
    ]);
    const uploaded = await importer.upload(ctx, {
      buffer,
      originalname: 'precios.xlsx',
      size: buffer.byteLength,
    });
    const done = await importer.commit(ctx, uploaded.job.id, {
      mode: 'ACTUALIZAR',
      mapping: uploaded.sheet.mapping,
      warehouseId: null,
    });

    expect(done.status).toBe('COMPLETADA');
    expect(done.updatedVariants).toBe(1);
    expect(done.createdVariants).toBe(0);

    const variant = await tenantTx(base, tenantId, (tx) =>
      tx.partVariant.findUnique({ where: { tenantId_sku: { tenantId, sku: 'PST-001' } } }),
    );
    expect(variant?.priceCents).toBe(52_000);

    const level = await tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId: variant!.id, warehouseId: centralId } },
      }),
    );
    // Sigue en 10: el 999 del Excel es lo que la bodega cree, no lo que el sistema vendió.
    expect(level?.onHand).toBe(10);
  });

  it('OMITIR_EXISTENTES salta los repetidos sin contarlos como error', async () => {
    const buffer = await xlsx([
      HEADERS,
      ['PST-001', 'Pastillas delanteras', '520', '350', '10', 'CEN', 'B-02'],
      ['NEW-900', 'Bomba de agua', '700', '400', '1', 'CEN', 'D-04'],
    ]);
    const uploaded = await importer.upload(ctx, {
      buffer,
      originalname: 'mixto.xlsx',
      size: buffer.byteLength,
    });
    const done = await importer.commit(ctx, uploaded.job.id, {
      mode: 'OMITIR_EXISTENTES',
      mapping: uploaded.sheet.mapping,
      warehouseId: null,
    });

    expect(done.status).toBe('COMPLETADA');
    expect(done.skippedRows).toBe(1);
    expect(done.createdVariants).toBe(1);
    expect(done.errorRows).toBe(0);
  });

  it('una bodega que no existe rechaza la fila en vez de cargarla en la central', async () => {
    const buffer = await xlsx([
      HEADERS,
      ['ERR-001', 'Espejo izquierdo', '300', '100', '2', 'BODEGA-FANTASMA', ''],
    ]);
    const uploaded = await importer.upload(ctx, {
      buffer,
      originalname: 'bodega.xlsx',
      size: buffer.byteLength,
    });
    const done = await importer.commit(ctx, uploaded.job.id, {
      mode: 'CREAR',
      mapping: uploaded.sheet.mapping,
      warehouseId: null,
    });

    expect(done.status).toBe('FALLIDA');
    expect(done.rowErrors[0]?.message).toContain('no existe');

    const phantom = await tenantTx(base, tenantId, (tx) =>
      tx.partVariant.findUnique({ where: { tenantId_sku: { tenantId, sku: 'ERR-001' } } }),
    );
    expect(phantom).toBeNull();
  });

  it('un código de barras repetido se rechaza antes de romper la etiqueta', async () => {
    const first = await xlsx([
      ['SKU', 'Nombre', 'Precio', 'Barcode'],
      ['EAN-001', 'Bujía iridio', '95', '7501234567890'],
    ]);
    const a = await importer.upload(ctx, { buffer: first, originalname: 'a.xlsx', size: first.byteLength });
    await importer.commit(ctx, a.job.id, { mode: 'CREAR', mapping: a.sheet.mapping, warehouseId: null });

    const second = await xlsx([
      ['SKU', 'Nombre', 'Precio', 'Barcode'],
      ['EAN-002', 'Bujía platino', '140', '7501234567890'],
    ]);
    const b = await importer.upload(ctx, {
      buffer: second,
      originalname: 'b.xlsx',
      size: second.byteLength,
    });
    const done = await importer.commit(ctx, b.job.id, {
      mode: 'CREAR',
      mapping: b.sheet.mapping,
      warehouseId: null,
    });

    expect(done.status).toBe('FALLIDA');
    expect(done.rowErrors[0]?.message).toContain('código de barras');
  });

  it('no deja confirmar dos veces el mismo archivo', async () => {
    const buffer = await xlsx([HEADERS, ['DOBLE-1', 'Sensor MAP', '480', '300', '1', 'CEN', '']]);
    const uploaded = await importer.upload(ctx, {
      buffer,
      originalname: 'doble.xlsx',
      size: buffer.byteLength,
    });
    await importer.commit(ctx, uploaded.job.id, {
      mode: 'CREAR',
      mapping: uploaded.sheet.mapping,
      warehouseId: null,
    });

    await expect(
      importer.commit(ctx, uploaded.job.id, {
        mode: 'CREAR',
        mapping: uploaded.sheet.mapping,
        warehouseId: null,
      }),
    ).rejects.toThrow(/ya se confirmó/i);
  });

  it('recalcula la vista previa con el mapeo corregido a mano', async () => {
    const buffer = await xlsx([
      ['A', 'B', 'C'],
      ['SKU-1', 'Amortiguador', '1,200'],
    ]);
    const uploaded = await importer.upload(ctx, {
      buffer,
      originalname: 'sin-encabezados.xlsx',
      size: buffer.byteLength,
    });
    // Sin encabezados reconocibles, la vista previa automática no tiene nada que interpretar.
    expect(uploaded.preview.validRows).toBe(0);

    const preview = await importer.preview(ctx, uploaded.job.id, {
      sku: 'A',
      name: 'B',
      price: 'C',
    });
    expect(preview.validRows).toBe(1);
    expect(preview.sample[0]?.row.name).toBe('Amortiguador');
  });
});
