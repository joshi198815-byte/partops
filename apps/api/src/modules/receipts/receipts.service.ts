import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type ReceiptFormat,
  type ReceiptPublicView,
  type ReceiptSnapshot,
  type ReceiptSummary,
  receiptUrls,
  receiptWhatsAppMessage,
  whatsappShareUrl,
} from '@partops/contracts';
import type { TxClient } from '@partops/db';
import { type Ctx, canAccessWarehouse } from '../../common/context.js';
import { env } from '../../config/env.js';
import { DatabaseService } from '../../infra/database.module.js';
import { StorageService } from '../../infra/storage.service.js';
import { renderReceiptPdf } from './pdf.js';

/**
 * Recibos.
 *
 * El recibo se congela en el instante en que se emite y nunca se recalcula. Eso obliga a tres cosas
 * que no se ven en la pantalla pero sostienen todo lo demás:
 *
 *  1. El `snapshot` guarda lo que se imprimió: nombre del negocio, NIT, precios, piezas, pagos.
 *     Si mañana el dueño corrige el nombre o el precio de una pieza, los recibos viejos siguen
 *     diciendo la verdad de ese día.
 *  2. El PDF se genera una vez y se sube al almacenamiento. Regenerar cambiaría los metadatos del
 *     archivo y, más importante, abriría la puerta a "regenerar con los datos de hoy".
 *  3. El token es de 128 bits y no lleva el id del pedido: adivinarlo no es posible y, si se filtra,
 *     solo abre ese recibo. Un id autoincremental en la URL sería un listado de todas las ventas.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /**
   * Emite el recibo de un pedido. Idempotente por pedido: si ya existe, devuelve el que hay.
   *
   * Reemitir cambiaría el folio del cliente y dejaría dos PDF con el mismo contenido y distinto
   * número, que es exactamente la discusión que nadie quiere tener con un cliente molesto.
   */
  async issue(ctx: Ctx, orderId: string): Promise<ReceiptSummary> {
    const tenantId = ctx.tenant.tenantId;

    const existing = await this.db.tx(tenantId, (tx) =>
      tx.receipt.findFirst({
        where: { tenantId, orderId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (existing) return this.summarize(existing);

    const prepared = await this.db.tx(tenantId, async (tx) => {
      const order = await tx.salesOrder.findFirst({
        where: { id: orderId, tenantId },
        include: {
          items: true,
          payments: true,
          customer: { select: { name: true, phone: true, taxId: true } },
        },
      });
      if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Ese pedido no existe' });
      if (!canAccessWarehouse(ctx.tenant, order.warehouseId)) {
        throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Ese pedido no existe' });
      }
      if (order.status === 'CANCELADO') {
        throw new ConflictException({
          code: 'ORDER_CANCELLED',
          message: 'Un pedido cancelado no genera recibo',
        });
      }

      const [tenant, user, warehouse] = await Promise.all([
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: {
            name: true,
            legalName: true,
            taxId: true,
            address: true,
            phone: true,
            slug: true,
            brandPrimary: true,
            brandAccent: true,
            taxRateBps: true,
            currency: true,
            receiptPrefix: true,
            orderPrefix: true,
          },
        }),
        order.sellerId
          ? tx.user.findUnique({ where: { id: order.sellerId }, select: { name: true } })
          : // Pedido del catálogo público: no hay empleado que lo haya capturado. El recibo dice
            // de dónde vino en vez de mostrar una celda en blanco.
            Promise.resolve({ name: 'Catálogo en línea' }),
        tx.warehouse.findUnique({ where: { id: order.warehouseId }, select: { code: true } }),
      ]);
      if (!tenant)
        throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Negocio no encontrado' });

      /**
       * Folio con `UPDATE ... RETURNING`, igual que la venta: dos cajas cobrando al mismo tiempo no
       * pueden recibir el mismo número de recibo.
       */
      const [seq] = await tx.$queryRaw<{ number: number }[]>`
        UPDATE "tenant" SET "receiptSeq" = "receiptSeq" + 1
        WHERE "id" = ${tenantId}
        RETURNING "receiptSeq" AS "number"`;
      const number = Number(seq?.number ?? 0);
      if (!number) throw new ConflictException({ code: 'RECEIPT_SEQ_FAILED', message: 'Intenta de nuevo' });

      const paidCents = order.payments.reduce((a, p) => a + p.amountCents, 0);

      const snapshot: ReceiptSnapshot = {
        version: 1,
        orderId: order.id,
        folio: `${tenant.receiptPrefix}-${String(number).padStart(4, '0')}`,
        orderCode: this.orderPrefixOf(tenant.orderPrefix, order.number),
        orderNumber: order.number,
        issuedAt: new Date().toISOString(),
        channel: order.channel,
        status: order.status,
        customer: {
          name: order.customerName,
          phone: order.customerPhone,
          taxId: order.customerTaxId,
        },
        sellerName: user?.name ?? '',
        warehouseCode: warehouse?.code ?? '',
        tenant: {
          name: tenant.name,
          legalName: tenant.legalName,
          taxId: tenant.taxId,
          address: tenant.address,
          phone: tenant.phone,
          slug: tenant.slug,
          brandPrimary: tenant.brandPrimary,
          brandAccent: tenant.brandAccent,
        },
        lines: order.items.map((item) => ({
          sku: item.sku,
          name: item.name,
          variantTitle: item.name,
          unit: 'UNIDAD',
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          discountCents: item.discountCents,
          totalCents: item.totalCents,
          oem: [],
          vehicle: null,
        })),
        totals: {
          subtotalCents: order.subtotalCents,
          taxCents: order.taxCents,
          discountCents: order.discountCents,
          totalCents: order.totalCents,
          paidCents,
          balanceCents: order.totalCents - paidCents,
        },
        payments: order.payments.map((p) => ({
          method: p.method,
          amountCents: p.amountCents,
          createdAt: p.createdAt.toISOString(),
        })),
        taxRateBps: tenant.taxRateBps,
        currency: tenant.currency,
        notes: order.notes,
      };

      /**
       * Los datos de búsqueda de la pieza (OEM y vehículo) se leen aparte: el pedido guarda el SKU
       * y el nombre congelados, pero no los códigos OEM, y el mecánico que vuelve por la misma
       * pieza busca justamente por OEM en el papel.
       */
      const variantIds = order.items.map((i) => i.variantId);
      if (variantIds.length) {
        const variants = await tx.partVariant.findMany({
          where: { tenantId, id: { in: variantIds } },
          select: {
            id: true,
            title: true,
            oemNumbers: true,
            part: {
              select: {
                compatibilities: {
                  take: 1,
                  select: {
                    vehicle: {
                      select: {
                        yearStart: true,
                        yearEnd: true,
                        model: { select: { name: true, brand: { select: { name: true } } } },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        const byId = new Map(variants.map((v) => [v.id, v]));
        snapshot.lines = order.items.map((item) => {
          const meta = byId.get(item.variantId);
          const vehicle = meta?.part.compatibilities[0]?.vehicle;
          return {
            sku: item.sku,
            name: item.name,
            variantTitle: meta?.title ?? item.name,
            unit: 'UNIDAD',
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            discountCents: item.discountCents,
            totalCents: item.totalCents,
            oem: (meta?.oemNumbers ?? []).slice(0, 3),
            vehicle: vehicle
              ? `${vehicle.model.brand.name} ${vehicle.model.name} ${vehicle.yearStart}${
                  vehicle.yearEnd !== vehicle.yearStart ? `-${vehicle.yearEnd}` : ''
                }`
              : null,
          };
        });
      }

      const token = randomBytes(16).toString('base64url');
      const folio = `${tenant.receiptPrefix}-${String(number).padStart(4, '0')}`;

      const receipt = await tx.receipt.create({
        data: {
          tenantId,
          orderId,
          folio,
          token,
          snapshot: snapshot as never,
          totalCents: order.totalCents,
        },
      });

      return { receipt, snapshot };
    });

    // Los dos PDF se generan fuera de la transacción: pdf-lib y el QR tardan decenas de
    // milisegundos y mantener una conexión abierta mientras se dibuja bloquearía el pool.
    //
    // Se generan AMBOS, no solo el elegido: el mostrador imprime el ticket en la térmica y manda la
    // carta por WhatsApp, y son el mismo recibo. Si el segundo se generara a demanda, su contenido
    // dependería del día en que alguien lo pida, que es justo lo que un recibo no debe hacer.
    const prefix = this.storage.tenantPrefix(tenantId, 'receipts', prepared.receipt.id);
    const publicUrl = this.publicUrl(prepared.receipt.token);

    const [letterPdf, ticketPdf] = await Promise.all([
      renderReceiptPdf({ snapshot: prepared.snapshot, publicUrl, format: 'carta' }),
      renderReceiptPdf({ snapshot: prepared.snapshot, publicUrl, format: 'ticket' }),
    ]);
    const [letter, ticket] = await Promise.all([
      this.storage.put(`${prefix}/carta`, Buffer.from(letterPdf), '.pdf', 'application/pdf'),
      this.storage.put(`${prefix}/ticket`, Buffer.from(ticketPdf), '.pdf', 'application/pdf'),
    ]);

    const saved = await this.db.tx(tenantId, (tx) =>
      tx.receipt.update({
        where: { id: prepared.receipt.id },
        data: { pdfKey: letter.key, ticketKey: ticket.key },
      }),
    );

    return this.summarize(saved);
  }

  /**
   * Recibo ya emitido del pedido, o `null` si todavía no hay.
   *
   * Sin `throw`: el panel de ventas pregunta esto al abrir cualquier pedido, y "no tiene recibo" es
   * el estado normal de un pedido que se acaba de crear.
   */
  async find(ctx: Ctx, orderId: string): Promise<ReceiptSummary | null> {
    const tenantId = ctx.tenant.tenantId;
    const receipt = await this.db.tx(tenantId, (tx) =>
      tx.receipt.findFirst({ where: { tenantId, orderId }, orderBy: { createdAt: 'desc' } }),
    );
    return receipt ? this.summarize(receipt) : null;
  }

  /** Reenvío: devuelve el mismo recibo con su enlace de WhatsApp. No regenera el PDF. */
  async resend(ctx: Ctx, orderId: string): Promise<ReceiptSummary> {
    const tenantId = ctx.tenant.tenantId;
    const receipt = await this.db.tx(tenantId, (tx) =>
      tx.receipt.findFirst({ where: { tenantId, orderId }, orderBy: { createdAt: 'desc' } }),
    );
    if (!receipt) {
      throw new NotFoundException({
        code: 'RECEIPT_NOT_FOUND',
        message: 'Ese pedido todavía no tiene recibo: emítelo primero',
      });
    }

    const order = await this.db.tx(tenantId, (tx) =>
      tx.salesOrder.findFirst({
        where: { id: orderId, tenantId },
        select: { customerName: true, customerPhone: true },
      }),
    );
    const tenant = await this.db.tx(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true, currency: true } }),
    );

    /**
     * El mensaje sigue al snapshot cuando existe —que es lo normal— y solo cae al pedido vivo para
     * recibos viejos sin folio de pedido guardado. El cliente debe leer lo mismo que en su PDF.
     */
    const snapshot = receipt.snapshot as unknown as ReceiptSnapshot;
    const text = receiptWhatsAppMessage({
      tenantName: snapshot.tenant?.name ?? tenant?.name ?? '',
      customerName: snapshot.customer?.name ?? order?.customerName ?? '',
      folio: receipt.folio,
      orderCode: snapshot.orderCode ?? '',
      totalCents: receipt.totalCents,
      publicUrl: receiptUrls(env.WEB_APP_URL, receipt.token).publicUrl,
      currency: snapshot.currency ?? tenant?.currency ?? 'GTQ',
    });

    return { ...this.summarize(receipt), whatsappUrl: whatsappShareUrl(order?.customerPhone, text) };
  }

  /**
   * Vista pública por token.
   *
   * Es la única ruta sin sesión que devuelve datos de un pedido, así que el aislamiento se apoya en
   * tres cosas: el token de 128 bits, la búsqueda por `token` (no por id) y la transacción de
   * sistema con el `tenantId` que viene de la propia fila del recibo. Nunca se acepta un tenant en
   * la URL: no hay nada que manipular para ver el recibo de otra bodega.
   */
  async publicView(token: string): Promise<ReceiptPublicView> {
    const receipt = await this.db.system(async (tx) => {
      const found = await tx.receipt.findUnique({ where: { token } });
      if (!found) return null;
      return found;
    });

    // 404 sin distinguir "no existe" de "token malformado": un 400 con otra forma sería un oráculo.
    if (!receipt) {
      throw new NotFoundException({ code: 'RECEIPT_NOT_FOUND', message: 'Ese recibo no existe' });
    }

    return {
      folio: receipt.folio,
      token: receipt.token,
      createdAt: receipt.createdAt.toISOString(),
      totalCents: receipt.totalCents,
      snapshot: receipt.snapshot as unknown as ReceiptSnapshot,
      pdfUrl: receipt.pdfKey ? `/api/public/receipts/${receipt.token}/pdf` : null,
      ticketUrl: receipt.ticketKey ? this.pdfUrl(receipt.token, 'ticket') : null,
    };
  }

  /** El PDF guardado. En R2 se redirige; en disco se sirve el archivo. */
  async pdfFile(
    token: string,
    format: ReceiptFormat = 'carta',
  ): Promise<{ key: string; url: string; filename: string } | null> {
    const receipt = await this.db.system((tx) => tx.receipt.findUnique({ where: { token } }));
    const key = format === 'ticket' ? receipt?.ticketKey : receipt?.pdfKey;
    if (!receipt || !key) return null;
    return {
      key,
      url: this.pdfUrl(token, format),
      filename: `recibo-${receipt.folio}.pdf`,
    };
  }

  // ───────────────────────────── Auxiliares ─────────────────────────────

  private publicUrl(token: string): string {
    return receiptUrls(env.WEB_APP_URL, token).publicUrl;
  }

  private pdfUrl(token: string, format: ReceiptFormat = 'carta'): string {
    // Ruta relativa: la web la reescribe a la API y el PDF se sirve en el mismo origen, así el
    // enlace funciona igual en localhost y detrás de Cloudflare.
    return `/api/public/receipts/${token}/pdf${format === 'ticket' ? '?formato=ticket' : ''}`;
  }

  private summarize(receipt: {
    id: string;
    folio: string;
    token: string;
    createdAt: Date;
    totalCents: number;
    pdfKey?: string | null;
    ticketKey?: string | null;
    snapshot: unknown;
  }): ReceiptSummary {
    const urls = receiptUrls(env.WEB_APP_URL, receipt.token);
    const snapshot = receipt.snapshot as ReceiptSnapshot;
    const text = receiptWhatsAppMessage({
      tenantName: snapshot.tenant.name,
      customerName: snapshot.customer.name,
      folio: receipt.folio,
      orderCode: snapshot.orderCode,
      totalCents: receipt.totalCents,
      publicUrl: urls.publicUrl,
      currency: snapshot.currency,
    });
    return {
      id: receipt.id,
      folio: receipt.folio,
      token: receipt.token,
      createdAt: receipt.createdAt.toISOString(),
      totalCents: receipt.totalCents,
      publicUrl: urls.publicUrl,
      pdfUrl: urls.pdfUrl,
      // `null` cuando el recibo se emitió antes de que existiera el ticket: la pantalla esconde
      // ese botón en vez de ofrecer una descarga que va a dar 404.
      ticketUrl: receipt.pdfKey && receipt.ticketKey ? this.pdfUrl(receipt.token, 'ticket') : null,
      whatsappUrl: whatsappShareUrl(snapshot.customer.phone, text),
    };
  }

  private orderPrefixOf(prefix: string, number: number): string {
    return `${prefix}-${String(number).padStart(4, '0')}`;
  }

  /** Descarga del archivo en modo local. En R2 el controlador redirige y no llega aquí. */
  async localFile(
    token: string,
    format: ReceiptFormat = 'carta',
  ): Promise<{ path: string; filename: string } | { redirect: string } | null> {
    const found = await this.pdfFile(token, format);
    if (!found) return null;
    const path = this.storage.localPath(found.key);
    if (!path) return { redirect: found.url };
    return { path, filename: found.filename };
  }
}

/** Tipo mínimo del cliente de transacción que usan los helpers de este archivo. */
export type ReceiptTx = TxClient;
