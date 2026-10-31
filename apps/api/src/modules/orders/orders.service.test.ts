import { randomUUID } from 'node:crypto';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../infra/database.module.js';
import type { RealtimeService } from '../../infra/realtime.service.js';
import type { DispatchNotifier } from '../dispatch/dispatch.notifier.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OrdersService } from './orders.service.js';

/**
 * Pedidos.
 *
 * Lo que se prueba no es el CRUD: es que la pieza no se prometa dos veces y que el ledger cuente la
 * verdad. Una reserva perdida deja stock secuestrado que nadie reclama; una reserva de más vende
 * una pieza que no existe y el cliente se entera en el mostrador.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

function dbLike(base: BaseClient, tenantId: string) {
  const tx: DatabaseService['tx'] = (_, fn, options) => tenantTx(base, tenantId, fn, options);
  return { tx } as unknown as DatabaseService;
}

/**
 * Aviso inerte.
 *
 * En pruebas no hay sockets ni llaves VAPID: el aviso es una comodidad y el pedido tiene que
 * crearse igual. Se reemplaza por un doble que no hace nada para no arrastrar el gateway entero.
 */
function notifierLike() {
  return { orderArrived: async () => undefined } as unknown as DispatchNotifier;
}

/** Un emisor inerte: no hay sockets en pruebas y el cambio de línea no depende del aviso. */
function realtimeLike() {
  return { emitUpdate: () => undefined, emitNotice: () => undefined } as unknown as RealtimeService;
}

const ALL_PERMS = new Set([
  'orders.view',
  'orders.create',
  'orders.dispatch',
  'orders.cancel',
  'orders.price.override',
  'inventory.view',
  'inventory.adjust',
  'inventory.transfer',
  'catalog.view',
  'catalog.cost.view',
]);

function ctxLike(tenantId: string, userId: string, permissions = ALL_PERMS) {
  return {
    user: {
      id: userId,
      email: 'test@partops.local',
      name: 'Vendedor',
      emailVerified: true,
      mustChangePassword: false,
    },
    sessionId: 'test',
    tenant: {
      tenantId,
      tenantName: 'Test',
      tenantSlug: `t-${tenantId.slice(0, 6)}`,
      role: 'OWNER',
      permissions,
      warehouseIds: [],
    },
  } as never;
}

describe.skipIf(skip)('OrdersService: pedidos, reservas y despacho', () => {
  let base: BaseClient;
  const inventory = new InventoryService();
  const tenantId = randomUUID();

  let ownerCtx: ReturnType<typeof ctxLike>;
  let orders: OrdersService;
  let warehouseId = '';
  let secondWarehouseId = '';
  let partId = '';
  let userId = '';
  let seq = 0;

  async function freshVariant(priceCents = 25_000, costCents = 15_000) {
    seq += 1;
    const variant = await systemTx(base, (tx) =>
      tx.partVariant.create({
        data: {
          tenantId,
          partId,
          sku: `SKU-${tenantId.slice(0, 6)}-${seq}`,
          title: `Variante ${seq}`,
          priceCents,
          costCents,
        },
      }),
    );
    return variant.id;
  }

  const seed = (variantId: string, warehouse: string, qty: number) =>
    tenantTx(base, tenantId, (tx) =>
      inventory.apply(tx, {
        tenantId,
        variantId,
        warehouseId: warehouse,
        onHandDelta: qty,
        type: 'COMPRA',
        reason: 'Carga inicial de prueba',
      }),
    );

  /**
   * Alta con el canal por omisión.
   *
   * El esquema lo exige en `z.output` —`channel` tiene `default('MOSTRADOR')`, y el tipo de salida
   * lo da por presente—, así que las pruebas lo rellenan aquí en vez de repetirlo veinte veces.
   */
  const create = (input: {
    customerName?: string;
    customerPhone?: string;
    customerId?: string;
    idempotencyKey?: string;
    notes?: string;
    items: Array<{
      variantId: string;
      quantity: number;
      warehouseId?: string;
      unitPriceCents?: number;
      discountCents?: number;
    }>;
  }) =>
    orders.create(ownerCtx, {
      channel: 'MOSTRADOR',
      ...input,
    } as never);

  const levelOf = (variantId: string, warehouse: string) =>
    tenantTx(base, tenantId, (tx) =>
      tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId, warehouseId: warehouse } },
      }),
    );

  const movementsOf = (variantId: string, type?: string) =>
    tenantTx(base, tenantId, (tx) =>
      tx.stockMovement.findMany({
        where: { tenantId, variantId, ...(type ? { type: type as never } : {}) },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 20 });
    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `ord-${tenantId.slice(0, 8)}`, name: 'Ventas de prueba' },
      });
      const [main, second] = await Promise.all([
        tx.warehouse.create({ data: { tenantId, code: 'CEN', name: 'Central', isDefault: true } }),
        tx.warehouse.create({ data: { tenantId, code: 'SUC', name: 'Sucursal' } }),
      ]);
      warehouseId = main.id;
      secondWarehouseId = second.id;
      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          email: `ord-${tenantId.slice(0, 8)}@partops.local`,
          name: 'Vendedor',
          emailVerified: true,
        },
      });
      userId = user.id;
      const part = await tx.part.create({
        data: { tenantId, name: 'Pastillas de freno', slug: `pastillas-${tenantId.slice(0, 8)}` },
      });
      partId = part.id;
    });
    ownerCtx = ctxLike(tenantId, userId);
    orders = new OrdersService(dbLike(base, tenantId), inventory, realtimeLike(), notifierLike());
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
      for (const table of ['payment', 'order_event', 'sales_order_item', 'sales_order', 'customer']) {
        await client.query(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [tenantId]);
      }
      await client.query('DELETE FROM "inventory_level" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part_variant" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "part" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "warehouse" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
    } finally {
      await client.end();
    }
  });

  it('crear reserva la pieza y deja la línea pendiente con vencimiento', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 10);

    const order = await create({
      customerName: 'Juan Pérez',
      customerPhone: '5555-1234',
      items: [{ variantId, quantity: 3 }],
    });

    expect(order.code).toMatch(/^PD-\d{4,}$/);
    expect(order.status).toBe('EN_PREPARACION');
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]?.status).toBe('PENDIENTE');
    expect(order.lines[0]?.reservedUntil).not.toBeNull();
    expect(order.totalCents).toBe(75_000);

    const level = await levelOf(variantId, warehouseId);
    expect(level?.reserved).toBe(3);
    expect((level?.onHand ?? 0) - (level?.reserved ?? 0)).toBe(7);
  });

  it('la venta queda rastreable: el movimiento del ledger apunta al pedido', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 5);

    const order = await create({
      customerName: 'Ana López',
      items: [{ variantId, quantity: 2 }],
    });
    const itemId = order.lines[0]?.id ?? '';
    await orders.setLineStatus(ownerCtx, order.id, itemId, 'EN_PREPARACION');
    await orders.setLineStatus(ownerCtx, order.id, itemId, 'LISTO');
    await orders.setLineStatus(ownerCtx, order.id, itemId, 'ENTREGADO');

    /**
     * El ledger es inmutable: si el movimiento no dijera de qué pedido salió, un descuadre de
     * existencia no se podría explicar y la auditoría no serviría de nada.
     */
    const ventas = await movementsOf(variantId, 'VENTA');
    expect(ventas).toHaveLength(1);
    expect(ventas[0]?.refType).toBe('sales_order');
    expect(ventas[0]?.refId).toBe(order.id);
    expect((await levelOf(variantId, warehouseId))?.reserved).toBe(0);
  });

  it('sin existencia la línea nace SIN_STOCK y las demás sí se reservan', async () => {
    const withStock = await freshVariant();
    const withoutStock = await freshVariant();
    await seed(withStock, warehouseId, 4);

    const order = await create({
      customerName: 'Cliente mixto',
      items: [
        { variantId: withStock, quantity: 2 },
        { variantId: withoutStock, quantity: 1 },
      ],
    });

    const byVariant = new Map(order.lines.map((l) => [l.variantId, l]));
    expect(byVariant.get(withStock)?.status).toBe('PENDIENTE');
    expect(byVariant.get(withoutStock)?.status).toBe('SIN_STOCK');
    // Hay trabajo en bodega por la línea que sí se puede preparar.
    expect(order.status).toBe('EN_PREPARACION');
    expect((await levelOf(withStock, warehouseId))?.reserved).toBe(2);
  });

  it('sin ninguna existencia el pedido nace abierto: falta comprar', async () => {
    const variantId = await freshVariant();
    const order = await create({
      customerName: 'Sin stock',
      items: [{ variantId, quantity: 1 }],
    });
    expect(order.status).toBe('ABIERTO');
    expect(order.lines[0]?.status).toBe('SIN_STOCK');
  });

  it('la bodega con más disponible se elige sola cuando no se indica', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 1);
    await seed(variantId, secondWarehouseId, 9);

    const order = await create({
      customerName: 'Surtido automático',
      items: [{ variantId, quantity: 5 }],
    });

    expect(order.lines[0]?.warehouseId).toBe(secondWarehouseId);
    expect((await levelOf(variantId, secondWarehouseId))?.reserved).toBe(5);
  });

  it('dos ventas de la última pieza: una reserva, la otra nace sin stock', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 1);

    const first = await create({
      customerName: 'Primero',
      items: [{ variantId, quantity: 1, warehouseId }],
    });
    const second = await create({
      customerName: 'Segundo',
      items: [{ variantId, quantity: 1, warehouseId }],
    });

    expect(first.lines[0]?.status).toBe('PENDIENTE');
    expect(second.lines[0]?.status).toBe('SIN_STOCK');
    expect((await levelOf(variantId, warehouseId))?.reserved).toBe(1);
  });

  it('preparar no mueve existencia; entregar la saca y consume la reserva', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 6);

    const order = await create({
      customerName: 'Despacho',
      items: [{ variantId, quantity: 2, warehouseId }],
    });
    const itemId = order.lines[0]?.id ?? '';

    const preparing = await orders.setLineStatus(ownerCtx, order.id, itemId, 'EN_PREPARACION');
    expect(preparing.lines[0]?.status).toBe('EN_PREPARACION');
    expect((await levelOf(variantId, warehouseId))?.onHand).toBe(6);

    const ready = await orders.setLineStatus(ownerCtx, order.id, itemId, 'LISTO');
    expect(ready.status).toBe('LISTO');
    expect((await levelOf(variantId, warehouseId))?.onHand).toBe(6);

    const delivered = await orders.setLineStatus(ownerCtx, order.id, itemId, 'ENTREGADO');
    expect(delivered.status).toBe('ENTREGADO');
    expect(delivered.lines[0]?.status).toBe('ENTREGADO');

    const level = await levelOf(variantId, warehouseId);
    expect(level?.onHand).toBe(4);
    // La reserva se consumió con la venta: si quedara, la pieza seguiría "apartada" para siempre.
    expect(level?.reserved).toBe(0);

    const ventas = await movementsOf(variantId, 'VENTA');
    expect(ventas).toHaveLength(1);
    expect(ventas[0]).toMatchObject({ delta: -2, balanceAfter: 4, refType: 'sales_order' });
  });

  it('dos bodegas en un pedido: cada línea cierra por su lado y la cabecera es parcial', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 3);
    await seed(variantId, secondWarehouseId, 3);

    const order = await create({
      customerName: 'Dos sucursales',
      items: [
        { variantId, quantity: 1, warehouseId },
        { variantId, quantity: 1, warehouseId: secondWarehouseId },
      ],
    });
    // Dos líneas de la misma variante en bodegas distintas son dos líneas, no una.
    expect(order.lines).toHaveLength(2);

    const [a, b] = order.lines;
    await orders.setLineStatus(ownerCtx, order.id, a?.id ?? '', 'EN_PREPARACION');
    await orders.setLineStatus(ownerCtx, order.id, a?.id ?? '', 'LISTO');
    const partial = await orders.setLineStatus(ownerCtx, order.id, a?.id ?? '', 'ENTREGADO');
    // La otra bodega todavía tiene trabajo: la cabecera sigue en preparación, no "parcial".
    // PARCIAL es para cuando ya no queda nada que preparar pero una parte no se entregó.
    expect(partial.status).toBe('EN_PREPARACION');
    expect((await levelOf(variantId, warehouseId))?.onHand).toBe(2);
    // La otra bodega sigue intacta: falta que la prepare el otro bodeguero.
    expect((await levelOf(variantId, secondWarehouseId))?.onHand).toBe(3);
    expect(b?.status).toBe('PENDIENTE');

    const resuelto = await orders.setLineStatus(ownerCtx, order.id, b?.id ?? '', 'SIN_STOCK');
    expect(resuelto.status).toBe('PARCIAL');
    expect((await levelOf(variantId, secondWarehouseId))?.reserved).toBe(0);
  });

  it('cancelar libera todo lo reservado y no toca lo entregado', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 5);

    const order = await create({
      customerName: 'Cancelación',
      items: [{ variantId, quantity: 2 }],
    });
    expect((await levelOf(variantId, warehouseId))?.reserved).toBe(2);

    const cancelled = await orders.cancel(ownerCtx, order.id, 'No llegó el cliente');
    expect(cancelled.status).toBe('CANCELADO');
    expect(cancelled.lines[0]?.status).toBe('CANCELADO');

    const level = await levelOf(variantId, warehouseId);
    expect(level?.reserved).toBe(0);
    expect(level?.onHand).toBe(5);
  });

  it('cancelar un pedido entregado se rechaza: eso es una devolución', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 2);

    const order = await create({
      customerName: 'Ya salió',
      items: [{ variantId, quantity: 1, warehouseId }],
    });
    const itemId = order.lines[0]?.id ?? '';
    await orders.setLineStatus(ownerCtx, order.id, itemId, 'EN_PREPARACION');
    await orders.setLineStatus(ownerCtx, order.id, itemId, 'LISTO');
    await orders.setLineStatus(ownerCtx, order.id, itemId, 'ENTREGADO');

    await expect(orders.cancel(ownerCtx, order.id)).rejects.toMatchObject({ status: 409 });
  });

  it('la idempotencia devuelve el mismo pedido y no reserva dos veces', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 10);
    const key = `retry-${tenantId.slice(0, 8)}`;

    const first = await create({
      customerName: 'Reintento',
      idempotencyKey: key,
      items: [{ variantId, quantity: 2 }],
    });
    const second = await create({
      customerName: 'Reintento',
      idempotencyKey: key,
      items: [{ variantId, quantity: 2 }],
    });

    expect(second.id).toBe(first.id);
    expect(second.number).toBe(first.number);
    expect((await levelOf(variantId, warehouseId))?.reserved).toBe(2);
  });

  it('dos pedidos distintos con la misma clave no se pisan… porque la clave es una sola', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 10);
    const key = `dup-${tenantId.slice(0, 8)}`;

    await create({
      customerName: 'Uno',
      idempotencyKey: key,
      items: [{ variantId, quantity: 1 }],
    });
    const again = await create({
      customerName: 'Otro nombre',
      idempotencyKey: key,
      items: [{ variantId, quantity: 3 }],
    });

    // Gana el primero: la clave es del intento, no del contenido.
    expect(again.customerName).toBe('Uno');
    expect(again.lines[0]?.quantity).toBe(1);
  });

  it('el folio avanza con la secuencia del negocio sin huecos por reintento', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 4);
    const key = `seq-${tenantId.slice(0, 8)}`;

    const first = await create({
      customerName: 'Secuencia',
      idempotencyKey: key,
      items: [{ variantId, quantity: 1 }],
    });
    const retry = await create({
      customerName: 'Secuencia',
      idempotencyKey: key,
      items: [{ variantId, quantity: 1 }],
    });

    // El reintento no consume folio: es el mismo pedido.
    expect(retry.number).toBe(first.number);
  });

  it('no se puede cobrar más que el total', async () => {
    const variantId = await freshVariant(10_000);
    await seed(variantId, warehouseId, 2);

    const order = await create({
      customerName: 'Cobro',
      items: [{ variantId, quantity: 1 }],
    });

    await expect(
      orders.addPayment(ownerCtx, order.id, { method: 'EFECTIVO', amountCents: 20_000 }),
    ).rejects.toMatchObject({ status: 400 });

    const paid = await orders.addPayment(ownerCtx, order.id, {
      method: 'EFECTIVO',
      amountCents: 10_000,
      receivedCents: 15_000,
    });
    expect(paid.paidCents).toBe(10_000);
    expect(paid.balanceCents).toBe(0);
    expect(paid.payments[0]?.changeCents).toBe(5_000);
    // Cobrar no entrega: el pedido sigue esperando en bodega.
    expect(paid.lines[0]?.status).toBe('PENDIENTE');
  });

  it('volver a pendiente desde sin stock reserva si ya llegó la pieza', async () => {
    const variantId = await freshVariant();
    const order = await create({
      customerName: 'Llegó la pieza',
      items: [{ variantId, quantity: 2, warehouseId }],
    });
    expect(order.lines[0]?.status).toBe('SIN_STOCK');
    const itemId = order.lines[0]?.id ?? '';

    // Todavía no llegó: el sistema se niega en vez de prometer.
    await expect(orders.setLineStatus(ownerCtx, order.id, itemId, 'PENDIENTE')).rejects.toMatchObject({
      status: 409,
    });

    await seed(variantId, warehouseId, 2);
    const fixed = await orders.setLineStatus(ownerCtx, order.id, itemId, 'PENDIENTE');
    expect(fixed.lines[0]?.status).toBe('PENDIENTE');
    expect((await levelOf(variantId, warehouseId))?.reserved).toBe(2);
  });

  it('el vencimiento de reservas libera la pieza y deja la línea sin stock', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 3);

    const order = await create({
      customerName: 'Reserva vencida',
      items: [{ variantId, quantity: 2 }],
    });
    expect((await levelOf(variantId, warehouseId))?.reserved).toBe(2);

    // Se adelanta el reloj de esa reserva: es el paso del tiempo, no una excepción.
    await tenantTx(base, tenantId, (tx) =>
      tx.salesOrderItem.updateMany({
        where: { orderId: order.id },
        data: { reservedUntil: new Date(Date.now() - 60_000) },
      }),
    );

    const result = await orders.expireReservations(ownerCtx);
    expect(result.released).toBe(1);
    expect((await levelOf(variantId, warehouseId))?.reserved).toBe(0);

    const after = await orders.detail(ownerCtx, order.id);
    expect(after.lines[0]?.status).toBe('SIN_STOCK');
    expect(after.status).toBe('ABIERTO');
  });

  it('cancelar la línea libera solo esa: el pedido sigue vivo con la otra', async () => {
    const a = await freshVariant();
    const b = await freshVariant();
    await seed(a, warehouseId, 2);
    await seed(b, warehouseId, 2);

    const order = await create({
      customerName: 'Cancelación parcial',
      items: [
        { variantId: a, quantity: 1 },
        { variantId: b, quantity: 1 },
      ],
    });
    const lineA = order.lines.find((l) => l.variantId === a);
    const cancelled = await orders.setLineStatus(ownerCtx, order.id, lineA?.id ?? '', 'CANCELADO');

    expect(cancelled.status).toBe('EN_PREPARACION');
    expect((await levelOf(a, warehouseId))?.reserved).toBe(0);
    expect((await levelOf(b, warehouseId))?.reserved).toBe(1);
  });

  it('un pedido cancelado no acepta cobros', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 2);
    const order = await create({
      customerName: 'Cancelado',
      items: [{ variantId, quantity: 1 }],
    });
    await orders.cancel(ownerCtx, order.id);
    await expect(
      orders.addPayment(ownerCtx, order.id, { method: 'EFECTIVO', amountCents: 100 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('el historial del pedido guarda cada paso con su actor', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 2);
    const order = await create({
      customerName: 'Historial',
      items: [{ variantId, quantity: 1 }],
    });
    await orders.setLineStatus(ownerCtx, order.id, order.lines[0]?.id ?? '', 'EN_PREPARACION');
    const detail = await orders.detail(ownerCtx, order.id);

    const types = detail.events.map((e) => e.type);
    expect(types).toContain('CREADO');
    expect(types).toContain('LINEA');
    expect(detail.events.every((e) => e.actorName === 'Vendedor')).toBe(true);
  });

  it('el cliente se reutiliza por teléfono y no se duplica por venta', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 4);
    const phone = `7777-${tenantId.slice(0, 4)}`;

    const first = await create({
      customerName: 'Doña Marta',
      customerPhone: phone,
      items: [{ variantId, quantity: 1 }],
    });
    const second = await create({
      customerName: 'Doña Marta',
      customerPhone: phone,
      items: [{ variantId, quantity: 1 }],
    });

    expect(first.customer?.id).toBeTruthy();
    expect(second.customer?.id).toBe(first.customer?.id);
  });

  it('el teléfono queda en E.164 para que WhatsApp lo abra sin traducir nada', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 2);
    const order = await create({
      customerName: 'Mecánica Central',
      customerPhone: '+502 5555 8899',
      items: [{ variantId, quantity: 1 }],
    });

    // "wa.me" solo acepta dígitos: un número con guiones no produce botón y nadie sabe por qué.
    expect(order.customerPhone).toBe('+50255558899');
    const again = await create({
      customerName: 'Mecánica Central',
      customerPhone: '5555-8899',
      items: [{ variantId, quantity: 1 }],
    });
    expect(again.customer?.id).toBe(order.customer?.id);
  });

  it('el costo congelado no se mueve cuando cambia el costo del proveedor', async () => {
    const variantId = await freshVariant(30_000, 20_000);
    await seed(variantId, warehouseId, 2);

    const order = await create({
      customerName: 'Costo frío',
      items: [{ variantId, quantity: 1 }],
    });
    expect(order.lines[0]?.unitCostCents).toBe(20_000);

    await systemTx(base, (tx) =>
      tx.partVariant.update({ where: { id: variantId }, data: { costCents: 99_000 } }),
    );

    const after = await orders.detail(ownerCtx, order.id);
    expect(after.lines[0]?.unitCostCents).toBe(20_000);
  });

  it('sin permiso de costo la línea lo trae en null, no oculto en la pantalla', async () => {
    const variantId = await freshVariant(30_000, 20_000);
    await seed(variantId, warehouseId, 2);
    const order = await create({
      customerName: 'Sin costo',
      items: [{ variantId, quantity: 1 }],
    });

    const perms = new Set([...ALL_PERMS].filter((p) => p !== 'catalog.cost.view'));
    const sellerCtx = ctxLike(tenantId, userId, perms as typeof ALL_PERMS);
    const detail = await orders.detail(sellerCtx, order.id);
    expect(detail.lines[0]?.unitCostCents).toBeNull();
  });

  it('cambiar el precio sin permiso se rechaza aunque el formulario lo mande', async () => {
    const variantId = await freshVariant(25_000);
    await seed(variantId, warehouseId, 2);
    const perms = new Set([...ALL_PERMS].filter((p) => p !== 'orders.price.override'));
    const sellerCtx = ctxLike(tenantId, userId, perms as typeof ALL_PERMS);

    await expect(
      orders.create(sellerCtx, {
        channel: 'MOSTRADOR',
        customerName: 'Regateo',
        items: [{ variantId, quantity: 1, unitPriceCents: 1_000 }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('con permiso el precio rebajado se respeta y es el que se cobra', async () => {
    const variantId = await freshVariant(25_000);
    await seed(variantId, warehouseId, 2);
    const order = await create({
      customerName: 'Descuento',
      items: [{ variantId, quantity: 2, unitPriceCents: 20_000, discountCents: 1_000 }],
    });
    expect(order.totalCents).toBe(39_000);
    expect(order.discountCents).toBe(1_000);
    expect(order.subtotalCents + order.taxCents).toBe(order.totalCents);
  });

  it('una pieza archivada no se vende', async () => {
    const variantId = await freshVariant();
    await seed(variantId, warehouseId, 2);
    await systemTx(base, (tx) => tx.part.update({ where: { id: partId }, data: { status: 'ARCHIVADO' } }));
    await expect(
      create({
        customerName: 'Archivada',
        items: [{ variantId, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await systemTx(base, (tx) => tx.part.update({ where: { id: partId }, data: { status: 'ACTIVO' } }));
  });
});
