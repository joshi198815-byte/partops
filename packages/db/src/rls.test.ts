import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BaseClient,
  createBaseClient,
  systemClient,
  systemTx,
  tenantClient,
  tenantTx,
} from './index.js';

/**
 * Lo que este archivo prueba: si la app olvida un `where tenantId`, la base NO devuelve datos
 * del vecino. Se corre contra Postgres real porque una política RLS simulada no prueba nada.
 *
 * Requiere DATABASE_URL apuntando al rol `partops_app` (sin BYPASSRLS) y DIRECT_DATABASE_URL al
 * dueño. Si no hay base disponible, el archivo se salta en lugar de fallar en CI sin Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';

const canRun = Boolean(DATABASE_URL);

describe.skipIf(!canRun)('RLS: aislamiento entre negocios', () => {
  let base: BaseClient;
  const sys = () => systemClient(base);
  const tenantA = { id: '', name: 'Repuestos El Oso' };
  const tenantB = { id: '', name: 'Importadora San José' };
  let partA = '';
  let partB = '';
  let warehouseA = '';

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 6 });

    // Provisionamiento: se hace como sistema porque las tablas ya tienen RLS forzado.
    await systemTx(base, async (tx) => {
      const suffix = randomUUID().slice(0, 8);
      for (const t of [tenantA, tenantB]) {
        const created = await tx.tenant.create({
          data: { slug: `test-${suffix}-${t.name.length}`, name: t.name },
        });
        t.id = created.id;
      }

      const catA = await tx.partCategory.create({
        data: { tenantId: tenantA.id, name: 'Carrocería', slug: 'carroceria' },
      });
      const catB = await tx.partCategory.create({
        data: { tenantId: tenantB.id, name: 'Carrocería', slug: 'carroceria' },
      });

      const pA = await tx.part.create({
        data: { tenantId: tenantA.id, name: 'Capó Corolla', slug: 'capo-corolla', categoryId: catA.id },
      });
      const pB = await tx.part.create({
        data: { tenantId: tenantB.id, name: 'Capó Sentra', slug: 'capo-sentra', categoryId: catB.id },
      });
      partA = pA.id;
      partB = pB.id;

      await tx.partVariant.create({
        data: { tenantId: tenantA.id, partId: pA.id, sku: `A-${suffix}`, title: 'Única', priceCents: 100000 },
      });
      await tx.partVariant.create({
        data: { tenantId: tenantB.id, partId: pB.id, sku: `B-${suffix}`, title: 'Única', priceCents: 200000 },
      });

      const wh = await tx.warehouse.create({
        data: { tenantId: tenantA.id, code: 'CENTRAL', name: 'Bodega Central', isDefault: true },
      });
      warehouseA = wh.id;
    });
  });

  afterAll(async () => {
    if (!base) return;
    await base.$disconnect();
    /**
     * La limpieza va como DUEÑO y con los triggers apagados, porque el ledger de inventario es
     * append-only a propósito: ni siquiera el sistema puede borrar movimientos con el rol de la app.
     * Esto es teardown de test, no un camino de producto; borrar un negocio real es un
     * procedimiento administrativo documentado, no un DELETE.
     */
    const owner = (process.env.DIRECT_DATABASE_URL ?? '').trim();
    if (!owner) return;
    const { Client } = await import('pg');
    const client = new Client({ connectionString: owner });
    await client.connect();
    try {
      await client.query('ALTER TABLE "stock_movement" DISABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "stock_movement" WHERE "tenantId" = ANY($1)', [
        [tenantA.id, tenantB.id],
      ]);
      await client.query('ALTER TABLE "stock_movement" ENABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "inventory_level" WHERE "tenantId" = ANY($1)', [
        [tenantA.id, tenantB.id],
      ]);
      await client.query('DELETE FROM "tenant" WHERE "id" = ANY($1)', [[tenantA.id, tenantB.id]]);
    } finally {
      await client.end();
    }
  });

  it('el cliente de A solo ve filas de A', async () => {
    const parts = await tenantClient(base, tenantA.id).part.findMany({ select: { name: true } });
    expect(parts.map((p) => p.name)).toEqual(['Capó Corolla']);
  });

  it('el cliente de B no ve la pieza de A', async () => {
    const found = await tenantClient(base, tenantB.id).part.findUnique({ where: { id: partA } });
    expect(found).toBeNull();
  });

  it('un findMany sin filtro de tenant no filtra datos ajenos', async () => {
    // El punto central: esta consulta NO tiene where. Sin RLS devolvería todo el catálogo global.
    const all = await tenantClient(base, tenantA.id).part.findMany();
    expect(all.every((p) => p.id !== partB)).toBe(true);
  });

  it('no se puede insertar una fila con el tenant de otro', async () => {
    await expect(
      tenantClient(base, tenantA.id).part.create({
        data: { tenantId: tenantB.id, name: 'Intruso', slug: 'intruso' },
      }),
    ).rejects.toThrow();
  });

  it('no se puede leer ni escribir el inventario de otro negocio', async () => {
    const levels = await tenantClient(base, tenantB.id).inventoryLevel.findMany();
    expect(levels).toEqual([]);
    const whs = await tenantClient(base, tenantB.id).warehouse.findMany();
    expect(whs).toEqual([]);
    expect(warehouseA).not.toBe('');
  });

  it('la transacción de tenant fija el contexto para varias consultas', async () => {
    const result = await tenantTx(base, tenantA.id, async (tx) => {
      const parts = await tx.part.count();
      const categories = await tx.partCategory.count();
      const warehouses = await tx.warehouse.count();
      return { parts, categories, warehouses };
    });
    expect(result).toEqual({ parts: 1, categories: 1, warehouses: 1 });
  });

  it('el cliente de sistema sí ve ambos negocios (para cron y panel)', async () => {
    const parts = await sys().part.findMany({ where: { id: { in: [partA, partB] } } });
    expect(parts).toHaveLength(2);
  });

  it('sin contexto de tenant no se ve nada, ni siquiera con el cliente base', async () => {
    // Falla cerrada: si la transacción no fijó app.tenant_id, la política no deja pasar nada.
    const parts = await base.part.findMany({ where: { id: { in: [partA, partB] } } });
    expect(parts).toEqual([]);
  });

  it('el ledger de inventario no se puede modificar', async () => {
    const variant = await tenantClient(base, tenantA.id).partVariant.findFirstOrThrow();
    await tenantTx(base, tenantA.id, async (tx) => {
      await tx.stockMovement.create({
        data: {
          tenantId: tenantA.id,
          variantId: variant.id,
          warehouseId: warehouseA,
          delta: 5,
          balanceAfter: 5,
          type: 'COMPRA',
        },
      });
    });
    await expect(
      tenantTx(base, tenantA.id, async (tx) => {
        await tx.stockMovement.updateMany({ data: { balanceAfter: 999 } });
      }),
    ).rejects.toThrow(/inmutable/);
  });

  it('el stock no puede quedar negativo ni con reserva mayor a lo físico', async () => {
    const variant = await tenantClient(base, tenantA.id).partVariant.findFirstOrThrow();
    await expect(
      tenantTx(base, tenantA.id, async (tx) => {
        await tx.inventoryLevel.create({
          data: {
            tenantId: tenantA.id,
            variantId: variant.id,
            warehouseId: warehouseA,
            onHand: 3,
            reserved: 5,
          },
        });
      }),
    ).rejects.toThrow();
  });

  it('los años de una aplicación no pueden estar invertidos', async () => {
    await expect(
      systemTx(base, async (tx) => {
        const brand = await tx.vehicleBrand.upsert({
          where: { name: 'TestBrand' },
          create: { name: 'TestBrand' },
          update: {},
        });
        const model = await tx.vehicleModel.upsert({
          where: { brandId_name: { brandId: brand.id, name: 'TestModel' } },
          create: { brandId: brand.id, name: 'TestModel' },
          update: {},
        });
        await tx.vehicle.create({
          data: { modelId: model.id, yearStart: 2015, yearEnd: 2010 },
        });
      }),
    ).rejects.toThrow();
  });
});
