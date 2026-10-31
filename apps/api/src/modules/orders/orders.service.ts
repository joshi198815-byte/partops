import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  canTransitionLine,
  DISPATCH_OP_EVENT,
  deriveOrderStatus,
  type LineStatus,
  lineHoldsReservation,
  normalizeGtPhone,
  type OrderChannel,
  type OrderCreateData,
  type OrderDetail,
  type OrderEventRow,
  type OrderLineRow,
  type OrderListQuery,
  type OrderListResponse,
  type OrderPaymentRow,
  type OrderStatus,
  type OrderSummary,
  orderCode,
  type PaymentCreateData,
  type PaymentMethod,
} from '@partops/contracts';
import type { Prisma, TxClient } from '@partops/db';
import { audit } from '../../common/audit.js';
import { type Ctx, canAccessWarehouse } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { RealtimeService } from '../../infra/realtime.service.js';
import { DispatchNotifier } from '../dispatch/dispatch.notifier.js';
import { InventoryService } from '../inventory/inventory.service.js';

/** Veinte minutos: lo que tarda un cliente en llegar a la sucursal a recoger su pieza. */
const RESERVATION_TTL_MS = 20 * 60_000;

interface ResolvedLine {
  variantId: string;
  sku: string;
  name: string;
  variantTitle: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number;
  discountCents: number;
  totalCents: number;
  warehouseId: string;
  status: LineStatus;
}

/** Lo que devuelve aplicar el cambio de una línea: la bodega necesita el folio y el estado nuevo. */
interface LineChangeResult {
  orderId: string;
  itemId: string;
  code: string;
  status: LineStatus | null;
  sku: string;
  derived: OrderStatus | null;
  repeated: boolean;
  warehouseId?: string;
  from?: LineStatus;
}

/**
 * Origen del pedido.
 *
 * `actorId` es quién queda en la bitácora y en el evento. En un pedido de mostrador es el vendedor;
 * en uno del catálogo público no hay vendedor, así que se usa el identificador del propio canal.
 * Nunca se deja vacío: una venta sin responsable en la bitácora es una venta que no se puede
 * auditar, y el primer reclamo del dueño ("¿quién metió este pedido?") llega el mismo día.
 */
export interface CreateOrderOptions {
  /** Pedido sin usuario del negocio: el `sellerId` queda nulo y el evento lo firma el canal. */
  guest?: boolean;
  /** Slug de la vitrina de origen, para separar pedidos web de pedidos de mostrador. */
  sourceSlug?: string;
  /** Ignorar el precio que venga en las líneas: en la vitrina el precio lo pone el catálogo. */
  lockPrice?: boolean;
}

/**
 * Pedidos.
 *
 * Tres reglas mandan sobre todo lo demás:
 *
 *  1. **El estado vive en la línea.** Una venta de cinco piezas puede salir de dos bodegas; si el
 *     estado estuviera solo en la cabecera, el bodeguero que ya despachó su parte no podría cerrar
 *     nada porque la otra sucursal todavía no tiene la pieza. La cabecera se deriva (ver
 *     `deriveOrderStatus`) y nunca se escribe a mano.
 *  2. **Falta de existencia no cancela la venta.** Si de una línea no hay, esa línea nace
 *     `SIN_STOCK` y las demás se reservan igual. Rechazar el pedido entero por una pieza que se
 *     consigue mañana es perder la venta de las otras cuatro.
 *  3. **La reserva y la línea nacen en la misma transacción.** Nunca hay una pieza apartada sin
 *     pedido que la respalde ni un pedido prometiendo piezas que otro ya vendió: si algo falla, se
 *     revierte todo y el folio no avanza.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(DispatchNotifier) private readonly notifier: DispatchNotifier,
  ) {}

  // ───────────────────────────── Lectura ─────────────────────────────

  async list(ctx: Ctx, query: OrderListQuery): Promise<OrderListResponse> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;
    const term = query.q.trim();
    const like = `%${term}%`;
    const status = query.status ?? null;
    const channel = query.channel ?? null;
    const warehouseId = query.warehouseId ?? null;
    const open = query.open ?? null;
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const offset = Math.max(query.offset, 0);

    return this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          number: number;
          status: string;
          channel: string;
          customerName: string;
          customerPhone: string | null;
          customerId: string | null;
          warehouseId: string;
          warehouseCode: string;
          totalCents: number;
          createdAt: Date;
          closedAt: Date | null;
          sellerName: string;
          orderPrefix: string;
          lineCount: bigint;
          units: bigint;
          pendingUnits: bigint;
          paidCents: bigint;
        }>
      >`
        SELECT o."id", o."number", o."status"::text AS "status", o."channel"::text AS "channel",
               o."customerName", o."customerPhone", o."customerId",
               o."warehouseId", w."code" AS "warehouseCode", o."totalCents",
               o."createdAt", o."closedAt",
               coalesce(u."name", 'Catálogo en línea') AS "sellerName", t."orderPrefix",
               (SELECT count(*) FROM "sales_order_item" i WHERE i."orderId" = o."id") AS "lineCount",
               (SELECT coalesce(sum(i."quantity"), 0) FROM "sales_order_item" i
                 WHERE i."orderId" = o."id" AND i."status" <> 'CANCELADO') AS "units",
               (SELECT coalesce(sum(i."quantity"), 0) FROM "sales_order_item" i
                 WHERE i."orderId" = o."id"
                   AND i."status" IN ('PENDIENTE', 'EN_PREPARACION', 'SIN_STOCK')) AS "pendingUnits",
               (SELECT coalesce(sum(p."amountCents"), 0) FROM "payment" p
                 WHERE p."orderId" = o."id") AS "paidCents"
        FROM "sales_order" o
        JOIN "warehouse" w ON w."id" = o."warehouseId"
        JOIN "tenant" t ON t."id" = o."tenantId"
        LEFT JOIN "user" u ON u."id" = o."sellerId"
        WHERE o."tenantId" = ${tenantId}
          AND (${status}::text IS NULL OR o."status"::text = ${status}::text)
          AND (${channel}::text IS NULL OR o."channel"::text = ${channel}::text)
          AND (${warehouseId}::text IS NULL OR o."warehouseId" = ${warehouseId}::text)
          AND (${open}::boolean IS NULL
               OR (${open}::boolean AND o."status" NOT IN ('ENTREGADO', 'CANCELADO'))
               OR (NOT ${open}::boolean AND o."status" IN ('ENTREGADO', 'CANCELADO')))
          AND (${term === ''}::boolean
               OR o."customerName" ILIKE ${like}
               OR coalesce(o."customerPhone", '') ILIKE ${like}
               OR o."number"::text = ${term.replace(/\D/g, '') || '-1'})
          AND (${allowed.length === 0}::boolean OR o."warehouseId" = ANY(${allowed}::text[]))
        ORDER BY o."createdAt" DESC, o."number" DESC
        LIMIT ${limit} OFFSET ${offset}`;

      const [countRow] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS "total"
        FROM "sales_order" o
        WHERE o."tenantId" = ${tenantId}
          AND (${status}::text IS NULL OR o."status"::text = ${status}::text)
          AND (${channel}::text IS NULL OR o."channel"::text = ${channel}::text)
          AND (${warehouseId}::text IS NULL OR o."warehouseId" = ${warehouseId}::text)
          AND (${open}::boolean IS NULL
               OR (${open}::boolean AND o."status" NOT IN ('ENTREGADO', 'CANCELADO'))
               OR (NOT ${open}::boolean AND o."status" IN ('ENTREGADO', 'CANCELADO')))
          AND (${term === ''}::boolean
               OR o."customerName" ILIKE ${like}
               OR coalesce(o."customerPhone", '') ILIKE ${like}
               OR o."number"::text = ${term.replace(/\D/g, '') || '-1'})
          AND (${allowed.length === 0}::boolean OR o."warehouseId" = ANY(${allowed}::text[]))`;

      return {
        items: rows.map((r) => this.toSummary(r)),
        total: Number(countRow?.total ?? 0),
        limit,
        offset,
      };
    });
  }

  async detail(ctx: Ctx, orderId: string): Promise<OrderDetail> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;

    return this.db.tx(tenantId, async (tx) => {
      const order = await tx.salesOrder.findFirst({
        where: { id: orderId, tenantId },
        include: {
          items: true,
          payments: true,
          events: { orderBy: { createdAt: 'desc' }, take: 30 },
          customer: { select: { id: true, name: true, phone: true } },
        },
      });
      if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Ese pedido no existe' });
      if (!canAccessWarehouse(ctx.tenant, order.warehouseId)) {
        throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Ese pedido no existe' });
      }

      const [warehouse, seller, tenant, variants, actors] = await Promise.all([
        tx.warehouse.findUnique({ where: { id: order.warehouseId }, select: { code: true } }),
        order.sellerId
          ? tx.user.findUnique({ where: { id: order.sellerId }, select: { name: true } })
          : // Pedido de invitado del catálogo: no hay vendedor. Se dice de dónde vino en vez de
            // dejar la celda vacía, que en el recibo se lee como un dato perdido.
            Promise.resolve({ name: 'Catálogo en línea' }),
        tx.tenant.findUnique({ where: { id: tenantId }, select: { orderPrefix: true } }),
        this.variantInfo(
          tx,
          order.items.map((i) => i.variantId),
          allowed,
        ),
        this.actorNames(
          tx,
          order.events.map((e) => e.actorId).filter((id): id is string => Boolean(id)),
        ),
      ]);

      const lines: OrderLineRow[] = order.items.map((item) => {
        const info = variants.get(item.variantId);
        return {
          id: item.id,
          variantId: item.variantId,
          sku: item.sku,
          name: item.name,
          variantTitle: info?.variantTitle ?? item.name,
          unit: info?.unit ?? 'UNIDAD',
          quantity: item.quantity,
          // El costo se manda a `null` sin permiso: ocultarlo en la UI no es ocultarlo.
          unitCostCents: ctx.tenant.permissions.has('catalog.cost.view') ? item.unitCostCents : null,
          unitPriceCents: item.unitPriceCents,
          discountCents: item.discountCents,
          totalCents: item.totalCents,
          status: item.status as LineStatus,
          warehouseId: item.warehouseId,
          warehouseCode: info?.warehouseCode ?? warehouse?.code ?? '',
          binLocation: info?.binLocation ?? null,
          reservedUntil: item.reservedUntil ? item.reservedUntil.toISOString() : null,
          preparedAt: item.preparedAt ? item.preparedAt.toISOString() : null,
          deliveredAt: item.deliveredAt ? item.deliveredAt.toISOString() : null,
        };
      });

      const paidCents = order.payments.reduce((a, p) => a + p.amountCents, 0);
      const summary = this.toSummary({
        id: order.id,
        number: order.number,
        status: order.status,
        channel: order.channel,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerId: order.customerId,
        warehouseId: order.warehouseId,
        warehouseCode: warehouse?.code ?? '',
        totalCents: order.totalCents,
        createdAt: order.createdAt,
        closedAt: order.closedAt,
        sellerName: seller?.name ?? '',
        orderPrefix: tenant?.orderPrefix ?? 'PD',
        lineCount: BigInt(lines.length),
        units: BigInt(lines.filter((l) => l.status !== 'CANCELADO').reduce((a, l) => a + l.quantity, 0)),
        pendingUnits: BigInt(
          lines
            .filter(
              (l) => l.status === 'PENDIENTE' || l.status === 'EN_PREPARACION' || l.status === 'SIN_STOCK',
            )
            .reduce((a, l) => a + l.quantity, 0),
        ),
        paidCents: BigInt(paidCents),
      });

      return {
        ...summary,
        customerTaxId: order.customerTaxId,
        notes: order.notes,
        subtotalCents: order.subtotalCents,
        taxCents: order.taxCents,
        discountCents: order.discountCents,
        lines,
        payments: order.payments.map(
          (p): OrderPaymentRow => ({
            id: p.id,
            method: p.method as PaymentMethod,
            amountCents: p.amountCents,
            receivedCents: p.receivedCents,
            changeCents: p.changeCents,
            reference: p.reference,
            createdAt: p.createdAt.toISOString(),
          }),
        ),
        events: order.events.map(
          (e): OrderEventRow => ({
            id: e.id,
            type: e.type,
            detail: (e.detail ?? null) as Record<string, unknown> | null,
            actorName: e.actorId ? (actors.get(e.actorId) ?? null) : null,
            createdAt: e.createdAt.toISOString(),
          }),
        ),
        next: this.nextFor(order.status as OrderStatus, lines),
      };
    });
  }

  // ───────────────────────────── Alta ─────────────────────────────

  /**
   * Crear un pedido.
   *
   * `idempotencyKey` es lo que salva la venta cuando el mostrador tiene mala señal: el vendedor
   * toca "cobrar", el request se va, la red se cae, la pantalla dice error y él vuelve a tocar. Sin
   * la clave, el cliente sale con dos pedidos y la pieza aparece reservada dos veces.
   *
   * `options.guest` es el pedido de invitado del catálogo público: no hay usuario del negocio que
   * lo capture, la bodega se elige por existencia, el precio lo pone el catálogo (no el cliente) y
   * el pedido no se puede tocar desde la vitrina después de creado.
   */
  async create(ctx: Ctx, input: OrderCreateData, options: CreateOrderOptions = {}): Promise<OrderDetail> {
    const tenantId = ctx.tenant.tenantId;
    const key = input.idempotencyKey?.trim() || null;

    if (key) {
      const existing = await this.db.tx(tenantId, (tx) =>
        tx.salesOrder.findFirst({ where: { tenantId, idempotencyKey: key }, select: { id: true } }),
      );
      if (existing) {
        // El mismo pedido, no un error: la pantalla que reintenta recibe lo que ya se creó.
        return this.detail(ctx, existing.id);
      }
    }

    const orderId = await this.db.tx(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { taxRateBps: true, orderPrefix: true },
      });
      if (!tenant)
        throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Negocio no encontrado' });

      const warehouseId = await this.resolveOrderWarehouse(
        tx,
        ctx,
        input.warehouseId,
        options.guest === true,
      );
      const customer = await this.resolveCustomer(tx, tenantId, input);

      /**
       * El id se genera aquí, antes de reservar, para que cada movimiento de `RESERVA` apunte al
       * pedido que lo causó. El `stock_movement` es inmutable y no admite corrección posterior: si
       * la reserva se registrara contra un borrador, el ledger quedaría con piezas apartadas que
       * nadie puede rastrear hasta una venta.
       */
      const orderId = randomUUID();

      /**
       * Folio con `UPDATE ... RETURNING`: dos vendedores cobrando al mismo tiempo no pueden recibir
       * el mismo número. Leer el máximo y sumar uno los repetiría justo en la hora pico.
       */
      const [seq] = await tx.$queryRaw<{ number: number }[]>`
        UPDATE "tenant" SET "orderSeq" = "orderSeq" + 1
        WHERE "id" = ${tenantId}
        RETURNING "orderSeq" AS "number"`;
      const number = Number(seq?.number ?? 0);
      if (!number) throw new ConflictException({ code: 'ORDER_SEQ_FAILED', message: 'Intenta de nuevo' });

      const lines = await this.resolveLines(tx, ctx, input, warehouseId, orderId, options);

      const totals = lines.reduce(
        (acc, l) => ({
          totalCents: acc.totalCents + l.totalCents,
          discountCents: acc.discountCents + l.discountCents,
        }),
        { totalCents: 0, discountCents: 0 },
      );
      const base = Math.round((totals.totalCents * 10_000) / (10_000 + tenant.taxRateBps));

      const status = deriveOrderStatus(lines.map((l) => ({ status: l.status, quantity: l.quantity })));

      const order = await tx.salesOrder.create({
        data: {
          id: orderId,
          tenantId,
          number,
          customerId: customer?.id ?? null,
          customerName: customer?.name ?? input.customerName?.trim() ?? 'Cliente',
          customerPhone: input.customerPhone
            ? (normalizeGtPhone(input.customerPhone) ?? input.customerPhone.trim())
            : (customer?.phone ?? null),
          customerTaxId: input.customerTaxId?.trim() || null,
          channel: input.channel as never,
          status: status as never,
          // `null` en un pedido de invitado: no hay empleado que lo haya capturado.
          sellerId: options.guest ? null : ctx.user.id,
          warehouseId,
          sourceSlug: options.sourceSlug ?? null,
          subtotalCents: base,
          taxCents: totals.totalCents - base,
          discountCents: totals.discountCents,
          totalCents: totals.totalCents,
          notes: input.notes?.trim() || null,
          idempotencyKey: key,
          items: {
            create: lines.map((l) => ({
              tenantId,
              variantId: l.variantId,
              warehouseId: l.warehouseId,
              sku: l.sku,
              name: l.name,
              quantity: l.quantity,
              unitPriceCents: l.unitPriceCents,
              unitCostCents: l.unitCostCents,
              discountCents: l.discountCents,
              totalCents: l.totalCents,
              status: l.status as never,
              reservedUntil: lineHoldsReservation(l.status)
                ? new Date(Date.now() + RESERVATION_TTL_MS)
                : null,
            })),
          },
        },
        select: { id: true },
      });

      await this.event(
        tx,
        tenantId,
        order.id,
        'CREADO',
        {
          code: orderCode(tenant.orderPrefix, number),
          lines: lines.length,
          sinStock: lines.filter((l) => l.status === 'SIN_STOCK').length,
          total: totals.totalCents,
          /** En la vitrina queda registrado qué canal lo originó; en mostrador, ninguno. */
          ...(options.sourceSlug ? { source: `catalogo:${options.sourceSlug}` } : {}),
        },
        options.guest ? null : ctx.user.id,
      );

      await audit(tx, {
        tenantId,
        userId: options.guest ? null : ctx.user.id,
        action: options.guest ? 'orders.created_from_catalog' : 'orders.created',
        entity: 'sales_order',
        entityId: order.id,
        after: {
          code: orderCode(tenant.orderPrefix, number),
          total: totals.totalCents,
          lines: lines.length,
          ...(options.sourceSlug ? { source: `catalogo:${options.sourceSlug}` } : {}),
        },
        ip: ctx.ip,
      });

      return order.id;
    });

    /**
     * Aviso a bodega, después de confirmar la transacción.
     *
     * Se hace aquí y no dentro del `tx` porque un push o un socket no se revierten: si el aviso
     * saliera antes y la transacción fallara, el bodeguero correría a buscar una pieza que no está
     * apartada para nadie.
     */
    const detail = await this.detail(ctx, orderId);
    const pending = detail.lines
      .filter((l) => l.status === 'PENDIENTE' || l.status === 'EN_PREPARACION')
      .reduce((acc, l) => acc + l.quantity, 0);
    await this.notifier.orderArrived({
      tenantId,
      warehouseId: detail.warehouseId,
      orderId,
      code: detail.code,
      customerName: detail.customerName,
      pendingUnits: pending,
    });

    return detail;
  }

  // ───────────────────────────── Despacho por línea ─────────────────────────────

  /**
   * Mover una línea.
   *
   * `LISTO → ENTREGADO` es el único paso que toca la existencia física, y lo hace con
   * `inventory.commit`: consume la reserva y la pieza en un solo movimiento. Si el bodeguero
   * escanea una pieza que ya no está en el estante, la sentencia condicional falla, la transacción
   * se revierte y la línea sigue `LISTO` en vez de quedar entregada sin haber salido.
   *
   * `opId` es lo que hace idempotente a la cola offline: el teléfono reintenta la misma operación
   * cuando vuelve la señal y el servidor no la aplica dos veces. Sin él, un `LISTO → ENTREGADO`
   * repetido descontaría la pieza otra vez del estante.
   */
  async setLineStatus(
    ctx: Ctx,
    orderId: string,
    itemId: string,
    next: LineStatus,
    options: { opId?: string; scannedCode?: string | null } = {},
  ): Promise<OrderDetail> {
    const tenantId = ctx.tenant.tenantId;

    const result = await this.db.tx(tenantId, async (tx) => {
      const applied = await this.applyLineChange(tx, ctx, orderId, itemId, next, options);
      return applied;
    });

    this.announce(tenantId, result);
    return this.detail(ctx, orderId);
  }

  /**
   * Aplica el cambio de una línea dentro de una transacción ya abierta.
   *
   * Está separado del envoltorio para que el despacho pueda hacer su propia transacción (con la
   * comprobación de escaneo y el registro de la operación) sin duplicar la lógica del ledger: la
   * pieza sale del estante por un solo camino, venga del mostrador o del pasillo.
   */
  async applyLineChange(
    tx: TxClient,
    ctx: Ctx,
    orderId: string,
    itemId: string,
    next: LineStatus,
    options: { opId?: string; scannedCode?: string | null } = {},
  ) {
    const tenantId = ctx.tenant.tenantId;

    /**
     * Operación ya aplicada. Se responde lo mismo que la primera vez, incluido el estado final de
     * la línea: el teléfono que reintenta no debe ver un error por algo que ya funcionó.
     */
    if (options.opId) {
      const previous = await tx.dispatchOp.findUnique({
        where: { tenantId_opId: { tenantId, opId: options.opId } },
        select: { itemId: true, outcome: true },
      });
      if (previous) {
        const current = await tx.salesOrderItem.findFirst({
          where: { id: itemId, orderId, tenantId },
          select: { sku: true, status: true },
        });
        return {
          orderId,
          itemId,
          code: '',
          status: (current?.status ?? null) as LineStatus | null,
          sku: current?.sku ?? '',
          derived: null,
          repeated: true,
        };
      }
    }

    const order = await this.lockOrder(tx, tenantId, orderId);
    if (order.status === 'CANCELADO') {
      throw new ConflictException({ code: 'ORDER_CANCELLED', message: 'Este pedido está cancelado' });
    }

    const item = await tx.salesOrderItem.findFirst({
      where: { id: itemId, orderId, tenantId },
      select: {
        id: true,
        variantId: true,
        warehouseId: true,
        sku: true,
        quantity: true,
        status: true,
      },
    });
    if (!item) throw new NotFoundException({ code: 'LINE_NOT_FOUND', message: 'Esa línea no existe' });

    const from = item.status as LineStatus;
    if (from === next) {
      await this.recordOp(tx, tenantId, ctx.user.id, orderId, itemId, next, options, 'APLICADO');
      return {
        orderId,
        itemId,
        code: order.code,
        status: from,
        sku: item.sku,
        derived: order.status as OrderStatus,
        repeated: true,
      };
    }
    if (!canTransitionLine(from, next)) {
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: `Una línea ${from.toLowerCase()} no puede pasar a ${next.toLowerCase()}`,
      });
    }

    const now = new Date();
    const patch: Prisma.SalesOrderItemUpdateInput = { status: next as never };

    if (next === 'LISTO') patch.preparedAt = now;
    if (next === 'ENTREGADO') {
      /**
       * La pieza sale. Se pide `commit` y no un `apply` suelto porque tiene que consumir la
       * reserva de ESTA línea: si se descontara solo la existencia, el número de reservado
       * quedaría inflado y las demás ventas verían la pieza como apartada para siempre.
       */
      await this.inventory.commit(tx, {
        tenantId,
        variantId: item.variantId,
        warehouseId: item.warehouseId,
        quantity: item.quantity,
        reason: `Venta ${order.code}: ${item.sku}`,
        refType: 'sales_order',
        refId: orderId,
        userId: ctx.user.id,
      });
      patch.deliveredAt = now;
      patch.reservedUntil = null;
    }

    if ((next === 'CANCELADO' || next === 'SIN_STOCK') && lineHoldsReservation(from)) {
      await this.inventory.release(tx, {
        tenantId,
        variantId: item.variantId,
        warehouseId: item.warehouseId,
        quantity: item.quantity,
        reason:
          next === 'CANCELADO' ? `Cancelación de línea en ${order.code}` : `Sin existencia en ${order.code}`,
        refType: 'sales_order',
        refId: orderId,
        userId: ctx.user.id,
      });
      patch.reservedUntil = null;
    }

    // Volver a pendiente vuelve a apartar la pieza: la línea se había quedado sin stock y ahora
    // sí llegó. Si ya no alcanza, sigue `SIN_STOCK` y se le dice al vendedor, no se promete.
    if (next === 'PENDIENTE' && from === 'SIN_STOCK') {
      const reserved = await this.inventory.tryReserve(tx, {
        tenantId,
        variantId: item.variantId,
        warehouseId: item.warehouseId,
        quantity: item.quantity,
        reason: `Reserva al recuperar existencia en ${order.code}`,
        refType: 'sales_order',
        refId: orderId,
        userId: ctx.user.id,
      });
      if (!reserved) {
        throw new ConflictException({
          code: 'OUT_OF_STOCK',
          message: 'Todavía no hay existencia suficiente para esa pieza',
        });
      }
      patch.reservedUntil = new Date(Date.now() + RESERVATION_TTL_MS);
    }

    await tx.salesOrderItem.update({ where: { id: itemId }, data: patch });

    const rest = await tx.salesOrderItem.findMany({
      where: { orderId },
      select: { status: true, quantity: true },
    });
    const derived = deriveOrderStatus(
      rest.map((l) => ({ status: l.status as LineStatus, quantity: l.quantity })),
    );

    await tx.salesOrder.update({
      where: { id: orderId },
      data: {
        status: derived as never,
        closedAt: derived === 'ENTREGADO' || derived === 'CANCELADO' ? (order.closedAt ?? now) : null,
      },
    });

    await this.event(
      tx,
      tenantId,
      orderId,
      options.opId ? DISPATCH_OP_EVENT : 'LINEA',
      { sku: item.sku, from, to: next, ...(options.opId ? { opId: options.opId } : {}) },
      ctx.user.id,
    );
    await this.recordOp(tx, tenantId, ctx.user.id, orderId, itemId, next, options, 'APLICADO');
    await audit(tx, {
      tenantId,
      userId: ctx.user.id,
      action: 'orders.line_status_changed',
      entity: 'sales_order',
      entityId: orderId,
      before: { status: order.status, line: from },
      after: { status: derived, line: next, sku: item.sku },
      ip: ctx.ip,
    });

    return {
      orderId,
      itemId,
      code: order.code,
      status: next,
      sku: item.sku,
      derived,
      repeated: false,
      warehouseId: item.warehouseId,
      from,
    };
  }

  /**
   * Deja constancia de la operación para que un reintento no la vuelva a aplicar.
   *
   * La escritura va aquí y no en el servicio de despacho porque `applyLineChange` es el único punto
   * donde el estado de la línea cambia: si se registrara afuera, un cambio hecho desde el mostrador
   * con `opId` quedaría sin memoria y el reintento lo repetiría.
   */
  private async recordOp(
    tx: TxClient,
    tenantId: string,
    userId: string,
    orderId: string,
    itemId: string,
    status: LineStatus,
    options: { opId?: string; scannedCode?: string | null },
    outcome: string,
  ) {
    if (!options.opId) return;
    await tx.dispatchOp.create({
      data: {
        tenantId,
        opId: options.opId,
        orderId,
        itemId,
        status,
        outcome,
        scannedCode: options.scannedCode ?? null,
        actorId: userId,
      },
    });
  }

  /**
   * Avisa a la bodega del cambio.
   *
   * Se hace después de confirmar la transacción: emitir antes le diría al teléfono que la pieza
   * salió cuando la transacción todavía podía revertirse por una reserva vencida.
   */
  private announce(tenantId: string, result: LineChangeResult) {
    if (!result.code) return;
    this.realtime.emitUpdate(tenantId, result.warehouseId ?? '', {
      orderId: result.orderId,
      code: result.code,
      status: (result.derived ?? 'EN_PREPARACION') as OrderStatus,
      warehouseId: result.warehouseId ?? '',
      line: { itemId: result.itemId, sku: result.sku, status: result.status as LineStatus },
      actorName: null,
      kind:
        result.derived === 'ENTREGADO' ? 'ENTREGADO' : result.derived === 'CANCELADO' ? 'CANCELADO' : 'LINEA',
      at: new Date().toISOString(),
    });
  }

  /** Cancelar el pedido entero: libera lo reservado línea por línea y deja de contar. */
  async cancel(ctx: Ctx, orderId: string, reason?: string): Promise<OrderDetail> {
    const tenantId = ctx.tenant.tenantId;

    await this.db.tx(tenantId, async (tx) => {
      const order = await this.lockOrder(tx, tenantId, orderId);
      if (order.status === 'CANCELADO') return;
      if (order.status === 'ENTREGADO') {
        throw new ConflictException({
          code: 'ORDER_DELIVERED',
          message: 'Un pedido entregado no se cancela: registra una devolución',
        });
      }

      const items = await tx.salesOrderItem.findMany({
        where: { orderId },
        select: { id: true, variantId: true, warehouseId: true, sku: true, quantity: true, status: true },
      });

      for (const item of items) {
        const status = item.status as LineStatus;
        if (!lineHoldsReservation(status)) continue;
        await this.inventory.release(tx, {
          tenantId,
          variantId: item.variantId,
          warehouseId: item.warehouseId,
          quantity: item.quantity,
          reason: `Cancelación de ${order.code}`,
          refType: 'sales_order',
          refId: orderId,
          userId: ctx.user.id,
        });
      }

      await tx.salesOrderItem.updateMany({
        where: { orderId, status: { notIn: ['ENTREGADO', 'CANCELADO'] as never[] } },
        data: { status: 'CANCELADO', reservedUntil: null },
      });

      await tx.salesOrder.update({
        where: { id: orderId },
        data: {
          status: 'CANCELADO',
          closedAt: new Date(),
          notes: reason?.trim()
            ? `${order.notes ? `${order.notes} · ` : ''}Cancelado: ${reason.trim()}`
            : order.notes,
        },
      });

      await this.event(tx, tenantId, orderId, 'CANCELADO', { reason: reason?.trim() || null }, ctx.user.id);
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'orders.cancelled',
        entity: 'sales_order',
        entityId: orderId,
        before: { status: order.status },
        after: { status: 'CANCELADO', reason: reason?.trim() || null },
        ip: ctx.ip,
      });
    });

    return this.detail(ctx, orderId);
  }

  // ───────────────────────────── Cobros ─────────────────────────────

  /**
   * Registrar un pago.
   *
   * No cambia el estado del pedido: cobrar no es entregar. Mezclarlos deja pedidos "entregados"
   * que nadie sacó de bodega y clientes que se van sin su pieza porque el sistema dice que ya salió.
   */
  async addPayment(ctx: Ctx, orderId: string, input: PaymentCreateData): Promise<OrderDetail> {
    const tenantId = ctx.tenant.tenantId;

    await this.db.tx(tenantId, async (tx) => {
      const order = await this.lockOrder(tx, tenantId, orderId);
      if (order.status === 'CANCELADO') {
        throw new ConflictException({ code: 'ORDER_CANCELLED', message: 'Este pedido está cancelado' });
      }

      const [paid] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT coalesce(sum("amountCents"), 0) AS "total"
        FROM "payment" WHERE "orderId" = ${orderId} AND "tenantId" = ${tenantId}`;
      const paidCents = Number(paid?.total ?? 0);
      if (paidCents + input.amountCents > order.totalCents) {
        throw new BadRequestException({
          code: 'OVERPAYMENT',
          message: 'El pago excede el total del pedido',
        });
      }

      const change =
        input.receivedCents !== undefined && input.receivedCents > input.amountCents
          ? input.receivedCents - input.amountCents
          : null;

      await tx.payment.create({
        data: {
          tenantId,
          orderId,
          method: input.method as never,
          amountCents: input.amountCents,
          receivedCents: input.receivedCents ?? null,
          changeCents: change,
          reference: input.reference?.trim() || null,
        },
      });

      await this.event(
        tx,
        tenantId,
        orderId,
        'PAGO',
        { method: input.method, amount: input.amountCents, change },
        ctx.user.id,
      );
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'orders.payment_added',
        entity: 'sales_order',
        entityId: orderId,
        after: { method: input.method, amount: input.amountCents },
        ip: ctx.ip,
      });
    });

    return this.detail(ctx, orderId);
  }

  // ───────────────────────────── Reservas vencidas ─────────────────────────────

  /**
   * Libera reservas vencidas.
   *
   * Una reserva sin vencimiento secuestra la pieza: el vendedor arma el pedido, el cliente se va a
   * "pensarlo" y la pieza queda invisible para todos hasta que alguien se acuerde de cancelarla.
   * Se libera solo lo que sigue en un estado que reserva; lo ya despachado no se toca.
   */
  async expireReservations(ctx: Ctx): Promise<{ released: number }> {
    const tenantId = ctx.tenant.tenantId;

    return this.db.tx(tenantId, async (tx) => {
      const stale = await tx.salesOrderItem.findMany({
        where: {
          tenantId,
          reservedUntil: { lt: new Date() },
          status: { in: ['PENDIENTE', 'EN_PREPARACION', 'LISTO'] as never[] },
        },
        select: { id: true, orderId: true, variantId: true, warehouseId: true, quantity: true, sku: true },
        take: 500,
      });

      let released = 0;
      const touchedOrders = new Set<string>();

      for (const item of stale) {
        await this.inventory.release(tx, {
          tenantId,
          variantId: item.variantId,
          warehouseId: item.warehouseId,
          quantity: item.quantity,
          reason: 'Reserva vencida',
          refType: 'sales_order',
          refId: item.orderId,
          userId: ctx.user.id,
        });
        await tx.salesOrderItem.update({
          where: { id: item.id },
          data: { status: 'SIN_STOCK', reservedUntil: null },
        });
        released += 1;
        touchedOrders.add(item.orderId);
      }

      for (const orderId of touchedOrders) {
        const rest = await tx.salesOrderItem.findMany({
          where: { orderId },
          select: { status: true, quantity: true },
        });
        const derived = deriveOrderStatus(
          rest.map((l) => ({ status: l.status as LineStatus, quantity: l.quantity })),
        );
        await tx.salesOrder.update({ where: { id: orderId }, data: { status: derived as never } });
        await this.event(tx, tenantId, orderId, 'RESERVA_VENCIDA', { released }, ctx.user.id);
      }

      return { released };
    });
  }

  // ───────────────────────────── Auxiliares ─────────────────────────────

  /**
   * Piezas para armar una venta.
   *
   * Devuelve las que no tienen existencia también, a propósito: el vendedor necesita decir "no la
   * tengo, se la consigo mañana" en vez de que la pieza no exista en su pantalla. Lo que cambia es
   * la disponibilidad, no la existencia del catálogo.
   */
  async variantOptions(ctx: Ctx, args: { q: string; warehouseId?: string; limit: number }) {
    const tenantId = ctx.tenant.tenantId;
    const term = args.q.trim();
    const like = `%${term}%`;
    const warehouseId = args.warehouseId ?? null;
    const limit = Math.min(Math.max(args.limit, 1), 50);
    const allowed = ctx.tenant.warehouseIds;
    const canSeeCost = ctx.tenant.permissions.has('catalog.cost.view');

    const rows = await this.db.tx(
      tenantId,
      (tx) =>
        tx.$queryRaw<
          Array<{
            variantId: string;
            partId: string;
            partName: string;
            title: string;
            sku: string;
            partNumber: string | null;
            unit: string;
            priceCents: number;
            costCents: number;
            onHand: number;
            reserved: number;
            binLocation: string | null;
            warehouseId: string | null;
            warehouseCode: string | null;
          }>
        >`
        SELECT v."id" AS "variantId", p."id" AS "partId", p."name" AS "partName", v."title",
               v."sku", v."partNumber", p."unit", v."priceCents", v."costCents",
               coalesce(l."onHand", 0) AS "onHand", coalesce(l."reserved", 0) AS "reserved",
               l."binLocation", l."warehouseId", w."code" AS "warehouseCode"
        FROM "part_variant" v
        JOIN "part" p ON p."id" = v."partId"
        LEFT JOIN LATERAL (
          SELECT lv.* FROM "inventory_level" lv
          JOIN "warehouse" w2 ON w2."id" = lv."warehouseId" AND w2."isActive"
          WHERE lv."variantId" = v."id"
            AND (${warehouseId}::text IS NULL OR lv."warehouseId" = ${warehouseId}::text)
            AND (${allowed.length === 0}::boolean OR lv."warehouseId" = ANY(${allowed}::text[]))
          ORDER BY (lv."onHand" - lv."reserved") DESC, w2."isDefault" DESC
          LIMIT 1
        ) l ON TRUE
        LEFT JOIN "warehouse" w ON w."id" = l."warehouseId"
        WHERE v."tenantId" = ${tenantId} AND v."isActive" AND p."status" = 'ACTIVO'
          AND (${term === ''}::boolean
               OR v."sku" ILIKE ${like}
               OR p."name" ILIKE ${like}
               OR coalesce(v."partNumber", '') ILIKE ${like}
               OR EXISTS (SELECT 1 FROM unnest(v."oemNumbers") AS oem
                          WHERE replace(oem, '-', '') ILIKE ${like}))
        ORDER BY p."name", v."position", v."sku"
        LIMIT ${limit}`,
    );

    return rows.map((r) => ({
      variantId: r.variantId,
      partId: r.partId,
      partName: r.partName,
      title: r.title,
      sku: r.sku,
      partNumber: r.partNumber,
      unit: r.unit,
      priceCents: r.priceCents,
      costCents: canSeeCost ? r.costCents : null,
      onHand: Number(r.onHand),
      reserved: Number(r.reserved),
      available: Number(r.onHand) - Number(r.reserved),
      binLocation: r.binLocation,
      warehouseId: r.warehouseId,
      warehouseCode: r.warehouseCode,
    }));
  }

  /**
   * Bloquea la cabecera durante la transacción.
   *
   * Sin `FOR UPDATE`, dos bodegueros tocando líneas distintas del mismo pedido leen ambos el estado
   * viejo y el último `UPDATE` de cabecera pisa al primero: el pedido queda "en preparación" con
   * todas las líneas entregadas.
   */
  private async lockOrder(tx: TxClient, tenantId: string, orderId: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        number: number;
        code: string;
        status: string;
        notes: string | null;
        totalCents: number;
        closedAt: Date | null;
        warehouseId: string;
      }>
    >`
      SELECT o."id", o."number", o."status"::text AS "status", o."notes", o."totalCents",
             o."closedAt", o."warehouseId",
             t."orderPrefix" || '-' || lpad(o."number"::text, 4, '0') AS "code"
      FROM "sales_order" o
      JOIN "tenant" t ON t."id" = o."tenantId"
      WHERE o."id" = ${orderId} AND o."tenantId" = ${tenantId}
      FOR UPDATE OF o`;
    const order = rows[0];
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Ese pedido no existe' });
    return order;
  }

  /**
   * Bodega del pedido.
   *
   * `onlyOnline` es la vitrina: solo una bodega con `sellsOnline` puede recibir un pedido de un
   * cliente web. Si ninguna lo está, el pedido se rechaza aquí y no en la bodega, donde alguien
   * tendría que llamar al cliente para decirle que no.
   */
  private async resolveOrderWarehouse(
    tx: TxClient,
    ctx: Ctx,
    requested: string | undefined,
    onlyOnline = false,
  ): Promise<string> {
    if (requested) {
      if (!canAccessWarehouse(ctx.tenant, requested)) {
        throw new NotFoundException({
          code: 'WAREHOUSE_NOT_FOUND',
          message: 'No tienes acceso a esa bodega',
        });
      }
      const exists = await tx.warehouse.findFirst({
        where: { id: requested, tenantId: ctx.tenant.tenantId, isActive: true },
        select: { id: true },
      });
      if (!exists)
        throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Esa bodega no existe' });
      return requested;
    }

    const allowed = ctx.tenant.warehouseIds;
    const fallback = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "warehouse"
      WHERE "tenantId" = ${ctx.tenant.tenantId} AND "isActive"
        AND (${onlyOnline}::boolean = false OR "sellsOnline")
        AND (${allowed.length === 0}::boolean OR "id" = ANY(${allowed}::text[]))
      ORDER BY "isDefault" DESC, "name" ASC
      LIMIT 1`;
    if (!fallback[0]) {
      throw new BadRequestException({
        code: 'NO_WAREHOUSE',
        message: 'No hay una bodega activa donde registrar la venta',
      });
    }
    return fallback[0].id;
  }

  private async resolveCustomer(tx: TxClient, tenantId: string, input: OrderCreateData) {
    if (input.customerId) {
      const found = await tx.customer.findFirst({
        where: { id: input.customerId, tenantId },
        select: { id: true, name: true, phone: true },
      });
      if (!found)
        throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Ese cliente no existe' });
      return found;
    }

    /**
     * El teléfono se guarda en E.164 (`+50255558899`) porque es lo que exige `wa.me` y lo que hace
     * que el mismo cliente se reconozca venga escrito como venga: "5555-8899", "+502 5555 8899" y
     * "50255558899" son la misma persona. Si no parece guatemalteco se guarda tal cual: perder el
     * número que el vendedor apuntó es peor que no poder abrir WhatsApp con él.
     */
    const rawPhone = input.customerPhone?.trim() || null;
    const phone = rawPhone ? (normalizeGtPhone(rawPhone) ?? rawPhone) : null;
    const name = input.customerName?.trim();
    if (!name) return null;

    /**
     * Cliente por teléfono: en mostrador se repite el mismo señor cada mes y crear uno nuevo por
     * venta deja el historial partido en veinte "Juan Pérez". Si ya existe con ese teléfono, se
     * reutiliza —y se actualiza el nombre si venía vacío—, nunca se duplica.
     */
    if (phone) {
      const existing = await tx.customer.findFirst({
        where: { tenantId, phone },
        select: { id: true, name: true, phone: true },
      });
      if (existing) return existing;
    }

    return tx.customer.create({
      data: {
        tenantId,
        name,
        phone,
        email: null,
        taxId: input.customerTaxId?.trim() || null,
      },
      select: { id: true, name: true, phone: true },
    });
  }

  /**
   * Convierte las líneas del formulario en líneas de pedido, reservando lo que se pueda.
   *
   * La búsqueda de existencia es por variante y bodega: si el vendedor no eligió bodega, se toma la
   * que tenga más disponible, que es la que el bodeguero va a encontrar sin caminar a otra sucursal.
   */
  private async resolveLines(
    tx: TxClient,
    ctx: Ctx,
    input: OrderCreateData,
    defaultWarehouseId: string,
    orderId: string,
    options: CreateOrderOptions = {},
  ): Promise<ResolvedLine[]> {
    const tenantId = ctx.tenant.tenantId;
    const ids = input.items.map((i) => i.variantId);
    const canOverride =
      !options.lockPrice &&
      ctx.tenant.permissions.has('orders.price.override') &&
      ctx.tenant.permissions.has('orders.create');

    const variants = await tx.partVariant.findMany({
      where: { id: { in: ids }, tenantId, isActive: true },
      select: {
        id: true,
        sku: true,
        title: true,
        priceCents: true,
        costCents: true,
        part: { select: { name: true, unit: true, status: true } },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));

    const lines: ResolvedLine[] = [];
    for (const item of input.items) {
      const variant = byId.get(item.variantId);
      if (variant?.part.status !== 'ACTIVO') {
        throw new NotFoundException({
          code: 'VARIANT_NOT_FOUND',
          message: 'Alguna pieza no existe o está archivada',
        });
      }

      const requestedPrice = options.lockPrice ? undefined : item.unitPriceCents;
      if (requestedPrice !== undefined && requestedPrice !== variant.priceCents && !canOverride) {
        throw new ForbiddenException({
          code: 'PRICE_OVERRIDE_FORBIDDEN',
          message: 'No tienes permiso para cambiar el precio',
        });
      }
      const allowed = ctx.tenant.warehouseIds;
      /**
       * La vitrina solo puede prometer lo que la bodega marcó como vendible en línea. Sin esto, un
       * cliente pediría desde la página una pieza que está en el mostrador de una sucursal cerrada
       * o reservada para otro canal, y el bodeguero tendría que cancelarle el pedido por teléfono.
       */
      const onlyOnline = options.guest === true;
      let warehouseId = item.warehouseId ?? defaultWarehouseId;
      if (item.warehouseId && !canAccessWarehouse(ctx.tenant, item.warehouseId)) {
        throw new NotFoundException({
          code: 'WAREHOUSE_NOT_FOUND',
          message: 'No tienes acceso a esa bodega',
        });
      }
      if (!item.warehouseId) {
        const best = await tx.$queryRaw<Array<{ warehouseId: string; available: number }>>`
          SELECT l."warehouseId", (l."onHand" - l."reserved") AS "available"
          FROM "inventory_level" l
          JOIN "warehouse" w ON w."id" = l."warehouseId" AND w."isActive"
          WHERE l."variantId" = ${item.variantId} AND l."tenantId" = ${tenantId}
            AND (l."onHand" - l."reserved") >= ${item.quantity}
            AND (${onlyOnline}::boolean = false OR w."sellsOnline")
            AND (${allowed.length === 0}::boolean OR l."warehouseId" = ANY(${allowed}::text[]))
          ORDER BY (l."onHand" - l."reserved") DESC, w."isDefault" DESC
          LIMIT 1`;
        if (best[0]) warehouseId = best[0].warehouseId;
      }

      const unitPriceCents = requestedPrice ?? variant.priceCents;
      const discountCents = Math.min(item.discountCents ?? 0, unitPriceCents * item.quantity);
      const totalCents = unitPriceCents * item.quantity - discountCents;

      /**
       * El grupo (variante, bodega) es la única clave de la reserva. La sentencia condicional dentro
       * de `tryReserve` decide si alcanza; aquí solo se traduce "no alcanzó" a `SIN_STOCK`, que es
       * información para el vendedor y no un error que tumbe la venta entera.
       */
      const reserved = await this.inventory.tryReserve(tx, {
        tenantId,
        variantId: item.variantId,
        warehouseId,
        quantity: item.quantity,
        reason: `Reserva de venta (${variant.sku})`,
        refType: 'sales_order',
        refId: orderId,
        userId: ctx.user.id,
      });

      lines.push({
        variantId: item.variantId,
        sku: variant.sku,
        name: variant.part.name,
        variantTitle: variant.title,
        unit: variant.part.unit,
        quantity: item.quantity,
        unitPriceCents,
        unitCostCents: variant.costCents,
        discountCents,
        totalCents,
        warehouseId,
        status: reserved ? 'PENDIENTE' : 'SIN_STOCK',
      });
    }

    return lines;
  }

  /** Nombre de pieza, unidad y ubicación de cada variante, para pintar el pedido. */
  private async variantInfo(tx: TxClient, variantIds: string[], allowed: string[]) {
    if (!variantIds.length)
      return new Map<
        string,
        { variantTitle: string; unit: string; warehouseCode: string; binLocation: string | null }
      >();
    const rows = await tx.$queryRaw<
      Array<{
        variantId: string;
        variantTitle: string;
        unit: string;
        warehouseCode: string;
        binLocation: string | null;
      }>
    >`
      SELECT v."id" AS "variantId", v."title" AS "variantTitle", p."unit",
             coalesce(w."code", '') AS "warehouseCode", l."binLocation"
      FROM "part_variant" v
      JOIN "part" p ON p."id" = v."partId"
      LEFT JOIN LATERAL (
        SELECT lv."warehouseId", lv."binLocation"
        FROM "inventory_level" lv
        JOIN "warehouse" w2 ON w2."id" = lv."warehouseId"
        WHERE lv."variantId" = v."id"
          AND (${allowed.length === 0}::boolean OR lv."warehouseId" = ANY(${allowed}::text[]))
        ORDER BY (lv."onHand" - lv."reserved") DESC, w2."isDefault" DESC
        LIMIT 1
      ) l ON TRUE
      LEFT JOIN "warehouse" w ON w."id" = l."warehouseId"
      WHERE v."id" = ANY(${variantIds}::text[])`;
    return new Map(rows.map((r) => [r.variantId, r]));
  }

  private async actorNames(tx: TxClient, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async event(
    tx: TxClient,
    tenantId: string,
    orderId: string,
    type: string,
    detail: Record<string, unknown>,
    actorId: string | null,
  ) {
    await tx.orderEvent.create({
      data: { tenantId, orderId, type, detail: detail as never, actorId },
    });
  }

  private nextFor(status: OrderStatus, lines: OrderLineRow[]) {
    if (status === 'ABIERTO' && lines.some((l) => l.status === 'SIN_STOCK')) {
      return { label: 'Conseguir la pieza que falta', permission: 'inventory.transfer' };
    }
    return status === 'ENTREGADO' || status === 'CANCELADO'
      ? null
      : { label: 'Preparar en bodega', permission: 'orders.dispatch' };
  }

  private toSummary(r: {
    id: string;
    number: number;
    status: string;
    channel: string;
    customerName: string;
    customerPhone: string | null;
    customerId: string | null;
    warehouseId: string;
    warehouseCode: string;
    totalCents: number;
    createdAt: Date;
    closedAt: Date | null;
    sellerName: string;
    orderPrefix?: string;
    lineCount: bigint | number;
    units: bigint | number;
    pendingUnits: bigint | number;
    paidCents: bigint | number;
  }): OrderSummary {
    const paidCents = Number(r.paidCents);
    return {
      id: r.id,
      number: r.number,
      code: orderCode(r.orderPrefix ?? 'PD', r.number),
      status: r.status as OrderStatus,
      channel: r.channel as OrderChannel,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      customer: r.customerId ? { id: r.customerId, name: r.customerName, phone: r.customerPhone } : null,
      warehouseId: r.warehouseId,
      warehouseCode: r.warehouseCode,
      totalCents: r.totalCents,
      paidCents,
      lineCount: Number(r.lineCount),
      units: Number(r.units),
      pendingUnits: Number(r.pendingUnits),
      createdAt: new Date(r.createdAt).toISOString(),
      closedAt: r.closedAt ? new Date(r.closedAt).toISOString() : null,
      sellerName: r.sellerName,
      balanceCents: r.totalCents - paidCents,
    };
  }
}
