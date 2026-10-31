import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  compactOps,
  DISPATCH_OP_EVENT,
  DISPATCH_QUEUE_STATUSES,
  type DispatchLine,
  type DispatchOp,
  type DispatchOpOutcome,
  type DispatchOpResult,
  type DispatchOrder,
  type DispatchQueueQuery,
  type DispatchQueueResponse,
  type DispatchSyncData,
  type DispatchSyncResponse,
  isPriority,
  type LineStatus,
  type OrderStatus,
  scanVerdict,
  sortByBinWalk,
  sortDispatchOrders,
} from '@partops/contracts';
import type { TxClient } from '@partops/db';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { PushService } from '../../infra/push.service.js';
import { RealtimeService } from '../../infra/realtime.service.js';
import { OrdersService } from '../orders/orders.service.js';

/**
 * Despacho de bodega.
 *
 * La pantalla del bodeguero no es "la lista de pedidos más un botón". Es el lugar donde una pieza
 * se separa de su estante, y por eso el orden de las reglas es:
 *
 *  1. **Sin escaneo correcto no se marca.** Comparar el código leído contra SKU, código de barras,
 *     número de parte y OEM es lo único que impide entregar la pieza vecina, que se ve idéntica.
 *  2. **Un reintento no duplica.** Cada operación lleva `opId`; la misma operación aplicada dos
 *     veces devuelve el mismo resultado y no vuelve a mover el inventario.
 *  3. **La lista se ordena por la caminata.** Pasillo, estante y nombre: una vuelta a la bodega.
 *  4. **El aviso nunca tumba el cambio.** Un push fallido o un socket caído se registra y se sigue:
 *     la pieza ya salió y el inventario ya es correcto.
 */
@Injectable()
export class DispatchService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  // ───────────────────────────── Cola ─────────────────────────────

  /**
   * Cola de preparación.
   *
   * Una sola consulta SQL: pedidos abiertos, líneas con trabajo y la ubicación de cada pieza. Hacer
   * cuatro llamadas encadenadas (pedidos, líneas, variantes, ubicaciones) costaría medio segundo en
   * una red de bodega, y esa pantalla se recarga cada vez que entra un pedido.
   */
  async queue(ctx: Ctx, query: DispatchQueueQuery): Promise<DispatchQueueResponse> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;
    const warehouseId = query.warehouseId ?? null;
    const term = query.q.trim();
    const like = `%${term}%`;
    const onlyActionable = query.onlyActionable ?? true;

    return this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          orderId: string;
          number: number;
          orderStatus: string;
          channel: string;
          customerName: string;
          customerPhone: string | null;
          warehouseId: string;
          warehouseCode: string;
          createdAt: Date;
          orderPrefix: string;
          itemId: string;
          variantId: string;
          sku: string;
          barcode: string | null;
          partNumber: string | null;
          oemNumbers: string[] | null;
          name: string;
          variantTitle: string | null;
          unit: string | null;
          quantity: number;
          lineStatus: string;
          binLocation: string | null;
          itemWarehouseId: string;
          itemWarehouseCode: string;
          reservedUntil: Date | null;
        }>
      >`
        SELECT o."id" AS "orderId", o."number", o."status"::text AS "orderStatus",
               o."channel"::text AS "channel", o."customerName", o."customerPhone",
               o."warehouseId", w."code" AS "warehouseCode", o."createdAt", t."orderPrefix",
               i."id" AS "itemId", i."variantId", i."sku", v."barcode", v."partNumber",
               v."oemNumbers", i."name", v."title" AS "variantTitle", p."unit",
               i."quantity", i."status"::text AS "lineStatus",
               l."binLocation",
               i."warehouseId" AS "itemWarehouseId",
               wi."code" AS "itemWarehouseCode",
               i."reservedUntil"
        FROM "sales_order_item" i
        JOIN "sales_order" o ON o."id" = i."orderId"
        JOIN "tenant" t ON t."id" = o."tenantId"
        JOIN "warehouse" w ON w."id" = o."warehouseId"
        JOIN "warehouse" wi ON wi."id" = i."warehouseId"
        LEFT JOIN "part_variant" v ON v."id" = i."variantId"
        LEFT JOIN "part" p ON p."id" = v."partId"
        LEFT JOIN "inventory_level" l
          ON l."variantId" = i."variantId" AND l."warehouseId" = i."warehouseId"
        WHERE i."tenantId" = ${tenantId}
          AND o."status" <> 'CANCELADO'
          AND i."status"::text = ANY(${DISPATCH_QUEUE_STATUSES as unknown as string[]}::text[])
          AND (${warehouseId}::text IS NULL OR i."warehouseId" = ${warehouseId}::text)
          AND (${allowed.length === 0}::boolean OR i."warehouseId" = ANY(${allowed}::text[]))
          AND (${term === ''}::boolean
               OR i."sku" ILIKE ${like}
               OR i."name" ILIKE ${like}
               OR o."customerName" ILIKE ${like}
               OR (t."orderPrefix" || '-' || lpad(o."number"::text, 4, '0')) ILIKE ${like})
        ORDER BY o."createdAt" ASC
        LIMIT 600`;

      const now = Date.now();
      const byOrder = new Map<string, DispatchOrder>();

      for (const row of rows) {
        const orderId = row.orderId;
        let order = byOrder.get(orderId);
        if (!order) {
          const createdAt = new Date(row.createdAt).toISOString();
          order = {
            orderId,
            code: `${row.orderPrefix}-${String(row.number).padStart(4, '0')}`,
            status: row.orderStatus as OrderStatus,
            channel: row.channel,
            customerName: row.customerName,
            customerPhone: row.customerPhone,
            warehouseId: row.warehouseId,
            warehouseCode: row.warehouseCode,
            ageMinutes: Math.max(0, Math.round((now - Date.parse(createdAt)) / 60_000)),
            createdAt,
            lines: [],
            pendingUnits: 0,
            readyUnits: 0,
            priority: false,
          };
          byOrder.set(orderId, order);
        }

        const line: DispatchLine = {
          itemId: row.itemId,
          variantId: row.variantId,
          sku: row.sku,
          barcode: row.barcode,
          partNumber: row.partNumber,
          oemNumbers: row.oemNumbers ?? [],
          name: row.name,
          variantTitle: row.variantTitle ?? row.name,
          unit: row.unit ?? 'UNIDAD',
          quantity: row.quantity,
          status: row.lineStatus as LineStatus,
          binLocation: row.binLocation,
          warehouseId: row.itemWarehouseId,
          warehouseCode: row.itemWarehouseCode,
          reservedUntil: row.reservedUntil ? new Date(row.reservedUntil).toISOString() : null,
        };
        order.lines.push(line);
        if (line.status === 'LISTO') order.readyUnits += line.quantity;
        else order.pendingUnits += line.quantity;
      }

      const orders = sortDispatchOrders(
        [...byOrder.values()]
          .map((order) => ({
            ...order,
            lines: sortByBinWalk(order.lines),
            priority: isPriority(order.ageMinutes, order.pendingUnits),
          }))
          .filter((order) => (onlyActionable ? order.pendingUnits > 0 : true)),
      );

      return {
        orders,
        pendingUnits: orders.reduce((acc, o) => acc + o.pendingUnits, 0),
        readyUnits: orders.reduce((acc, o) => acc + o.readyUnits, 0),
        serverTime: new Date().toISOString(),
      };
    });
  }

  /**
   * Lleva la línea hasta `target` dando los pasos legales que falten.
   *
   * Escanear una pieza es prepararla: el bodeguero la tomó del estante, y eso ES el paso
   * `EN_PREPARACION`. Exigirle un toque extra para "empezar a preparar" antes de dejarlo escanear
   * convertiría el escaneo en un trámite y él aprendería a saltárselo, que es justo lo que el
   * escaneo existe para impedir. Lo que no se salta: `ENTREGADO` sigue exigiendo `LISTO`, porque
   * una pieza no puede salir de la bodega sin haber sido preparada.
   */
  private async advance(
    tx: TxClient,
    ctx: Ctx,
    orderId: string,
    itemId: string,
    target: DispatchOp['status'],
    options: { opId?: string; scannedCode?: string | null },
  ) {
    const current = await tx.salesOrderItem.findFirst({
      where: { id: itemId, orderId, tenantId: ctx.tenant.tenantId },
      select: { status: true },
    });

    if (current?.status === 'PENDIENTE' && target === 'LISTO') {
      await this.orders.applyLineChange(tx, ctx, orderId, itemId, 'EN_PREPARACION', {
        scannedCode: options.scannedCode ?? null,
      });
    }

    return this.orders.applyLineChange(tx, ctx, orderId, itemId, target as LineStatus, options);
  }

  // ───────────────────────────── Escaneo ─────────────────────────────

  /**
   * Escanear una pieza de una línea.
   *
   * El código se compara contra todos los códigos impresos de la pieza. Si no coincide, la línea no
   * se mueve y se devuelve un `ok: false` con el SKU esperado: el bodeguero necesita saber qué
   * tiene en la mano, no un "error de validación".
   *
   * No escribe en `dispatch_op`: el escaneo es una acción con respuesta inmediata, no algo que el
   * teléfono repita a ciegas. La cola offline va por `sync`, que sí es idempotente.
   */
  async scan(ctx: Ctx, orderId: string, itemId: string, code: string, status: 'LISTO' | 'SIN_STOCK') {
    const tenantId = ctx.tenant.tenantId;

    const outcome = await this.db.tx(tenantId, async (tx) => {
      const line = await tx.salesOrderItem.findFirst({
        where: { id: itemId, orderId, tenantId },
        select: { id: true, sku: true, variantId: true, warehouseId: true, status: true },
      });
      if (!line) throw new NotFoundException({ code: 'LINE_NOT_FOUND', message: 'Esa línea no existe' });

      const variant = await tx.partVariant.findFirst({
        where: { id: line.variantId, tenantId },
        select: { sku: true, barcode: true, partNumber: true, oemNumbers: true },
      });

      const verdict = scanVerdict(
        {
          sku: variant?.sku ?? line.sku,
          barcode: variant?.barcode,
          partNumber: variant?.partNumber,
          oemNumbers: variant?.oemNumbers,
        },
        code,
      );

      if (verdict !== 'COINCIDE') {
        return {
          ok: false as const,
          verdict,
          expectedSku: variant?.sku ?? line.sku,
          message:
            verdict === 'VACIO'
              ? 'No se leyó ningún código. Vuelve a escanear.'
              : `Ese código no es de esta pieza. En la línea va ${variant?.sku ?? line.sku}.`,
        };
      }

      const applied = await this.advance(tx, ctx, orderId, itemId, status, {
        scannedCode: code,
      });
      return { ok: true as const, verdict, applied, warehouseId: line.warehouseId };
    });

    if (outcome.ok) {
      this.realtime.emitUpdate(tenantId, outcome.warehouseId, {
        orderId,
        code: outcome.applied.code,
        status: (outcome.applied.derived ?? 'EN_PREPARACION') as OrderStatus,
        warehouseId: outcome.warehouseId,
        line: { itemId, sku: outcome.applied.sku, status: status as LineStatus },
        actorName: ctx.user.name,
        kind: outcome.applied.derived === 'ENTREGADO' ? 'ENTREGADO' : 'LINEA',
        at: new Date().toISOString(),
      });
    }

    return outcome;
  }

  // ───────────────────────────── Sincronización ─────────────────────────────

  /**
   * Aplica el lote que el teléfono guardó sin señal.
   *
   * Cada operación se aplica en su propia transacción y su propio error: una línea que ya no se
   * puede mover (la cancelaron desde el mostrador) no debe impedir que las otras nueve se guarden.
   * La respuesta trae el resultado operación por operación y la cola recalculada, para que el
   * teléfono no tenga que pedir nada más.
   */
  async sync(ctx: Ctx, input: DispatchSyncData): Promise<DispatchSyncResponse> {
    const ops = compactOps(input.ops);
    const results: DispatchOpResult[] = [];

    for (const op of ops) {
      const applied = await this.applyOp(ctx, op);
      results.push(applied);
      if (applied.outcome !== 'RECHAZADO') this.announce(ctx.tenant.tenantId, op, applied);
    }

    return { results, queue: await this.queue(ctx, { q: '', onlyActionable: true }) };
  }

  private async applyOp(ctx: Ctx, op: DispatchOp): Promise<DispatchOpResult> {
    const tenantId = ctx.tenant.tenantId;
    try {
      const applied = await this.db.tx(tenantId, async (tx) =>
        this.advance(tx, ctx, op.orderId, op.itemId, op.status, {
          opId: op.opId,
          scannedCode: op.scannedCode ?? null,
        }),
      );

      return {
        opId: op.opId,
        outcome: (applied.repeated ? 'REPETIDO' : 'APLICADO') as DispatchOpOutcome,
        orderId: op.orderId,
        itemId: op.itemId,
        status: applied.status,
        code: applied.code || undefined,
      };
    } catch (error) {
      /**
       * Se registra el rechazo en `dispatch_op` también: sin eso, el teléfono reintentaría para
       * siempre la misma operación imposible (la línea ya se entregó) y la cola nunca se vaciaría.
       */
      const message = error instanceof Error ? error.message : 'No se pudo aplicar';
      const code = (error as { response?: { code?: string } }).response?.code;
      await this.recordRejected(ctx, op, message);
      return {
        opId: op.opId,
        outcome: 'RECHAZADO',
        orderId: op.orderId,
        itemId: op.itemId,
        status: null,
        code,
        message,
      };
    }
  }

  private async recordRejected(ctx: Ctx, op: DispatchOp, message: string) {
    const tenantId = ctx.tenant.tenantId;
    await this.db
      .tx(tenantId, async (tx) => {
        const exists = await tx.dispatchOp.findUnique({
          where: { tenantId_opId: { tenantId, opId: op.opId } },
          select: { id: true },
        });
        if (exists) return;
        await tx.dispatchOp.create({
          data: {
            tenantId,
            opId: op.opId,
            orderId: op.orderId,
            itemId: op.itemId,
            status: op.status,
            outcome: 'RECHAZADO',
            scannedCode: op.scannedCode ?? null,
            actorId: ctx.user.id,
          },
        });
        await tx.orderEvent.create({
          data: {
            tenantId,
            orderId: op.orderId,
            itemId: op.itemId,
            type: DISPATCH_OP_EVENT,
            detail: { opId: op.opId, rejected: true, message } as never,
            actorId: ctx.user.id,
          },
        });
      })
      // Si ni siquiera se puede registrar el rechazo (el pedido ya no existe), se sigue: el
      // llamador recibe el rechazo y el teléfono descarta la operación.
      .catch(() => undefined);
  }

  /** Aviso al resto de la bodega: socket primero, push después. */
  private announce(tenantId: string, op: DispatchOp, result: DispatchOpResult) {
    this.realtime.emitUpdate(tenantId, '', {
      orderId: op.orderId,
      code: result.code ?? '',
      status: (result.status === 'ENTREGADO' ? 'ENTREGADO' : 'EN_PREPARACION') as OrderStatus,
      warehouseId: '',
      line: { itemId: op.itemId, sku: result.code ?? '', status: result.status as LineStatus },
      actorName: null,
      kind: result.status === 'ENTREGADO' ? 'ENTREGADO' : 'LINEA',
      at: new Date().toISOString(),
    });
  }
}
