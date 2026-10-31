import { randomUUID } from 'node:crypto';
import type { DispatchOp } from '@partops/contracts';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../infra/database.module.js';
import type { PushService } from '../../infra/push.service.js';
import type { RealtimeService } from '../../infra/realtime.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { DispatchNotifier } from './dispatch.notifier.js';
import { DispatchService } from './dispatch.service.js';

/**
 * Despacho.
 *
 * Lo que se prueba aquí no es que la pantalla liste pedidos: es que la pieza que sale del estante
 * sea la que el pedido pide. Cuatro fallas concretas, cada una con su prueba:
 *
 *  1. Escanear el código de otra pieza marca la línea → el cliente se lleva la vecina.
 *  2. Repetir una operación encolada mueve el inventario dos veces → el estante miente.
 *  3. Un lote con dos estados de la misma línea aplica los dos → gana el último por azar del orden.
 *  4. La cola ignora pasillo y antigüedad → el bodeguero da diez vueltas y el cliente espera.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

function dbLike(base: BaseClient, tenantId: string) {
  const tx: DatabaseService['tx'] = (_, fn, options) => tenantTx(base, tenantId, fn, options);
  const system: DatabaseService['system'] = (fn, options) => systemTx(base, fn, options);
  return { tx, system } as unknown as DatabaseService;
}

/** Sin sockets ni llaves VAPID en pruebas: el aviso es comodidad, la pieza ya salió. */
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

const PERMS = new Set([
  'orders.view',
  'orders.create',
  'orders.dispatch',
  'orders.cancel',
  'inventory.view',
  'inventory.adjust',
]);

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
      permissions: PERMS,
      warehouseIds: [] as string[],
    },
  } as never;
}

describe.skipIf(skip)('DispatchService: escaneo, cola offline y orden de la caminata', () => {
  let base: BaseClient;
  const inventory = new InventoryService();
  const tenantId = randomUUID();

  let ctx: ReturnType<typeof ctxLike>;
  let orders: OrdersService;
  let dispatch: DispatchService;
  let warehouseId = '';
  let userId = '';
  let partId = '';
  let seq = 0;

  async function freshVariant() {
    seq += 1;
    const variant = await systemTx(base, (tx) =>
      tx.partVariant.create({
        data: {
          tenantId,
          partId,
          sku: `DSP-${tenantId.slice(0, 6)}-${seq}`,
          barcode: `75099${String(seq).padStart(8, '0')}`,
          partNumber: `PN-${seq}`,
          oemNumbers: [`OEM-${seq}`],
          title: `Variante ${seq}`,
          priceCents: 20_000,
          costCents: 12_000,
        },
      }),
    );
    return variant.id;
  }

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

  /** Deja la ubicación de una pieza en el pasillo pedido. */
  const locate = (variantId: string, binLocation: string) =>
    tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.update({
        where: { variantId_warehouseId: { variantId, warehouseId } },
        data: { binLocation },
      }),
    );

  const newOrder = (items: Array<{ variantId: string; quantity: number }>) =>
    orders.create(ctx, {
      channel: 'MOSTRADOR',
      customerName: 'Taller La Esquina',
      items,
    } as never);

  const queue = () => dispatch.queue(ctx as never, { q: '', onlyActionable: true });

  const op = (over: Partial<DispatchOp>): DispatchOp => ({
    opId: randomUUID(),
    orderId: '',
    itemId: '',
    status: 'LISTO',
    ...over,
  });

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 20 });

    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `dsp-${tenantId.slice(0, 8)}`, name: 'Bodega de prueba' },
      });
      const warehouse = await tx.warehouse.create({
        data: { tenantId, code: 'CEN', name: 'Central', isDefault: true },
      });
      warehouseId = warehouse.id;

      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          email: `dsp-${tenantId.slice(0, 8)}@partops.local`,
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

    ctx = ctxLike(tenantId, userId);
    const db = dbLike(base, tenantId);
    const realtime = realtimeLike();
    const push = pushLike();
    orders = new OrdersService(db, inventory, realtime, new DispatchNotifier(realtime, push));
    dispatch = new DispatchService(db, orders, realtime, push);
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
      await client.query('DELETE FROM "inventory_level" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
    } finally {
      await client.end();
    }
  });

  it('la cola trae las piezas por preparar, con pasillo y folio', async () => {
    const first = await freshVariant();
    await seed(first, 4);
    await locate(first, 'B-3');
    const order = await newOrder([{ variantId: first, quantity: 2 }]);

    const result = await queue();
    const row = result.orders.find((o) => o.orderId === order.id);
    expect(row).toBeDefined();
    expect(row?.code).toBe(order.code);
    expect(row?.pendingUnits).toBe(2);
    expect(row?.lines[0]?.binLocation).toBe('B-3');
    expect(row?.lines[0]?.quantity).toBe(2);
  });

  it('escanear el código de otra pieza no mueve la línea', async () => {
    const target = await freshVariant();
    const targetSeq = seq;
    const other = await freshVariant();
    const otherSeq = seq;
    await seed(target, 3);
    await seed(other, 3);
    const order = await newOrder([{ variantId: target, quantity: 1 }]);
    const itemId = order.lines[0]?.id as string;

    // El código de la pieza vecina, que se ve idéntica en el estante.
    expect(otherSeq).toBe(targetSeq + 1);
    const wrong = await dispatch.scan(ctx as never, order.id, itemId, `OEM-${otherSeq}`, 'LISTO');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.verdict).toBe('NO_COINCIDE');
      expect(wrong.expectedSku).toContain(String(targetSeq));
    }

    // La línea sigue pendiente: el rechazo no la movió ni un estado.
    const after = await orders.detail(ctx as never, order.id);
    expect(after.lines[0]?.status).toBe('PENDIENTE');
  });

  it('el código correcto marca listo, y acepta cualquier código impreso de la pieza', async () => {
    const variant = await freshVariant();
    await seed(variant, 3);
    const order = await newOrder([{ variantId: variant, quantity: 1 }]);
    const itemId = order.lines[0]?.id as string;

    const barcodeOk = await dispatch.scan(
      ctx as never,
      order.id,
      itemId,
      `75099${String(seq).padStart(8, '0')}`,
      'LISTO',
    );
    expect(barcodeOk.ok).toBe(true);

    const detail = await orders.detail(ctx as never, order.id);
    expect(detail.lines[0]?.status).toBe('LISTO');
    expect(detail.lines[0]?.preparedAt).not.toBeNull();
  });

  it('entregar dos veces con la misma operación descuenta una sola vez', async () => {
    const variant = await freshVariant();
    await seed(variant, 10);
    const order = await newOrder([{ variantId: variant, quantity: 2 }]);
    const itemId = order.lines[0]?.id as string;

    // Preparar primero: la entrega exige pasar por LISTO.
    await dispatch.scan(ctx as never, order.id, itemId, `OEM-${seq}`, 'LISTO');

    const deliver = op({ orderId: order.id, itemId, status: 'ENTREGADO' });
    const first = await dispatch.sync(ctx as never, { ops: [deliver] });
    expect(first.results[0]?.outcome).toBe('APLICADO');
    expect(first.results[0]?.status).toBe('ENTREGADO');

    const second = await dispatch.sync(ctx as never, { ops: [deliver] });
    expect(second.results[0]?.outcome).toBe('REPETIDO');

    const level = await tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId: variant, warehouseId } },
      }),
    );
    // 10 cargadas, 2 vendidas: quedan 8. El reintento no restó otras dos.
    expect(level?.onHand).toBe(8);
    expect(level?.reserved).toBe(0);
  });

  it('un lote sin señal aplica el último estado de cada línea', async () => {
    const variant = await freshVariant();
    await seed(variant, 5);
    const order = await newOrder([{ variantId: variant, quantity: 1 }]);
    const itemId = order.lines[0]?.id as string;

    const result = await dispatch.sync(ctx as never, {
      ops: [
        op({ orderId: order.id, itemId, status: 'EN_PREPARACION' }),
        op({ orderId: order.id, itemId, status: 'SIN_STOCK' }),
      ],
    });

    // Compactado: solo llega la última, y la línea queda sin stock, no "en preparación".
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe('SIN_STOCK');

    const detail = await orders.detail(ctx as never, order.id);
    expect(detail.lines[0]?.status).toBe('SIN_STOCK');
  });

  it('un lote con una operación imposible guarda las demás', async () => {
    const good = await freshVariant();
    const cancelled = await freshVariant();
    await seed(good, 5);
    await seed(cancelled, 5);
    const order = await newOrder([
      { variantId: good, quantity: 1 },
      { variantId: cancelled, quantity: 1 },
    ]);
    const goodItem = order.lines.find((l) => l.variantId === good)?.id as string;
    const cancelledItem = order.lines.find((l) => l.variantId === cancelled)?.id as string;

    // Una línea se cancela desde el mostrador mientras el teléfono estaba sin señal.
    await orders.setLineStatus(ctx as never, order.id, cancelledItem, 'CANCELADO');

    const result = await dispatch.sync(ctx as never, {
      ops: [
        op({ orderId: order.id, itemId: goodItem, status: 'LISTO' }),
        op({ orderId: order.id, itemId: cancelledItem, status: 'LISTO' }),
      ],
    });

    const goodResult = result.results.find((r) => r.itemId === goodItem);
    const badResult = result.results.find((r) => r.itemId === cancelledItem);
    expect(goodResult?.outcome).toBe('APLICADO');
    expect(badResult?.outcome).toBe('RECHAZADO');

    const detail = await orders.detail(ctx as never, order.id);
    expect(detail.lines.find((l) => l.id === goodItem)?.status).toBe('LISTO');
  });

  it('el reintento de un rechazo no se queda dando vueltas en la cola', async () => {
    const variant = await freshVariant();
    await seed(variant, 5);
    const order = await newOrder([{ variantId: variant, quantity: 1 }]);
    const itemId = order.lines[0]?.id as string;

    // Entregar sin preparar es una transición ilegal: se rechaza y se registra.
    const rejected = op({ orderId: order.id, itemId, status: 'ENTREGADO' });
    const first = await dispatch.sync(ctx as never, { ops: [rejected] });
    expect(first.results[0]?.outcome).toBe('RECHAZADO');

    const stored = await tenantTx(base, tenantId, (tx) =>
      tx.dispatchOp.findUnique({ where: { tenantId_opId: { tenantId, opId: rejected.opId } } }),
    );
    expect(stored?.outcome).toBe('RECHAZADO');
  });

  it('la cola ordena por pasillo y pone lo urgente arriba', async () => {
    const far = await freshVariant();
    const near = await freshVariant();
    await seed(far, 5);
    await seed(near, 5);
    await locate(far, 'C-1');
    await locate(near, 'A-1');

    const order = await newOrder([
      { variantId: far, quantity: 1 },
      { variantId: near, quantity: 1 },
    ]);

    const result = await queue();
    const row = result.orders.find((o) => o.orderId === order.id);
    expect(row?.lines.map((l) => l.binLocation)).toEqual(['A-1', 'C-1']);

    // Un pedido viejo con trabajo pendiente va arriba de uno recién creado.
    await systemTx(base, (tx) =>
      tx.salesOrder.update({
        where: { id: order.id },
        data: { createdAt: new Date(Date.now() - 45 * 60_000) },
      }),
    );
    const withOld = await queue();
    expect(withOld.orders[0]?.orderId).toBe(order.id);
    expect(withOld.orders[0]?.priority).toBe(true);
  });
});
