import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  canTransitionTransfer,
  type StockTransferDetail,
  type StockTransferSummary,
  type TransferCreateData,
  type TransferItemRow,
  type TransferListQuery,
  type TransferListResponse,
  type TransferReceiveData,
  type TransferStatusKey,
  transferCode,
} from '@partops/contracts';
import type { TxClient } from '@partops/db';
import { audit } from '../../common/audit.js';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { InventoryService } from './inventory.service.js';

/**
 * Traslados entre bodegas.
 *
 * El ciclo es `SOLICITADO → ENVIADO → RECIBIDO`, y cada paso mueve existencia en un momento
 * distinto a propósito:
 *
 *  - **Solicitar** no toca nada. Es una nota: "mándame 6 pastillas de la central". Si reservara,
 *    una solicitud olvidada dejaría piezas congeladas sin que nadie las vaya a mover.
 *  - **Enviar** saca la pieza del origen (`TRASLADO_SALIDA`). Desde ese instante ya no está en la
 *    bodega que la tenía; contarla ahí sería prometer lo que va en el camión.
 *  - **Recibir** la mete al destino (`TRASLADO_ENTRADA`), total o parcial. Lo que no llega sigue
 *    en tránsito y el traslado no se cierra: la diferencia tiene que verse, no perderse.
 *
 * Todo ocurre dentro de la transacción del traslado. Si el destino se cae a mitad, el origen
 * conserva su pieza y el folio no avanza.
 */
@Injectable()
export class TransferService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
  ) {}

  // ───────────────────────────── Lectura ─────────────────────────────

  async list(ctx: Ctx, query: TransferListQuery): Promise<TransferListResponse> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;
    const status = query.status ?? null;
    const warehouseId = query.warehouseId ?? null;
    const limit = Math.min(Math.max(query.limit, 1), 100);

    return this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          number: number;
          status: string;
          fromId: string;
          fromCode: string;
          fromName: string;
          toId: string;
          toCode: string;
          toName: string;
          notes: string | null;
          createdAt: Date;
          sentAt: Date | null;
          receivedAt: Date | null;
          createdByName: string | null;
          itemCount: bigint;
          units: bigint;
          pendingUnits: bigint;
        }>
      >`
        SELECT t."id", t."number", t."status"::text AS "status",
               fw."id" AS "fromId", fw."code" AS "fromCode", fw."name" AS "fromName",
               tw."id" AS "toId", tw."code" AS "toCode", tw."name" AS "toName",
               t."notes", t."createdAt", t."sentAt", t."receivedAt",
               u."name" AS "createdByName",
               (SELECT count(*) FROM "stock_transfer_item" i WHERE i."transferId" = t."id") AS "itemCount",
               (SELECT coalesce(sum(i."quantity"), 0) FROM "stock_transfer_item" i
                  WHERE i."transferId" = t."id") AS "units",
               (SELECT coalesce(sum(i."quantity" - i."receivedQty"), 0) FROM "stock_transfer_item" i
                  WHERE i."transferId" = t."id") AS "pendingUnits"
        FROM "stock_transfer" t
        JOIN "warehouse" fw ON fw."id" = t."fromWarehouseId"
        JOIN "warehouse" tw ON tw."id" = t."toWarehouseId"
        LEFT JOIN "user" u ON u."id" = t."createdById"
        WHERE t."tenantId" = ${tenantId}
          AND (${status}::text IS NULL OR t."status"::text = ${status}::text)
          AND (${warehouseId}::text IS NULL
               OR t."fromWarehouseId" = ${warehouseId}::text
               OR t."toWarehouseId" = ${warehouseId}::text)
          AND (${allowed.length === 0}::boolean
               OR t."fromWarehouseId" = ANY(${allowed}::text[])
               OR t."toWarehouseId" = ANY(${allowed}::text[]))
        ORDER BY t."createdAt" DESC, t."number" DESC
        LIMIT ${limit}`;

      return {
        items: rows.map((r) => this.toSummary(r)),
        total: rows.length,
      };
    });
  }

  async detail(ctx: Ctx, transferId: string): Promise<StockTransferDetail> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;

    return this.db.tx(tenantId, async (tx) => {
      const [head] = await tx.$queryRaw<
        Array<{
          id: string;
          number: number;
          status: string;
          fromId: string;
          fromCode: string;
          fromName: string;
          toId: string;
          toCode: string;
          toName: string;
          notes: string | null;
          createdAt: Date;
          sentAt: Date | null;
          receivedAt: Date | null;
          createdByName: string | null;
          itemCount: bigint;
          units: bigint;
          pendingUnits: bigint;
        }>
      >`
        SELECT t."id", t."number", t."status"::text AS "status",
               fw."id" AS "fromId", fw."code" AS "fromCode", fw."name" AS "fromName",
               tw."id" AS "toId", tw."code" AS "toCode", tw."name" AS "toName",
               t."notes", t."createdAt", t."sentAt", t."receivedAt",
               u."name" AS "createdByName",
               (SELECT count(*) FROM "stock_transfer_item" i WHERE i."transferId" = t."id") AS "itemCount",
               (SELECT coalesce(sum(i."quantity"), 0) FROM "stock_transfer_item" i
                  WHERE i."transferId" = t."id") AS "units",
               (SELECT coalesce(sum(i."quantity" - i."receivedQty"), 0) FROM "stock_transfer_item" i
                  WHERE i."transferId" = t."id") AS "pendingUnits"
        FROM "stock_transfer" t
        JOIN "warehouse" fw ON fw."id" = t."fromWarehouseId"
        JOIN "warehouse" tw ON tw."id" = t."toWarehouseId"
        LEFT JOIN "user" u ON u."id" = t."createdById"
        WHERE t."id" = ${transferId} AND t."tenantId" = ${tenantId}
          AND (${allowed.length === 0}::boolean
               OR t."fromWarehouseId" = ANY(${allowed}::text[])
               OR t."toWarehouseId" = ANY(${allowed}::text[]))`;

      if (!head)
        throw new NotFoundException({ code: 'TRANSFER_NOT_FOUND', message: 'Ese traslado no existe' });

      const items = await tx.$queryRaw<
        Array<{
          id: string;
          variantId: string;
          sku: string;
          partName: string;
          variantTitle: string;
          unit: string;
          quantity: number;
          receivedQty: number;
        }>
      >`
        SELECT i."id", i."variantId", v."sku", p."name" AS "partName",
               v."title" AS "variantTitle", p."unit" AS "unit",
               i."quantity", i."receivedQty"
        FROM "stock_transfer_item" i
        JOIN "part_variant" v ON v."id" = i."variantId"
        JOIN "part" p ON p."id" = v."partId"
        WHERE i."transferId" = ${transferId}
        ORDER BY p."name", v."sku"`;

      return {
        ...this.toSummary(head),
        pendingUnits: Number(head.pendingUnits),
        items: items.map(
          (i): TransferItemRow => ({
            id: i.id,
            variantId: i.variantId,
            sku: i.sku,
            partName: i.partName,
            variantTitle: i.variantTitle,
            unit: i.unit,
            quantity: Number(i.quantity),
            receivedQty: Number(i.receivedQty),
            pending: Number(i.quantity) - Number(i.receivedQty),
          }),
        ),
      };
    });
  }

  // ───────────────────────────── Escritura ─────────────────────────────

  async create(ctx: Ctx, input: TransferCreateData): Promise<StockTransferDetail> {
    const tenantId = ctx.tenant.tenantId;
    this.assertWarehouse(ctx, input.fromWarehouseId);
    this.assertWarehouse(ctx, input.toWarehouseId);

    const id = await this.db.tx(tenantId, async (tx) => {
      // Las dos bodegas tienen que ser del negocio. Se comprueban dentro de la transacción porque
      // un id de otra empresa no debe ni distinguirse de uno inexistente.
      const warehouses = await tx.warehouse.findMany({
        where: { id: { in: [input.fromWarehouseId, input.toWarehouseId] }, isActive: true },
        select: { id: true },
      });
      if (warehouses.length !== 2)
        throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Esa bodega no existe' });

      const variants = await tx.partVariant.findMany({
        where: { id: { in: input.items.map((i) => i.variantId) } },
        select: { id: true },
      });
      if (variants.length !== input.items.length)
        throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Alguna pieza no existe' });

      /**
       * Folio con `UPDATE ... RETURNING`: dos bodegueros creando traslados al mismo tiempo no
       * pueden recibir el mismo número. Leer el máximo y sumarle uno sí los repetiría.
       */
      const [seq] = await tx.$queryRaw<{ number: number }[]>`
        UPDATE "tenant" SET "transferSeq" = "transferSeq" + 1
        WHERE "id" = ${tenantId}
        RETURNING "transferSeq" AS "number"`;
      const number = Number(seq?.number ?? 0);
      if (!number) throw new ConflictException({ code: 'TRANSFER_SEQ_FAILED', message: 'Intenta de nuevo' });

      const transfer = await tx.stockTransfer.create({
        data: {
          tenantId,
          number,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          notes: input.notes?.trim() || null,
          createdById: ctx.user.id,
          items: {
            create: input.items.map((i) => ({
              tenantId,
              variantId: i.variantId,
              quantity: i.quantity,
            })),
          },
        },
        select: { id: true },
      });

      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'inventory.transfer_created',
        entity: 'stock_transfer',
        entityId: transfer.id,
        after: {
          code: transferCode(number),
          from: input.fromWarehouseId,
          to: input.toWarehouseId,
          items: input.items.length,
        },
        ip: ctx.ip,
      });

      return transfer.id;
    });

    return this.detail(ctx, id);
  }

  /** Despacho: la pieza sale del origen. Aquí es donde puede faltar existencia. */
  async send(ctx: Ctx, transferId: string): Promise<StockTransferDetail> {
    const tenantId = ctx.tenant.tenantId;

    await this.db.tx(tenantId, async (tx) => {
      const transfer = await this.lockTransfer(tx, tenantId, transferId);
      this.assertTransition(transfer.status as TransferStatusKey, 'ENVIADO');
      this.assertWarehouse(ctx, transfer.fromWarehouseId);

      const items = await tx.stockTransferItem.findMany({
        where: { transferId },
        select: { variantId: true, quantity: true },
      });
      if (!items.length)
        throw new BadRequestException({ code: 'TRANSFER_EMPTY', message: 'El traslado no tiene piezas' });

      /**
       * Se mueve pieza por pieza con el `apply` condicional. Si una no alcanza, la excepción revierte
       * toda la transacción y ninguna sale: un traslado a medias es peor que uno rechazado, porque
       * el origen queda con huecos que nadie sabe explicar.
       */
      for (const item of items) {
        await this.inventory.apply(tx, {
          tenantId,
          variantId: item.variantId,
          warehouseId: transfer.fromWarehouseId,
          onHandDelta: -item.quantity,
          type: 'TRASLADO_SALIDA',
          reason: `Traslado ${transferCode(transfer.number)} a ${transfer.toCode}`,
          refType: 'stock_transfer',
          refId: transferId,
          userId: ctx.user.id,
        });
      }

      await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: 'ENVIADO', sentAt: new Date() },
      });

      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'inventory.transfer_sent',
        entity: 'stock_transfer',
        entityId: transferId,
        before: { status: transfer.status },
        after: { status: 'ENVIADO', items: items.length },
        ip: ctx.ip,
      });
    });

    return this.detail(ctx, transferId);
  }

  /**
   * Recepción, total o parcial.
   *
   * Sin `items` se recibe todo lo pendiente, que es el caso normal: el bodeguero cuenta las cajas, ve
   * que llegaron todas y confirma. Con cantidades, cada línea puede recibir menos y el resto sigue en
   * tránsito; el traslado no se marca `RECIBIDO` hasta que no quede nada pendiente.
   */
  async receive(ctx: Ctx, transferId: string, input: TransferReceiveData): Promise<StockTransferDetail> {
    const tenantId = ctx.tenant.tenantId;

    await this.db.tx(tenantId, async (tx) => {
      const transfer = await this.lockTransfer(tx, tenantId, transferId);
      if (transfer.status === 'RECIBIDO')
        throw new ConflictException({
          code: 'TRANSFER_ALREADY_RECEIVED',
          message: 'Este traslado ya se recibió',
        });
      this.assertTransition(transfer.status as TransferStatusKey, 'RECIBIDO');
      this.assertWarehouse(ctx, transfer.toWarehouseId);

      const items = await tx.stockTransferItem.findMany({
        where: { transferId },
        select: { id: true, variantId: true, quantity: true, receivedQty: true },
      });

      /**
       * Cantidades a recibir por línea. Un id que no pertenece al traslado se ignora: recibir contra
       * una línea ajena metería existencia de otra pieza y el error aparecería días después.
       */
      const requested = new Map<string, number>();
      for (const entry of input.items ?? []) {
        requested.set(entry.itemId, (requested.get(entry.itemId) ?? 0) + entry.quantity);
      }

      let receivedUnits = 0;
      for (const item of items) {
        const pending = item.quantity - item.receivedQty;
        const qty = requested.size === 0 ? pending : Math.min(requested.get(item.id) ?? 0, pending);
        if (qty <= 0) continue;

        await this.inventory.apply(tx, {
          tenantId,
          variantId: item.variantId,
          warehouseId: transfer.toWarehouseId,
          onHandDelta: qty,
          type: 'TRASLADO_ENTRADA',
          reason: `Recepción de traslado ${transferCode(transfer.number)}`,
          refType: 'stock_transfer',
          refId: transferId,
          userId: ctx.user.id,
        });

        await tx.stockTransferItem.update({
          where: { id: item.id },
          data: { receivedQty: { increment: qty } },
        });
        receivedUnits += qty;
      }

      if (receivedUnits === 0)
        throw new BadRequestException({
          code: 'NOTHING_TO_RECEIVE',
          message: 'No hay unidades pendientes por recibir en este traslado',
        });

      const stillPending = await tx.stockTransferItem.aggregate({
        where: { transferId },
        _sum: { quantity: true, receivedQty: true },
      });
      const pending = (stillPending._sum?.quantity ?? 0) - (stillPending._sum?.receivedQty ?? 0);
      const closed = pending <= 0;

      await tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          status: closed ? 'RECIBIDO' : 'ENVIADO',
          receivedAt: closed ? new Date() : null,
          notes: input.notes?.trim() ? input.notes.trim() : transfer.notes,
        },
      });

      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: closed ? 'inventory.transfer_received' : 'inventory.transfer_partially_received',
        entity: 'stock_transfer',
        entityId: transferId,
        before: { status: transfer.status },
        after: { status: closed ? 'RECIBIDO' : 'ENVIADO', receivedUnits, pending },
        ip: ctx.ip,
      });
    });

    return this.detail(ctx, transferId);
  }

  /**
   * Cancelar.
   *
   * Solo un traslado ya despachado devuelve existencia: la que salió del origen y todavía no llegó
   * al destino vuelve a su bodega con su propio movimiento de entrada. Un traslado solo solicitado
   * se cancela sin tocar el ledger, porque nunca movió nada.
   */
  async cancel(ctx: Ctx, transferId: string, reason?: string): Promise<StockTransferDetail> {
    const tenantId = ctx.tenant.tenantId;

    await this.db.tx(tenantId, async (tx) => {
      const transfer = await this.lockTransfer(tx, tenantId, transferId);
      this.assertTransition(transfer.status as TransferStatusKey, 'CANCELADO');
      this.assertWarehouse(ctx, transfer.fromWarehouseId);

      if (transfer.status === 'ENVIADO') {
        const items = await tx.stockTransferItem.findMany({
          where: { transferId },
          select: { variantId: true, quantity: true, receivedQty: true },
        });
        for (const item of items) {
          const inTransit = item.quantity - item.receivedQty;
          if (inTransit <= 0) continue;
          await this.inventory.apply(tx, {
            tenantId,
            variantId: item.variantId,
            warehouseId: transfer.fromWarehouseId,
            onHandDelta: inTransit,
            type: 'TRASLADO_ENTRADA',
            reason: `Cancelación de traslado ${transferCode(transfer.number)}: vuelve lo que estaba en tránsito`,
            refType: 'stock_transfer',
            refId: transferId,
            userId: ctx.user.id,
          });
        }
      }

      await tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          status: 'CANCELADO',
          notes: reason?.trim()
            ? `${transfer.notes ? `${transfer.notes} · ` : ''}Cancelado: ${reason.trim()}`
            : transfer.notes,
        },
      });

      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'inventory.transfer_cancelled',
        entity: 'stock_transfer',
        entityId: transferId,
        before: { status: transfer.status },
        after: { status: 'CANCELADO', reason: reason?.trim() || null },
        ip: ctx.ip,
      });
    });

    return this.detail(ctx, transferId);
  }

  // ───────────────────────────── Auxiliares ─────────────────────────────

  /**
   * Bloquea la fila del traslado hasta el fin de la transacción.
   *
   * Sin el `FOR UPDATE`, dos bodegueros despachando a la vez leen ambos `SOLICITADO`, los dos pasan
   * la comprobación y la pieza sale dos veces del origen: el segundo `UPDATE` de estado sobrescribe
   * al primero sin que nadie lo note y el descuadre aparece al mes.
   */
  private async lockTransfer(tx: TxClient, tenantId: string, transferId: string) {
    const [transfer] = await tx.$queryRaw<
      Array<{
        id: string;
        number: number;
        status: string;
        fromWarehouseId: string;
        toWarehouseId: string;
        toCode: string;
        notes: string | null;
      }>
    >`
      SELECT t."id", t."number", t."status"::text AS "status", t."fromWarehouseId", t."toWarehouseId",
             tw."code" AS "toCode", t."notes"
      FROM "stock_transfer" t
      JOIN "warehouse" tw ON tw."id" = t."toWarehouseId"
      WHERE t."id" = ${transferId} AND t."tenantId" = ${tenantId}
      FOR UPDATE OF t`;
    if (!transfer)
      throw new NotFoundException({ code: 'TRANSFER_NOT_FOUND', message: 'Ese traslado no existe' });
    return transfer;
  }

  private assertTransition(from: TransferStatusKey, to: TransferStatusKey) {
    if (!canTransitionTransfer(from, to)) {
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: `Un traslado ${from.toLowerCase()} no puede pasar a ${to.toLowerCase()}`,
      });
    }
  }

  private assertWarehouse(ctx: Ctx, warehouseId: string) {
    if (ctx.tenant.warehouseIds.length > 0 && !ctx.tenant.warehouseIds.includes(warehouseId)) {
      throw new NotFoundException({
        code: 'WAREHOUSE_NOT_FOUND',
        message: 'No tienes acceso a esa bodega',
      });
    }
  }

  private toSummary(r: {
    id: string;
    number: number;
    status: string;
    fromId: string;
    fromCode: string;
    fromName: string;
    toId: string;
    toCode: string;
    toName: string;
    notes: string | null;
    createdAt: Date;
    sentAt: Date | null;
    receivedAt: Date | null;
    createdByName: string | null;
    itemCount: bigint;
    units: bigint;
  }): StockTransferSummary {
    return {
      id: r.id,
      number: Number(r.number),
      code: transferCode(Number(r.number)),
      status: r.status as TransferStatusKey,
      from: { id: r.fromId, code: r.fromCode, name: r.fromName },
      to: { id: r.toId, code: r.toCode, name: r.toName },
      itemCount: Number(r.itemCount),
      units: Number(r.units),
      notes: r.notes,
      createdAt: new Date(r.createdAt).toISOString(),
      sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
      receivedAt: r.receivedAt ? new Date(r.receivedAt).toISOString() : null,
      createdByName: r.createdByName,
    };
  }
}
