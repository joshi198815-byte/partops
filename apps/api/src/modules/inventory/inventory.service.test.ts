import { randomUUID } from 'node:crypto';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InventoryService } from './inventory.service.js';

/**
 * La prueba que decide si PartOps sirve para vender repuestos.
 *
 * Dos vendedores confirman al mismo tiempo la última pieza del estante. Si los dos terminan
 * vendiendo, la bodega queda con existencia -1 y alguien promete una pieza que no tiene.
 * Con el `UPDATE` condicional, Postgres serializa la fila y exactamente uno gana.
 *
 * Cada caso crea su propia variante: un test no debe depender de lo que dejó el anterior, y aquí
 * es especialmente importante porque una operación rechazada hace rollback de toda su transacción.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

describe.skipIf(skip)('InventoryService: concurrencia y ledger', () => {
  let base: BaseClient;
  const inventory = new InventoryService();
  const tenantId = randomUUID();
  let warehouseId = '';
  let partId = '';
  let seq = 0;

  /** Variante nueva por caso: SKU único, sin existencia ni reservas heredadas. */
  async function freshVariant(): Promise<string> {
    seq += 1;
    const variant = await systemTx(base, (tx) =>
      tx.partVariant.create({
        data: {
          tenantId,
          partId,
          sku: `SKU-${tenantId.slice(0, 6)}-${seq}`,
          title: `Variante ${seq}`,
          priceCents: 10000,
        },
      }),
    );
    return variant.id;
  }

  const stockOf = (variantId: string) =>
    tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId, warehouseId } },
      }),
    );

  const seed = (variantId: string, qty: number) =>
    tenantTx(base, tenantId, (tx) =>
      inventory.apply(tx, {
        tenantId,
        variantId,
        warehouseId,
        onHandDelta: qty,
        type: 'COMPRA',
        reason: 'Carga inicial de prueba',
      }),
    );

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 20 });
    await systemTx(base, async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, slug: `inv-${tenantId.slice(0, 8)}`, name: 'Test' } });
      const wh = await tx.warehouse.create({
        data: { tenantId, code: 'W1', name: 'Bodega', isDefault: true },
      });
      warehouseId = wh.id;
      const part = await tx.part.create({
        data: { tenantId, name: 'Pastillas', slug: `pastillas-${tenantId.slice(0, 8)}` },
      });
      partId = part.id;
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
      // El ledger es append-only: para borrar el negocio de prueba hay que apagar el trigger.
      await client.query('ALTER TABLE "stock_movement" DISABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "stock_movement" WHERE "tenantId" = $1', [tenantId]);
      await client.query('ALTER TABLE "stock_movement" ENABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "inventory_level" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
    } finally {
      await client.end();
    }
  });

  it('entra existencia y el ledger guarda el saldo resultante', async () => {
    const variantId = await freshVariant();
    const result = await seed(variantId, 5);

    expect(result).toEqual({ onHand: 5, reserved: 0, available: 5 });

    const movements = await tenantTx(base, tenantId, (tx) =>
      tx.stockMovement.findMany({ where: { tenantId, variantId } }),
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ delta: 5, balanceAfter: 5, type: 'COMPRA' });
  });

  it('dos ventas simultáneas de la última pieza: gana una sola', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 1);

    const sell = () =>
      tenantTx(base, tenantId, (tx) =>
        inventory.apply(tx, { tenantId, variantId, warehouseId, onHandDelta: -1, type: 'VENTA' }),
      );

    const results = await Promise.allSettled([sell(), sell()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      response: { code: 'OUT_OF_STOCK' },
    });

    expect((await stockOf(variantId))?.onHand).toBe(0);
  });

  it('varias ventas simultáneas nunca dejan existencia negativa', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 3);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        tenantTx(base, tenantId, (tx) =>
          inventory.apply(tx, { tenantId, variantId, warehouseId, onHandDelta: -1, type: 'VENTA' }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await stockOf(variantId))?.onHand).toBe(0);
  });

  it('nunca deja existencia negativa', async () => {
    const variantId = await freshVariant();
    await expect(
      tenantTx(base, tenantId, (tx) =>
        inventory.apply(tx, { tenantId, variantId, warehouseId, onHandDelta: -1, type: 'VENTA' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'OUT_OF_STOCK' } });
  });

  it('la reserva no supera lo físico', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 2);

    await expect(
      tenantTx(base, tenantId, (tx) =>
        inventory.reserve(tx, { tenantId, variantId, warehouseId, quantity: 3 }),
      ),
    ).rejects.toMatchObject({ response: { code: 'OUT_OF_STOCK' } });

    // La reserva rechazada no dejó rastro.
    expect(await stockOf(variantId)).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it('reservar baja lo disponible pero no lo físico', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 4);

    const result = await tenantTx(base, tenantId, (tx) =>
      inventory.reserve(tx, { tenantId, variantId, warehouseId, quantity: 3 }),
    );

    expect(result).toEqual({ onHand: 4, reserved: 3, available: 1 });
  });

  it('despachar consume reserva y existencia a la vez', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 4);
    await tenantTx(base, tenantId, (tx) =>
      inventory.reserve(tx, { tenantId, variantId, warehouseId, quantity: 2 }),
    );

    const result = await tenantTx(base, tenantId, (tx) =>
      inventory.commit(tx, { tenantId, variantId, warehouseId, quantity: 2 }),
    );

    // Sale del estante y deja de estar reservado: lo disponible no se mueve.
    expect(result).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('liberar una reserva devuelve lo disponible sin tocar lo físico', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 4);
    await tenantTx(base, tenantId, (tx) =>
      inventory.reserve(tx, { tenantId, variantId, warehouseId, quantity: 2 }),
    );

    const result = await tenantTx(base, tenantId, (tx) =>
      inventory.release(tx, { tenantId, variantId, warehouseId, quantity: 2 }),
    );

    expect(result).toEqual({ onHand: 4, reserved: 0, available: 4 });
  });

  it('un ajuste sin motivo se rechaza', async () => {
    const variantId = await freshVariant();
    await expect(
      tenantTx(base, tenantId, (tx) =>
        inventory.adjust(tx, { tenantId, variantId, warehouseId, delta: 1, reason: '   ' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'REASON_REQUIRED' } });
  });

  it('un movimiento que no cambia nada se rechaza en vez de ensuciar el ledger', async () => {
    const variantId = await freshVariant();
    await expect(
      tenantTx(base, tenantId, (tx) =>
        inventory.apply(tx, { tenantId, variantId, warehouseId, type: 'AJUSTE' }),
      ),
    ).rejects.toMatchObject({ response: { code: 'NO_CHANGE' } });
  });

  it('el ledger es append-only: no se puede reescribir la historia', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 1);
    await expect(
      tenantTx(base, tenantId, (tx) => tx.stockMovement.updateMany({ data: { balanceAfter: 999 } })),
    ).rejects.toThrow(/inmutable/);
  });
});
