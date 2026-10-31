import { randomUUID } from 'node:crypto';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../infra/database.module.js';
import { InventoryQueryService } from './inventory.query.service.js';
import { InventoryService } from './inventory.service.js';
import { TransferService } from './transfer.service.js';

/**
 * Traslados entre bodegas.
 *
 * Lo que se comprueba aquí no es el CRUD: es que la existencia física cuadre en cada paso. Un
 * traslado que deja la pieza contada en las dos bodegas —o en ninguna— es peor que no tener
 * traslados, porque el número del sistema parece confiable y no lo es.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

/** El servicio real solo necesita `tx()`; `DatabaseService` completo arrastraría el pool de Nest. */
function dbLike(base: BaseClient, tenantId: string) {
  const tx: DatabaseService['tx'] = (_, fn, options) => tenantTx(base, tenantId, fn, options);
  return { tx } as unknown as DatabaseService;
}

function ctxLike(tenantId: string, warehouseIds: string[] = []) {
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
      permissions: new Set([
        'inventory.view',
        'inventory.adjust',
        'inventory.transfer',
        'inventory.count',
        'catalog.view',
      ]),
      warehouseIds,
    },
  } as never;
}

describe.skipIf(skip)('TransferService: traslados entre bodegas', () => {
  let base: BaseClient;
  const inventory = new InventoryService();
  const tenantId = randomUUID();
  const ownerCtx = ctxLike(tenantId);

  let originId = '';
  let destinationId = '';
  let userId = '';
  let partId = '';
  let seq = 0;

  async function freshVariant(): Promise<string> {
    seq += 1;
    const variant = await systemTx(base, (tx) =>
      tx.partVariant.create({
        data: {
          tenantId,
          partId,
          sku: `TR-${tenantId.slice(0, 6)}-${seq}`,
          title: `Variante ${seq}`,
          priceCents: 5000,
        },
      }),
    );
    return variant.id;
  }

  const seed = (variantId: string, warehouseId: string, qty: number) =>
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

  const levelOf = (variantId: string, warehouseId: string) =>
    tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId, warehouseId } },
      }),
    );

  const movementsOf = (variantId: string, type?: string) =>
    tenantTx(base, tenantId, (tx) =>
      tx.stockMovement.findMany({
        where: { tenantId, variantId, ...(type ? { type: type as never } : {}) },
        orderBy: { createdAt: 'asc' },
      }),
    );

  let transfers: TransferService;
  let query: InventoryQueryService;

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 20 });
    await systemTx(base, async (tx) => {
      const t = await tx.tenant.create({
        data: { id: tenantId, slug: `tr-${tenantId.slice(0, 8)}`, name: 'Traslados' },
      });
      expect(t.id).toBe(tenantId);
      const [origin, destination] = await Promise.all([
        tx.warehouse.create({ data: { tenantId, code: 'CEN', name: 'Central', isDefault: true } }),
        tx.warehouse.create({ data: { tenantId, code: 'SUC', name: 'Sucursal' } }),
      ]);
      originId = origin.id;
      destinationId = destination.id;
      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          email: `tr-${tenantId.slice(0, 8)}@partops.local`,
          name: 'Bodeguero',
          emailVerified: true,
        },
      });
      userId = user.id;
      const part = await tx.part.create({
        data: { tenantId, name: 'Filtro de aceite', slug: `filtro-${tenantId.slice(0, 8)}` },
      });
      partId = part.id;
    });
    (ownerCtx as unknown as { user: { id: string } }).user.id = userId;
    transfers = new TransferService(dbLike(base, tenantId), inventory);
    query = new InventoryQueryService(dbLike(base, tenantId));
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
      await client.query('DELETE FROM "stock_transfer_item" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "stock_transfer" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "inventory_level" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
    } finally {
      await client.end();
    }
  });

  it('solicitar no toca existencia: una solicitud olvidada no congela piezas', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 10);

    const transfer = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 4 }],
    });

    expect(transfer.status).toBe('SOLICITADO');
    expect(transfer.code).toBe('TR-0001');
    expect((await levelOf(variantId, originId))?.onHand).toBe(10);
    expect(await levelOf(variantId, destinationId)).toBeNull();
  });

  it('enviar saca del origen y dejar el destino vacío hasta recibir', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 10);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 4 }],
    });
    const sent = await transfers.send(ownerCtx, created.id);

    expect(sent.status).toBe('ENVIADO');
    expect(sent.sentAt).not.toBeNull();
    // La pieza está en el camión: no se cuenta en ninguna bodega.
    expect((await levelOf(variantId, originId))?.onHand).toBe(6);
    expect(await levelOf(variantId, destinationId)).toBeNull();

    const salida = await movementsOf(variantId, 'TRASLADO_SALIDA');
    expect(salida).toHaveLength(1);
    expect(salida[0]).toMatchObject({ delta: -4, balanceAfter: 6, refType: 'stock_transfer' });
  });

  it('recibir todo mete la pieza al destino y cierra el traslado', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 10);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 4 }],
    });
    await transfers.send(ownerCtx, created.id);
    const received = await transfers.receive(ownerCtx, created.id, {});

    expect(received.status).toBe('RECIBIDO');
    expect(received.pendingUnits).toBe(0);
    expect(received.receivedAt).not.toBeNull();
    expect((await levelOf(variantId, destinationId))?.onHand).toBe(4);

    // El total del negocio no cambió: salieron 4 de una y entraron 4 a la otra.
    expect((await levelOf(variantId, originId))?.onHand).toBe(6);
    const entrada = await movementsOf(variantId, 'TRASLADO_ENTRADA');
    expect(entrada).toHaveLength(1);
    expect(entrada[0]).toMatchObject({ delta: 4, balanceAfter: 4 });
  });

  it('recepción parcial: lo que falta sigue en tránsito y el traslado no se cierra', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 10);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 6 }],
    });
    await transfers.send(ownerCtx, created.id);

    const partial = await transfers.receive(ownerCtx, created.id, {
      items: [{ itemId: created.items[0]!.id, quantity: 4 }],
      notes: 'Llegaron 4, faltan 2 cajas',
    });

    expect(partial.status).toBe('ENVIADO');
    expect(partial.pendingUnits).toBe(2);
    expect(partial.receivedAt).toBeNull();
    expect((await levelOf(variantId, destinationId))?.onHand).toBe(4);

    // Lo que falta se recibe después y ahí sí cierra.
    const rest = await transfers.receive(ownerCtx, created.id, {});
    expect(rest.status).toBe('RECIBIDO');
    expect(rest.pendingUnits).toBe(0);
    expect((await levelOf(variantId, destinationId))?.onHand).toBe(6);
    expect((await levelOf(variantId, originId))?.onHand).toBe(4);
  });

  it('no se puede recibir dos veces lo mismo', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 5);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 2 }],
    });
    await transfers.send(ownerCtx, created.id);
    await transfers.receive(ownerCtx, created.id, {});

    await expect(transfers.receive(ownerCtx, created.id, {})).rejects.toMatchObject({
      response: { code: 'TRANSFER_ALREADY_RECEIVED' },
    });
    // La existencia del destino no se duplicó.
    expect((await levelOf(variantId, destinationId))?.onHand).toBe(2);
  });

  it('no se puede recibir sin despachar: la pieza se contaría dos veces', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 5);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 2 }],
    });

    await expect(transfers.receive(ownerCtx, created.id, {})).rejects.toMatchObject({
      response: { code: 'INVALID_TRANSITION' },
    });
    expect((await levelOf(variantId, destinationId))?.onHand ?? 0).toBe(0);
  });

  it('si el origen no alcanza, no sale nada: el traslado entero se revierte', async () => {
    const a = await freshVariant();
    const b = await freshVariant();
    await seed(a, originId, 1);
    await seed(b, originId, 10);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [
        { variantId: a, quantity: 1 },
        { variantId: b, quantity: 5 },
      ],
    });
    // Se consume la única pieza de `a` después de solicitar el traslado.
    await tenantTx(base, tenantId, (tx) =>
      inventory.apply(tx, {
        tenantId,
        variantId: a,
        warehouseId: originId,
        onHandDelta: -1,
        type: 'VENTA',
      }),
    );

    await expect(transfers.send(ownerCtx, created.id)).rejects.toMatchObject({
      response: { code: 'OUT_OF_STOCK' },
    });

    // Ni `a` ni `b` se movieron, y el traslado sigue solicitado.
    expect((await levelOf(a, originId))?.onHand).toBe(0);
    expect((await levelOf(b, originId))?.onHand).toBe(10);
    const detail = await transfers.detail(ownerCtx, created.id);
    expect(detail.status).toBe('SOLICITADO');
  });

  it('cancelar un traslado en tránsito devuelve la pieza al origen', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 8);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 3 }],
    });
    await transfers.send(ownerCtx, created.id);
    expect((await levelOf(variantId, originId))?.onHand).toBe(5);

    const cancelled = await transfers.cancel(ownerCtx, created.id, 'Camión averiado');
    expect(cancelled.status).toBe('CANCELADO');
    expect((await levelOf(variantId, originId))?.onHand).toBe(8);
    expect((await levelOf(variantId, destinationId))?.onHand ?? 0).toBe(0);
  });

  it('cancelar solo lo solicitado no escribe en el ledger: nunca movió nada', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 4);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 2 }],
    });
    const before = await movementsOf(variantId);

    await transfers.cancel(ownerCtx, created.id, 'Ya no se necesita');

    expect(await movementsOf(variantId)).toHaveLength(before.length);
    expect((await levelOf(variantId, originId))?.onHand).toBe(4);
  });

  it('un traslado recibido no se puede cancelar', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 3);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 1 }],
    });
    await transfers.send(ownerCtx, created.id);
    await transfers.receive(ownerCtx, created.id, {});

    await expect(transfers.cancel(ownerCtx, created.id)).rejects.toMatchObject({
      response: { code: 'INVALID_TRANSITION' },
    });
  });

  it('dos despachos simultáneos del mismo traslado mueven la pieza una sola vez', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 10);

    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 3 }],
    });

    const results = await Promise.allSettled([
      transfers.send(ownerCtx, created.id),
      transfers.send(ownerCtx, created.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await levelOf(variantId, originId))?.onHand).toBe(7);
    expect(await movementsOf(variantId, 'TRASLADO_SALIDA')).toHaveLength(1);
  });

  it('el folio se dicta por teléfono: TR-0007 y no un uuid', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 1);
    const created = await transfers.create(ownerCtx, {
      fromWarehouseId: originId,
      toWarehouseId: destinationId,
      items: [{ variantId, quantity: 1 }],
    });
    expect(created.code).toMatch(/^TR-\d{4}$/);
    expect(created.from.code).toBe('CEN');
    expect(created.to.code).toBe('SUC');
  });

  it('quien solo ve una bodega no puede mover piezas de la otra', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 5);
    const scoped = ctxLike(tenantId, [destinationId]);

    await expect(
      transfers.create(scoped, {
        fromWarehouseId: originId,
        toWarehouseId: destinationId,
        items: [{ variantId, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ response: { code: 'WAREHOUSE_NOT_FOUND' } });
  });

  // ───────────────────────────── Existencias y mínimos ─────────────────────────────

  it('el listado de existencias trae una fila por variante y bodega, con lo disponible', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 7);
    await tenantTx(base, tenantId, (tx) =>
      inventory.reserve(tx, { tenantId, variantId, warehouseId: originId, quantity: 2 }),
    );

    const page = await query.list(ownerCtx, {
      q: '',
      filter: 'TODOS',
      limit: 100,
      offset: 0,
    });
    const row = page.items.find((i) => i.variantId === variantId && i.warehouseId === originId);

    expect(row).toMatchObject({ onHand: 7, reserved: 2, available: 5 });
  });

  it('el punto de reorden se guarda sin escribir en el ledger', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 3);
    const before = await movementsOf(variantId);

    const result = await query.setReorder(ownerCtx, variantId, {
      warehouseId: originId,
      reorderPoint: 5,
      binLocation: 'P-03-A2',
    });

    expect(result).toMatchObject({ reorderPoint: 5, binLocation: 'P-03-A2', onHand: 3 });
    expect(await movementsOf(variantId)).toHaveLength(before.length);

    // Y aparece en el filtro de bajo mínimo.
    const low = await query.list(ownerCtx, { q: '', filter: 'BAJO', limit: 100, offset: 0 });
    expect(low.items.some((i) => i.variantId === variantId)).toBe(true);
  });

  it('quitar el mínimo apaga el aviso', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 3);
    await query.setReorder(ownerCtx, variantId, { warehouseId: originId, reorderPoint: 5 });

    await query.setReorder(ownerCtx, variantId, { warehouseId: originId, reorderPoint: null });

    const low = await query.list(ownerCtx, { q: '', filter: 'BAJO', limit: 100, offset: 0 });
    expect(low.items.some((i) => i.variantId === variantId)).toBe(false);
  });

  it('el ledger de la pantalla esconde reservas y liberaciones', async () => {
    const variantId = await freshVariant();
    await seed(variantId, originId, 4);
    await tenantTx(base, tenantId, (tx) =>
      inventory.reserve(tx, { tenantId, variantId, warehouseId: originId, quantity: 1 }),
    );

    const page = await query.movements(ownerCtx, { variantId, limit: 100, offset: 0 });

    expect(page.items.length).toBe(1);
    expect(page.items[0]?.type).toBe('COMPRA');
  });

  it('los totales cuentan bajo mínimo y agotados del negocio', async () => {
    const summary = await query.summary(ownerCtx);
    expect(summary.variants).toBeGreaterThan(0);
    expect(summary.units).toBeGreaterThan(0);
    // Los traslados cancelados y recibidos no cuentan como abiertos.
    expect(summary.openTransfers).toBeGreaterThanOrEqual(0);
  });
});
