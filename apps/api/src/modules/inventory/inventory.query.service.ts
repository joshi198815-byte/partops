import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  InventoryListQuery,
  InventoryListResponse,
  InventoryMovementRow,
  InventoryRow,
  InventorySummary,
  MovementListResponse,
  MovementQuery,
  MovementTypeKey,
  ReorderPointData,
  VariantOption,
  WarehouseOption,
} from '@partops/contracts';
import { audit } from '../../common/audit.js';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';

interface RawInventoryRow {
  variantId: string;
  partId: string;
  partName: string;
  title: string;
  sku: string;
  partNumber: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  unit: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  onHand: number;
  reserved: number;
  reorderPoint: number | null;
  binLocation: string | null;
  priceCents: number;
  updatedAt: Date;
}

/**
 * Consultas del inventario: existencias, mínimos, ubicaciones y ledger.
 *
 * Separado de `InventoryService` a propósito. Aquel mueve existencia y no conoce la base de datos
 * (recibe la transacción ya abierta, por eso puede participar de la venta); este solo lee y ajusta
 * metadatos, y es el único que necesita saber de tenants y bodegas asignadas. Mezclarlos obligaría
 * al servicio de movimientos a arrastrar dependencias que una venta no debe pagar.
 */
@Injectable()
export class InventoryQueryService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  // ───────────────────────────── Existencias ─────────────────────────────

  async list(ctx: Ctx, query: InventoryListQuery): Promise<InventoryListResponse> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const offset = Math.max(query.offset, 0);
    const term = query.q.trim();
    const like = `%${term}%`;
    const warehouseId = query.warehouseId ?? null;
    const filter = query.filter;

    return this.db.tx(tenantId, async (tx) => {
      /**
       * La condición de bodega se repite en las tres consultas porque un `WHERE` compartido en SQL
       * crudo obliga a concatenar strings. Repetirla es feo; construirla dinámicamente es peor: ahí
       * es donde se cuela una inyección o una bodega de más.
       */
      const rows = await tx.$queryRaw<RawInventoryRow[]>`
        SELECT v."id" AS "variantId", p."id" AS "partId", p."name" AS "partName",
               v."title", v."sku", v."partNumber", v."barcode", p."brand",
               c."name" AS "category", p."unit" AS "unit",
               w."id" AS "warehouseId", w."code" AS "warehouseCode", w."name" AS "warehouseName",
               coalesce(l."onHand", 0) AS "onHand", coalesce(l."reserved", 0) AS "reserved",
               l."reorderPoint", l."binLocation",
               v."priceCents", coalesce(l."updatedAt", v."updatedAt") AS "updatedAt"
        FROM "part_variant" v
        JOIN "part" p ON p."id" = v."partId"
        LEFT JOIN "part_category" c ON c."id" = p."categoryId"
        JOIN "warehouse" w ON w."tenantId" = ${tenantId} AND w."isActive"
          AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
          AND (${warehouseId}::text IS NULL OR w."id" = ${warehouseId}::text)
        LEFT JOIN "inventory_level" l ON l."variantId" = v."id" AND l."warehouseId" = w."id"
        WHERE v."tenantId" = ${tenantId} AND v."isActive" AND p."status" = 'ACTIVO'
          AND (
            ${term}::text = '' OR v."sku" ILIKE ${like} OR p."name" ILIKE ${like}
            OR v."partNumber" ILIKE ${like} OR p."brand" ILIKE ${like}
            OR EXISTS (SELECT 1 FROM unnest(v."oemNumbers") oem WHERE oem ILIKE ${like})
          )
          AND (
            ${filter}::text = 'TODOS'
            OR (${filter}::text = 'CON' AND coalesce(l."onHand", 0) > 0)
            OR (${filter}::text = 'AGOTADO' AND coalesce(l."onHand", 0) <= 0)
            OR (${filter}::text = 'BAJO' AND l."reorderPoint" IS NOT NULL
                AND coalesce(l."onHand", 0) > 0
                AND coalesce(l."onHand", 0) - coalesce(l."reserved", 0) <= l."reorderPoint")
            OR (${filter}::text = 'SIN_UBICACION' AND coalesce(l."onHand", 0) > 0
                AND (l."binLocation" IS NULL OR l."binLocation" = ''))
          )
        ORDER BY p."name" ASC, v."position" ASC, v."sku" ASC, w."code" ASC
        LIMIT ${limit} OFFSET ${offset}`;

      const [countRow] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS "total"
        FROM "part_variant" v
        JOIN "part" p ON p."id" = v."partId"
        JOIN "warehouse" w ON w."tenantId" = ${tenantId} AND w."isActive"
          AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
          AND (${warehouseId}::text IS NULL OR w."id" = ${warehouseId}::text)
        LEFT JOIN "inventory_level" l ON l."variantId" = v."id" AND l."warehouseId" = w."id"
        WHERE v."tenantId" = ${tenantId} AND v."isActive" AND p."status" = 'ACTIVO'
          AND (
            ${term}::text = '' OR v."sku" ILIKE ${like} OR p."name" ILIKE ${like}
            OR v."partNumber" ILIKE ${like} OR p."brand" ILIKE ${like}
            OR EXISTS (SELECT 1 FROM unnest(v."oemNumbers") oem WHERE oem ILIKE ${like})
          )
          AND (
            ${filter}::text = 'TODOS'
            OR (${filter}::text = 'CON' AND coalesce(l."onHand", 0) > 0)
            OR (${filter}::text = 'AGOTADO' AND coalesce(l."onHand", 0) <= 0)
            OR (${filter}::text = 'BAJO' AND l."reorderPoint" IS NOT NULL
                AND coalesce(l."onHand", 0) > 0
                AND coalesce(l."onHand", 0) - coalesce(l."reserved", 0) <= l."reorderPoint")
            OR (${filter}::text = 'SIN_UBICACION' AND coalesce(l."onHand", 0) > 0
                AND (l."binLocation" IS NULL OR l."binLocation" = ''))
          )`;

      return {
        items: rows.map((r) => this.toRow(r)),
        total: Number(countRow?.total ?? 0),
        limit,
        offset,
      };
    });
  }

  /**
   * Totales del negocio. No respetan el filtro de la pantalla porque estas cifras responden
   * "¿cómo está el inventario?", no "¿qué hay en esta página?".
   */
  async summary(ctx: Ctx): Promise<InventorySummary> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;

    return this.db.tx(tenantId, async (tx) => {
      /**
       * Se agrega por VARIANTE, no por fila de bodega.
       *
       * Una pieza con 12 en la central y 0 en la sucursal no está agotada: sumar las filas de
       * bodega daría "1 agotado" y el dueño saldría a comprar algo que ya tiene. El total por
       * variante es el que responde la pregunta que estas tarjetas hacen.
       */
      const [row] = await tx.$queryRaw<
        Array<{
          variants: bigint;
          units: bigint;
          reserved: bigint;
          low: bigint;
          out: bigint;
          unlocated: bigint;
        }>
      >`
        WITH per_variant AS (
          SELECT v."id",
                 coalesce(sum(l."onHand"), 0) AS "onHand",
                 coalesce(sum(l."reserved"), 0) AS "reserved",
                 bool_or(
                   l."reorderPoint" IS NOT NULL AND l."onHand" > 0
                   AND l."onHand" - l."reserved" <= l."reorderPoint"
                 ) AS "low",
                 bool_or(l."onHand" > 0 AND (l."binLocation" IS NULL OR l."binLocation" = '')) AS "unlocated"
          FROM "part_variant" v
          JOIN "part" p ON p."id" = v."partId"
          JOIN "warehouse" w ON w."tenantId" = ${tenantId} AND w."isActive"
            AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
          LEFT JOIN "inventory_level" l ON l."variantId" = v."id" AND l."warehouseId" = w."id"
          WHERE v."tenantId" = ${tenantId} AND v."isActive" AND p."status" = 'ACTIVO'
          GROUP BY v."id"
        )
        SELECT
          count(*) AS "variants",
          coalesce(sum("onHand"), 0) AS "units",
          coalesce(sum("reserved"), 0) AS "reserved",
          count(*) FILTER (WHERE "low") AS "low",
          count(*) FILTER (WHERE "onHand" <= 0) AS "out",
          count(*) FILTER (WHERE "unlocated") AS "unlocated"
        FROM per_variant`;

      const [transfers] = await tx.$queryRaw<{ open: bigint }[]>`
        SELECT count(*) AS "open" FROM "stock_transfer"
        WHERE "tenantId" = ${tenantId} AND "status" IN ('SOLICITADO', 'ENVIADO')`;

      return {
        variants: Number(row?.variants ?? 0),
        units: Number(row?.units ?? 0),
        reserved: Number(row?.reserved ?? 0),
        low: Number(row?.low ?? 0),
        out: Number(row?.out ?? 0),
        unlocated: Number(row?.unlocated ?? 0),
        openTransfers: Number(transfers?.open ?? 0),
      };
    });
  }

  // ───────────────────────────── Mínimos y ubicación ─────────────────────────────
  /**
   * Punto de reorden y pasillo de una variante en una bodega.
   *
   * No toca existencia: si la fila no existe se crea en (0,0). Es un dato de trabajo —a qué nivel
   * hay que pedir y dónde está el estante—, no un movimiento, y por eso no ensucia el ledger.
   */
  async setReorder(ctx: Ctx, variantId: string, input: ReorderPointData) {
    const tenantId = ctx.tenant.tenantId;
    if (ctx.tenant.warehouseIds.length > 0 && !ctx.tenant.warehouseIds.includes(input.warehouseId)) {
      throw new NotFoundException({
        code: 'WAREHOUSE_NOT_FOUND',
        message: 'No tienes acceso a esa bodega',
      });
    }

    return this.db.tx(tenantId, async (tx) => {
      const variant = await tx.partVariant.findFirst({
        where: { id: variantId },
        select: { id: true, sku: true },
      });
      if (!variant)
        throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Esa variante no existe' });

      const warehouse = await tx.warehouse.findFirst({
        where: { id: input.warehouseId, isActive: true },
        select: { id: true },
      });
      if (!warehouse)
        throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Esa bodega no existe' });

      const before = await tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId, warehouseId: input.warehouseId } },
        select: { reorderPoint: true, binLocation: true },
      });

      const data = {
        reorderPoint: input.reorderPoint,
        binLocation: input.binLocation?.trim() ? input.binLocation.trim() : null,
      };

      const level = await tx.inventoryLevel.upsert({
        where: { variantId_warehouseId: { variantId, warehouseId: input.warehouseId } },
        create: { tenantId, variantId, warehouseId: input.warehouseId, onHand: 0, reserved: 0, ...data },
        update: data,
        select: { onHand: true, reserved: true, reorderPoint: true, binLocation: true },
      });

      if (before?.reorderPoint !== level.reorderPoint || before?.binLocation !== level.binLocation) {
        await audit(tx, {
          tenantId,
          userId: ctx.user.id,
          action: 'inventory.reorder_updated',
          entity: 'part_variant',
          entityId: variantId,
          before: before ?? undefined,
          after: { ...data, warehouseId: input.warehouseId },
          ip: ctx.ip,
        });
      }

      return {
        variantId,
        sku: variant.sku,
        warehouseId: input.warehouseId,
        onHand: level.onHand,
        reserved: level.reserved,
        available: level.onHand - level.reserved,
        reorderPoint: level.reorderPoint,
        binLocation: level.binLocation,
      };
    });
  }

  // ───────────────────────────── Ledger ─────────────────────────────

  async movements(ctx: Ctx, query: MovementQuery): Promise<MovementListResponse> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const offset = Math.max(query.offset, 0);
    const variantId = query.variantId ?? null;
    const warehouseId = query.warehouseId ?? null;
    const type = query.type ?? null;

    return this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          createdAt: Date;
          variantId: string;
          sku: string;
          partName: string;
          variantTitle: string;
          type: string;
          delta: number;
          balanceAfter: number;
          warehouseCode: string;
          reason: string | null;
          userName: string | null;
          refType: string | null;
          refId: string | null;
        }>
      >`
        SELECT m."id", m."createdAt", m."variantId", v."sku", p."name" AS "partName",
               v."title" AS "variantTitle", m."type"::text AS "type", m."delta",
               m."balanceAfter", w."code" AS "warehouseCode", m."reason",
               u."name" AS "userName", m."refType", m."refId"
        FROM "stock_movement" m
        JOIN "part_variant" v ON v."id" = m."variantId"
        JOIN "part" p ON p."id" = v."partId"
        JOIN "warehouse" w ON w."id" = m."warehouseId"
        LEFT JOIN "user" u ON u."id" = m."userId"
        WHERE m."tenantId" = ${tenantId}
          AND m."type" <> 'RESERVA' AND m."type" <> 'LIBERACION'
          AND (${variantId}::text IS NULL OR m."variantId" = ${variantId}::text)
          AND (${warehouseId}::text IS NULL OR m."warehouseId" = ${warehouseId}::text)
          AND (${type}::text IS NULL OR m."type"::text = ${type}::text)
          AND (${allowed.length === 0}::boolean OR m."warehouseId" = ANY(${allowed}::text[]))
        ORDER BY m."createdAt" DESC, m."id" DESC
        LIMIT ${limit} OFFSET ${offset}`;

      const [countRow] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS "total"
        FROM "stock_movement" m
        WHERE m."tenantId" = ${tenantId}
          AND m."type" <> 'RESERVA' AND m."type" <> 'LIBERACION'
          AND (${variantId}::text IS NULL OR m."variantId" = ${variantId}::text)
          AND (${warehouseId}::text IS NULL OR m."warehouseId" = ${warehouseId}::text)
          AND (${type}::text IS NULL OR m."type"::text = ${type}::text)
          AND (${allowed.length === 0}::boolean OR m."warehouseId" = ANY(${allowed}::text[]))`;

      return {
        items: rows.map(
          (r): InventoryMovementRow => ({
            id: r.id,
            createdAt: new Date(r.createdAt).toISOString(),
            variantId: r.variantId,
            sku: r.sku,
            partName: r.partName,
            variantTitle: r.variantTitle,
            type: r.type as MovementTypeKey,
            delta: Number(r.delta),
            balanceAfter: Number(r.balanceAfter),
            warehouseCode: r.warehouseCode,
            reason: r.reason,
            userName: r.userName,
            refType: r.refType,
            refId: r.refId,
          }),
        ),
        total: Number(countRow?.total ?? 0),
        limit,
        offset,
      };
    });
  }

  // ───────────────────────────── Auxiliares de pantalla ─────────────────────────────

  /** Bodegas donde el usuario puede leer y mover existencia, ya acotadas por su asignación. */
  async warehouses(ctx: Ctx): Promise<WarehouseOption[]> {
    const allowed = ctx.tenant.warehouseIds;
    return this.db.tx(
      ctx.tenant.tenantId,
      (tx) =>
        tx.$queryRaw<WarehouseOption[]>`
        SELECT w."id", w."code", w."name", w."isDefault"
        FROM "warehouse" w
        WHERE w."tenantId" = ${ctx.tenant.tenantId} AND w."isActive"
          AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
        ORDER BY w."isDefault" DESC, w."name" ASC`,
    );
  }

  /**
   * Variantes para armar un traslado, con lo disponible en la bodega de origen.
   *
   * Devuelve también las que están en cero a propósito: el bodeguero que arma el traslado necesita
   * ver "aquí no hay, está en la central", y esconderlas le haría creer que la pieza no existe.
   */
  async variantOptions(
    ctx: Ctx,
    args: { q: string; warehouseId?: string; limit: number },
  ): Promise<VariantOption[]> {
    const tenantId = ctx.tenant.tenantId;
    const term = args.q.trim();
    const like = `%${term}%`;
    const warehouseId = args.warehouseId ?? null;
    const limit = Math.min(Math.max(args.limit, 1), 50);

    return this.db.tx(
      tenantId,
      (tx) =>
        tx.$queryRaw<
          Array<{
            variantId: string;
            partName: string;
            title: string;
            sku: string;
            unit: string;
            onHand: number;
            reserved: number;
            binLocation: string | null;
          }>
        >`
        SELECT v."id" AS "variantId", p."name" AS "partName", v."title", v."sku",
               p."unit" AS "unit",
               coalesce(l."onHand", 0) AS "onHand", coalesce(l."reserved", 0) AS "reserved",
               l."binLocation"
        FROM "part_variant" v
        JOIN "part" p ON p."id" = v."partId"
        LEFT JOIN "inventory_level" l ON l."variantId" = v."id" AND l."warehouseId" = ${warehouseId}::text
        WHERE v."tenantId" = ${tenantId} AND v."isActive" AND p."status" = 'ACTIVO'
          AND (${term}::text = '' OR v."sku" ILIKE ${like} OR p."name" ILIKE ${like}
               OR v."partNumber" ILIKE ${like}
               OR EXISTS (SELECT 1 FROM unnest(v."oemNumbers") oem WHERE oem ILIKE ${like}))
        ORDER BY p."name", v."position", v."sku"
        LIMIT ${limit}`,
    );
  }

  private toRow(r: RawInventoryRow): InventoryRow {
    const onHand = Number(r.onHand);
    const reserved = Number(r.reserved);
    return {
      variantId: r.variantId,
      partId: r.partId,
      partName: r.partName,
      title: r.title,
      sku: r.sku,
      partNumber: r.partNumber,
      barcode: r.barcode,
      brand: r.brand,
      category: r.category,
      unit: r.unit,
      warehouseId: r.warehouseId,
      warehouseCode: r.warehouseCode,
      warehouseName: r.warehouseName,
      onHand,
      reserved,
      available: onHand - reserved,
      reorderPoint: r.reorderPoint === null ? null : Number(r.reorderPoint),
      binLocation: r.binLocation,
      priceCents: Number(r.priceCents),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }
}
