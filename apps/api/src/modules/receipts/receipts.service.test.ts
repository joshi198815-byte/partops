import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { PDFDocument } from 'pdf-lib';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../infra/database.module.js';
import type { RealtimeService } from '../../infra/realtime.service.js';
import { StorageService } from '../../infra/storage.service.js';
import type { DispatchNotifier } from '../dispatch/dispatch.notifier.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { renderReceiptPdf } from './pdf.js';
import { ReceiptsService } from './receipts.service.js';

/**
 * Recibos.
 *
 * Lo que se prueba aquí no es que el PDF se abra: es que el recibo sea **inmutable y verdadero**.
 * Tres cosas rompen un recibo sin que nadie lo note:
 *
 *  1. Que los totales no cuadren con el pedido al centavo — el cliente paga Q2,100 y el papel dice
 *     Q2,099.99.
 *  2. Que regenerar cambie el archivo — y con él el folio o el contenido que el cliente ya recibió.
 *  3. Que el PDF lleve el costo interno o datos de otro negocio — el margen de la bodega en manos
 *     del cliente, o una venta de la competencia.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

function dbLike(base: BaseClient, tenantId: string) {
  const tx: DatabaseService['tx'] = (_, fn, options) => tenantTx(base, tenantId, fn, options);
  // Igual que `DatabaseService.system`: `publicView` busca por token sin sesión y necesita el
  // bypass, si no RLS devuelve cero filas y todo recibo parecería inexistente.
  const system: DatabaseService['system'] = (fn, options) => systemTx(base, fn, options);
  return { tx, system } as unknown as DatabaseService;
}

/** Sin sockets ni push en pruebas: el aviso es comodidad, la venta tiene que cerrar igual. */
function notifierLike() {
  return { orderArrived: async () => undefined } as unknown as DispatchNotifier;
}

/** Un emisor inerte: no hay sockets en pruebas y el cambio de línea no depende del aviso. */
function realtimeLike() {
  return { emitUpdate: () => undefined, emitNotice: () => undefined } as unknown as RealtimeService;
}

const PERMS = new Set([
  'orders.view',
  'orders.create',
  'orders.dispatch',
  'orders.cancel',
  'orders.receipt.resend',
  'catalog.cost.view',
  'inventory.view',
  'inventory.adjust',
]);

function ctxLike(tenantId: string, userId: string) {
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
      permissions: PERMS,
      warehouseIds: [],
    },
  } as never;
}

describe.skipIf(skip)('ReceiptsService: recibo inmutable y público', () => {
  let base: BaseClient;
  const inventory = new InventoryService();
  const tenantId = randomUUID();
  let storageDir = '';

  let ownerCtx: ReturnType<typeof ctxLike>;
  let orders: OrdersService;
  let receipts: ReceiptsService;
  let warehouseId = '';
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
          sku: `RCP-${tenantId.slice(0, 6)}-${seq}`,
          title: `Variante ${seq}`,
          oemNumbers: [`OEM-${seq}`, 'OEM-ALT'],
          priceCents,
          costCents,
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
        reason: 'Carga de prueba',
      }),
    );

  async function sell(items: Array<{ variantId: string; quantity: number }>, phone?: string) {
    return orders.create(ownerCtx, {
      channel: 'MOSTRADOR',
      customerName: 'Taller El Tornillo',
      customerPhone: phone,
      items,
    } as never);
  }

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'partops-receipts-'));
    process.env.STORAGE_DIR = storageDir;

    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 20 });
    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `rcp-${tenantId.slice(0, 8)}`,
          name: 'Bodega El Tornillo',
          legalName: 'Repuestos El Tornillo, S.A.',
          taxId: '1234567-8',
          address: '4a calle 12-34, Zona 1, Guatemala',
          phone: '+50222223333',
          brandPrimary: '#16324F',
          brandAccent: '#B4703A',
        },
      });
      const warehouse = await tx.warehouse.create({
        data: { tenantId, code: 'CEN', name: 'Central', isDefault: true },
      });
      warehouseId = warehouse.id;
      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          email: `rcp-${tenantId.slice(0, 8)}@partops.local`,
          name: 'Ana Prueba',
          emailVerified: true,
        },
      });
      userId = user.id;
      const part = await tx.part.create({
        data: { tenantId, name: 'Bomba de gasolina', slug: `bomba-${tenantId.slice(0, 8)}` },
      });
      partId = part.id;
    });

    ownerCtx = ctxLike(tenantId, userId);
    const db = dbLike(base, tenantId);
    orders = new OrdersService(db, inventory, realtimeLike(), notifierLike());
    receipts = new ReceiptsService(db, new StorageService());
  });

  afterAll(async () => {
    if (!base) return;
    await base.$disconnect();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    const owner = process.env.DIRECT_DATABASE_URL;
    if (!owner) return;
    const client = new Client({ connectionString: owner });
    await client.connect();
    try {
      await client.query('ALTER TABLE "stock_movement" DISABLE TRIGGER stock_movement_no_delete');
      await client.query('DELETE FROM "stock_movement" WHERE "tenantId" = $1', [tenantId]);
      await client.query('ALTER TABLE "stock_movement" ENABLE TRIGGER stock_movement_no_delete');
      for (const table of [
        'receipt',
        'payment',
        'order_event',
        'sales_order_item',
        'sales_order',
        'customer',
      ]) {
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

  it('el recibo cuadra con el pedido al centavo', async () => {
    const variantId = await freshVariant(34_000);
    await seed(variantId, 5);
    const order = await sell([{ variantId, quantity: 2 }]);

    const receipt = await receipts.issue(ownerCtx, order.id);
    expect(receipt.folio).toMatch(/^R-\d{4,}$/);

    const view = await receipts.publicView(receipt.token);
    expect(view.snapshot.totals.totalCents).toBe(order.totalCents);
    expect(view.snapshot.totals.subtotalCents).toBe(order.subtotalCents);
    expect(view.snapshot.totals.taxCents).toBe(order.taxCents);
    // Base + IVA tiene que dar el total exacto: aquí es donde aparecen los centavos sueltos.
    expect(view.snapshot.totals.subtotalCents + view.snapshot.totals.taxCents).toBe(
      view.snapshot.totals.totalCents,
    );
    expect(view.totalCents).toBe(order.totalCents);
  });

  it('el snapshot conserva OEM y vehículo para que el mecánico repita la compra', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 3);
    const order = await sell([{ variantId, quantity: 1 }]);
    const receipt = await receipts.issue(ownerCtx, order.id);
    const view = await receipts.publicView(receipt.token);

    expect(view.snapshot.lines[0]?.oem.length).toBeGreaterThan(0);
    expect(view.snapshot.lines[0]?.sku).toBe(order.lines[0]?.sku);
  });

  it('generar dos veces devuelve el mismo recibo, no un folio nuevo', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 3);
    const order = await sell([{ variantId, quantity: 1 }]);

    const first = await receipts.issue(ownerCtx, order.id);
    const second = await receipts.issue(ownerCtx, order.id);

    expect(second.id).toBe(first.id);
    expect(second.folio).toBe(first.folio);
    expect(second.token).toBe(first.token);
  });

  it('el PDF publicado no cambia al reemitir ni al cambiar el pedido', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 3);
    const order = await sell([{ variantId, quantity: 1 }]);
    const receipt = await receipts.issue(ownerCtx, order.id);

    const before = await receipts.localFile(receipt.token);
    expect(before && 'path' in before).toBe(true);

    // Un pago posterior cambia el pedido; el recibo ya emitido no debe moverse.
    await orders.addPayment(ownerCtx, order.id, { method: 'EFECTIVO', amountCents: order.totalCents });
    const reissued = await receipts.issue(ownerCtx, order.id);
    const after = await receipts.localFile(reissued.token);

    expect(reissued.token).toBe(receipt.token);
    expect(after && 'path' in after ? after.path : null).toBe(
      before && 'path' in before ? before.path : null,
    );

    const view = await receipts.publicView(receipt.token);
    expect(view.snapshot.totals.paidCents).toBe(0);
  });

  it('un token inválido o inexistente da 404, no un error de base', async () => {
    await expect(receipts.publicView('a'.repeat(22))).rejects.toMatchObject({ status: 404 });
    await expect(receipts.publicView('../../etc/passwd')).rejects.toMatchObject({ status: 404 });
  });

  it('un pedido cancelado no genera recibo', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 2);
    const order = await sell([{ variantId, quantity: 1 }]);
    await orders.cancel(ownerCtx, order.id, 'Cliente desistió');

    await expect(receipts.issue(ownerCtx, order.id)).rejects.toMatchObject({ status: 409 });
  });

  it('el recibo de otro negocio no se ve con el token ajeno', async () => {
    const otherTenant = randomUUID();
    await systemTx(base, (tx) =>
      tx.tenant.create({ data: { id: otherTenant, slug: `otro-${otherTenant.slice(0, 8)}`, name: 'Otro' } }),
    );

    const variantId = await freshVariant();
    await seed(variantId, 2);
    const order = await sell([{ variantId, quantity: 1 }]);
    const receipt = await receipts.issue(ownerCtx, order.id);

    // Con el contexto del otro negocio, el pedido no existe: ni siquiera se puede emitir.
    const otherCtx = ctxLike(otherTenant, userId);
    await expect(receipts.issue(otherCtx, order.id)).rejects.toMatchObject({ status: 404 });

    // El enlace público sí funciona: es el token lo que autoriza, no el negocio.
    const view = await receipts.publicView(receipt.token);
    expect(view.snapshot.tenant.name).toBe('Bodega El Tornillo');

    const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL });
    await client.connect();
    try {
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [otherTenant]);
    } finally {
      await client.end();
    }
  });

  it('el PDF de carta y el ticket se generan con las medidas correctas', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 4);
    const order = await sell([{ variantId, quantity: 2 }], '+50255558899');
    const receipt = await receipts.issue(ownerCtx, order.id);
    const view = await receipts.publicView(receipt.token);

    const letter = await renderReceiptPdf({
      snapshot: view.snapshot,
      publicUrl: receipt.publicUrl,
      format: 'carta',
    });
    const letterDoc = await PDFDocument.load(letter);
    const letterPage = letterDoc.getPage(0);
    expect(Math.round(letterPage.getWidth())).toBe(612);
    expect(Math.round(letterPage.getHeight())).toBe(792);
    expect(letterDoc.getTitle()).toContain(receipt.folio);

    const ticket = await renderReceiptPdf({
      snapshot: view.snapshot,
      publicUrl: receipt.publicUrl,
      format: 'ticket',
    });
    const ticketDoc = await PDFDocument.load(ticket);
    const ticketPage = ticketDoc.getPage(0);
    // 80 mm exactos: la impresora térmica recorta lo que se pase y pierde el pie del recibo.
    expect(Math.round(ticketPage.getWidth())).toBe(227);
    expect(ticketPage.getHeight()).toBeGreaterThan(200);
    expect(ticketPage.getHeight()).toBeLessThan(2000);
  });

  it('el PDF no lleva el costo interno', async () => {
    const variantId = await freshVariant(25_000, 15_000);
    await seed(variantId, 2);
    const order = await sell([{ variantId, quantity: 1 }]);
    const receipt = await receipts.issue(ownerCtx, order.id);
    const view = await receipts.publicView(receipt.token);

    // El snapshot es lo único con lo que se dibuja el PDF: si el costo no está aquí, no puede
    // aparecer en el papel.
    expect(JSON.stringify(view.snapshot)).not.toContain('unitCost');
    expect(JSON.stringify(view.snapshot)).not.toContain('15000');
  });

  it('una venta de una pieza cabe en una sola hoja, sin hoja en blanco al frente', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 2);
    const order = await sell([{ variantId, quantity: 1 }]);
    const receipt = await receipts.issue(ownerCtx, order.id);
    const view = await receipts.publicView(receipt.token);
    const pdf = await renderReceiptPdf({
      snapshot: view.snapshot,
      publicUrl: receipt.publicUrl,
      format: 'carta',
    });
    const doc = await PDFDocument.load(pdf);

    expect(doc.getPageCount()).toBe(1);
  });

  it('una venta larga pagina en varias hojas y no pierde líneas', async () => {
    const variantIds: string[] = [];
    for (let i = 0; i < 26; i += 1) {
      const id = await freshVariant(1_000 + i * 100);
      await seed(id, 2);
      variantIds.push(id);
    }
    const order = await sell(variantIds.map((variantId) => ({ variantId, quantity: 1 })));
    expect(order.lines).toHaveLength(26);

    const receipt = await receipts.issue(ownerCtx, order.id);
    const view = await receipts.publicView(receipt.token);
    const pdf = await renderReceiptPdf({
      snapshot: view.snapshot,
      publicUrl: receipt.publicUrl,
      format: 'carta',
    });
    const doc = await PDFDocument.load(pdf);

    // 26 piezas no caben en una carta: lo que importa es que salgan todas, no que salgan juntas.
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(view.snapshot.lines).toHaveLength(26);
    const sum = view.snapshot.lines.reduce((a, l) => a + l.totalCents, 0);
    expect(sum).toBe(view.snapshot.totals.totalCents);
  });

  it('cada recibo recibe su propio folio', async () => {
    const a = await freshVariant();
    const b = await freshVariant();
    await seed(a, 2);
    await seed(b, 2);
    const first = await sell([{ variantId: a, quantity: 1 }]);
    const second = await sell([{ variantId: b, quantity: 1 }]);

    const ra = await receipts.issue(ownerCtx, first.id);
    const rb = await receipts.issue(ownerCtx, second.id);
    expect(ra.folio).not.toBe(rb.folio);
    expect(ra.token).not.toBe(rb.token);
  });

  it('el ticket de 80 mm se guarda junto a la carta y no hay que generarlo después', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 2);
    const order = await sell([{ variantId, quantity: 1 }]);
    const receipt = await receipts.issue(ownerCtx, order.id);

    expect(receipt.pdfUrl).toContain('/pdf');
    expect(receipt.ticketUrl).toContain('formato=ticket');

    const letter = await receipts.localFile(receipt.token, 'carta');
    const ticket = await receipts.localFile(receipt.token, 'ticket');
    expect(letter && 'path' in letter).toBe(true);
    expect(ticket && 'path' in ticket).toBe(true);
    // Archivos distintos: el de carta no puede servirse cuando piden el ticket.
    const letterPath = letter && 'path' in letter ? letter.path : null;
    const ticketPath = ticket && 'path' in ticket ? ticket.path : null;
    expect(letterPath).not.toBe(ticketPath);
  });

  it('el reenvío no regenera el PDF y trae enlace de WhatsApp', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 2);
    const order = await sell([{ variantId, quantity: 1 }], '+50255558899');
    const issued = await receipts.issue(ownerCtx, order.id);

    const resent = await receipts.resend(ownerCtx, order.id);
    expect(resent.token).toBe(issued.token);
    expect(resent.folio).toBe(issued.folio);
    expect(resent.whatsappUrl).toContain('https://wa.me/50255558899?text=');
    expect(decodeURIComponent(resent.whatsappUrl ?? '')).toContain(order.code);
  });

  it('sin recibo, el reenvío explica qué falta', async () => {
    const variantId = await freshVariant();
    await seed(variantId, 2);
    const order = await sell([{ variantId, quantity: 1 }]);

    await expect(receipts.resend(ownerCtx, order.id)).rejects.toMatchObject({ status: 404 });
  });
});
