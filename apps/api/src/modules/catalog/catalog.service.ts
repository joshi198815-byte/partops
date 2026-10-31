import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type BulkPartsData,
  type CatalogCompatibility,
  type CatalogListQuery,
  type CatalogListResponse,
  type CatalogMovement,
  type CatalogPartDetail,
  type CatalogPartSummary,
  type CatalogVariant,
  type CompatibilityRangeData,
  normalizePartCode,
  type PartCreateData,
  type PartUpdateData,
  partSlug,
  partSlugCandidate,
  type VehicleOption,
  type WarehouseOption,
} from '@partops/contracts';
import { Prisma, type TxClient } from '@partops/db';
import { audit, diff } from '../../common/audit.js';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PlanService } from '../plan/plan.service.js';
import { SearchService } from '../search/search.service.js';
import { ImagesService } from './images.service.js';

interface RawPartRow {
  id: string;
  name: string;
  slug: string;
  brand: string | null;
  category: string | null;
  categoryId: string | null;
  condition: 'NUEVO' | 'USADO' | 'REMANUFACTURADO';
  unit: string;
  warrantyDays: number | null;
  status: 'ACTIVO' | 'ARCHIVADO';
  imageUrl: string | null;
  updatedAt: Date;
  variantCount: bigint;
  priceMin: number | null;
  priceMax: number | null;
  onHand: bigint;
  reserved: bigint;
  lowStock: boolean;
  sku: string | null;
}

/**
 * Catálogo: piezas, variantes, compatibilidad e imágenes.
 *
 * El modelo mental es el del mostrador, no el de una base normalizada:
 *
 *  - **Pieza** es lo que el cliente pide ("capó Corolla"). **Variante** es lo que se cobra y se
 *    cuenta: izquierdo/derecho, 1.8L/2.0L, cada una con su SKU, su precio y su existencia. Si todo
 *    fuera una sola fila, el inventario no podría decir "hay 3 izquierdos y 0 derechos".
 *  - **Compatibilidad** es por aplicación (modelo + rango de años + motor), no por texto libre.
 *    "Toyota Corolla 2009" escrito en una columna no se puede filtrar y termina duplicado en cada
 *    fila del Excel.
 *  - **Archivar** en vez de borrar. Una pieza que ya se vendió no puede desaparecer: el recibo
 *    viejo quedaría apuntando a la nada. Borrar solo es posible si nunca se movió.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ImagesService) private readonly images: ImagesService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(PlanService) private readonly plan: PlanService,
  ) {}

  // ───────────────────────────── Listado ─────────────────────────────

  async list(ctx: Ctx, query: CatalogListQuery): Promise<CatalogListResponse> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);
    const q = (query.q ?? '').trim();
    const normalized: CatalogListQuery = { ...query, q };

    return this.db.tx(tenantId, async (tx) => {
      const filter = this.listFilter({ tenantId, query: normalized, allowed });

      const rows = await tx.$queryRaw<RawPartRow[]>`
        SELECT
          p."id", p."name", p."slug", p."brand",
          c."name" AS "category", p."categoryId",
          p."condition"::text AS "condition", p."unit", p."warrantyDays",
          p."status"::text AS "status", p."updatedAt",
          (SELECT i."url" FROM "part_image" i WHERE i."partId" = p."id"
             ORDER BY i."position" ASC LIMIT 1) AS "imageUrl",
          (SELECT v."sku" FROM "part_variant" v WHERE v."partId" = p."id" AND v."isActive"
             ORDER BY v."position" ASC, v."sku" ASC LIMIT 1) AS "sku",
          coalesce(st."variants", 0) AS "variantCount",
          st."priceMin", st."priceMax",
          coalesce(st."total", 0) AS "onHand",
          coalesce(st."held", 0) AS "reserved",
          coalesce(st."low", false) AS "lowStock"
        FROM "part" p
        LEFT JOIN "part_category" c ON c."id" = p."categoryId"
        LEFT JOIN LATERAL (
          SELECT
            count(*) AS "variants",
            min(v."priceCents") AS "priceMin",
            max(v."priceCents") AS "priceMax",
            coalesce(sum(x."onHand"), 0) AS "total",
            coalesce(sum(x."reserved"), 0) AS "held",
            bool_or(x."reorderPoint" IS NOT NULL AND x."onHand" > 0
                    AND x."onHand" - x."reserved" <= x."reorderPoint") AS "low"
          FROM "part_variant" v
          LEFT JOIN LATERAL (
            SELECT l."onHand", l."reserved", l."reorderPoint"
            FROM "inventory_level" l
            JOIN "warehouse" w ON w."id" = l."warehouseId"
            WHERE l."variantId" = v."id" AND w."isActive"
              AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
          ) x ON TRUE
          WHERE v."partId" = p."id" AND v."isActive"
        ) st ON TRUE
        WHERE ${filter}
        ORDER BY ${this.orderBy(query.sort ?? 'NOMBRE')}
        LIMIT ${limit} OFFSET ${offset}
      `;

      const [countRow] = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT count(*) AS "total" FROM "part" p WHERE ${filter}
      `;

      /**
       * Facetas que no se recortan entre sí: si al elegir Toyota desapareciera Nissan, no habría
       * vuelta atrás sin borrar el filtro a mano. Cada dimensión cuenta con los demás filtros
       * aplicados menos el suyo.
       */
      const noBrand = this.listFilter({ tenantId, query: { ...normalized, brand: undefined }, allowed });
      const noCategory = this.listFilter({
        tenantId,
        query: { ...normalized, categoryId: undefined },
        allowed,
      });

      const [brands, categories] = await Promise.all([
        tx.$queryRaw<Array<{ name: string; count: bigint }>>`
          SELECT p."brand" AS "name", count(*) AS "count"
          FROM "part" p
          WHERE ${noBrand} AND p."brand" IS NOT NULL AND p."brand" <> ''
          GROUP BY p."brand" ORDER BY count(*) DESC, p."brand" ASC LIMIT 15`,
        tx.$queryRaw<Array<{ id: string; name: string; count: bigint }>>`
          SELECT c."id", c."name", count(*) AS "count"
          FROM "part" p
          JOIN "part_category" c ON c."id" = p."categoryId"
          WHERE ${noCategory}
          GROUP BY c."id", c."name" ORDER BY count(*) DESC, c."name" ASC LIMIT 20`,
      ]);

      return {
        items: rows.map((r) => this.toSummary(r)),
        total: Number(countRow?.total ?? 0),
        limit,
        offset,
        facets: {
          brands: brands.map((b) => ({ name: b.name, count: Number(b.count) })),
          categories: categories.map((c) => ({ id: c.id, name: c.name, count: Number(c.count) })),
        },
      };
    });
  }

  /** Condición SQL compartida por el listado y sus facetas. */
  private listFilter(args: { tenantId: string; query: CatalogListQuery; allowed: string[] }): Prisma.Sql {
    const { tenantId, query, allowed } = args;
    const q = (query.q ?? '').trim();
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const code = normalizePartCode(q);

    const text = q
      ? Prisma.sql`AND (
          p."name" ILIKE ${like}
          OR p."brand" ILIKE ${like}
          OR EXISTS (
            SELECT 1 FROM "part_variant" v
            WHERE v."partId" = p."id"
              AND (
                v."sku" ILIKE ${like}
                OR coalesce(v."partNumber", '') ILIKE ${like}
                OR (${code.length >= 4}::boolean AND (
                  upper(regexp_replace(v."sku", '[^A-Za-z0-9]', '', 'g')) = ${code}
                  OR EXISTS (
                    SELECT 1 FROM unnest(v."oemNumbers") o
                    WHERE upper(regexp_replace(o, '[^A-Za-z0-9]', '', 'g')) = ${code}
                  )
                ))
              )
          )
        )`
      : Prisma.empty;

    const status =
      query.status === 'TODOS'
        ? Prisma.empty
        : Prisma.sql`AND p."status" = ${query.status ?? 'ACTIVO'}::"PartStatus"`;

    const stockFilter = query.stock ?? 'TODOS';
    const available = Prisma.sql`(
      SELECT coalesce(sum(l."onHand" - l."reserved"), 0)
      FROM "part_variant" v
      JOIN "inventory_level" l ON l."variantId" = v."id"
      JOIN "warehouse" w ON w."id" = l."warehouseId"
      WHERE v."partId" = p."id" AND v."isActive" AND w."isActive"
        AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
    )`;

    const stock =
      stockFilter === 'CON'
        ? Prisma.sql`AND ${available} > 0`
        : stockFilter === 'AGOTADO'
          ? Prisma.sql`AND ${available} <= 0`
          : stockFilter === 'BAJO'
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM "part_variant" v2
                JOIN "inventory_level" l2 ON l2."variantId" = v2."id"
                JOIN "warehouse" w2 ON w2."id" = l2."warehouseId"
                WHERE v2."partId" = p."id" AND v2."isActive" AND w2."isActive"
                  AND l2."reorderPoint" IS NOT NULL AND l2."onHand" > 0
                  AND l2."onHand" - l2."reserved" <= l2."reorderPoint"
                  AND (${allowed.length === 0}::boolean OR w2."id" = ANY(${allowed}::text[]))
              )`
            : Prisma.empty;

    return Prisma.sql`
      p."tenantId" = ${tenantId}
      ${status}
      ${text}
      ${query.categoryId ? Prisma.sql`AND p."categoryId" = ${query.categoryId}` : Prisma.empty}
      ${query.brand ? Prisma.sql`AND lower(p."brand") = lower(${query.brand})` : Prisma.empty}
      ${query.condition ? Prisma.sql`AND p."condition" = ${query.condition}::"PartCondition"` : Prisma.empty}
      ${stock}
    `;
  }

  private orderBy(sort: CatalogListQuery['sort']): Prisma.Sql {
    if (sort === 'RECIENTES') return Prisma.sql`p."updatedAt" DESC, p."name" ASC`;
    if (sort === 'PRECIO') return Prisma.sql`st."priceMin" ASC NULLS LAST, p."name" ASC`;
    return Prisma.sql`p."name" ASC`;
  }

  private toSummary(r: RawPartRow): CatalogPartSummary {
    const onHand = Number(r.onHand);
    const reserved = Number(r.reserved);
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      sku: r.sku ?? '',
      brand: r.brand,
      category: r.category,
      categoryId: r.categoryId,
      condition: r.condition,
      unit: r.unit,
      warrantyDays: r.warrantyDays,
      status: r.status,
      imageUrl: r.imageUrl,
      variantCount: Number(r.variantCount),
      priceMin: Number(r.priceMin ?? 0),
      priceMax: Number(r.priceMax ?? 0),
      onHand,
      reserved,
      lowStock: Boolean(r.lowStock),
      outOfStock: onHand - reserved <= 0,
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }

  // ───────────────────────────── Detalle ─────────────────────────────

  async detail(ctx: Ctx, partId: string): Promise<CatalogPartDetail> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;

    return this.db.tx(tenantId, async (tx) => {
      const part = await tx.part.findUnique({
        where: { id: partId },
        include: { images: { orderBy: { position: 'asc' } } },
      });
      if (!part) throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Esa pieza no existe' });

      const [summaryRow] = await tx.$queryRaw<RawPartRow[]>`
        SELECT p."id", p."name", p."slug", p."brand",
          c."name" AS "category", p."categoryId",
          p."condition"::text AS "condition", p."unit", p."warrantyDays",
          p."status"::text AS "status", p."updatedAt",
          (SELECT i."url" FROM "part_image" i WHERE i."partId" = p."id"
             ORDER BY i."position" LIMIT 1) AS "imageUrl",
          (SELECT v."sku" FROM "part_variant" v WHERE v."partId" = p."id" AND v."isActive"
             ORDER BY v."position" LIMIT 1) AS "sku",
          (SELECT count(*) FROM "part_variant" v WHERE v."partId" = p."id" AND v."isActive") AS "variantCount",
          (SELECT min("priceCents") FROM "part_variant" v WHERE v."partId" = p."id" AND v."isActive") AS "priceMin",
          (SELECT max("priceCents") FROM "part_variant" v WHERE v."partId" = p."id" AND v."isActive") AS "priceMax",
          coalesce((
            SELECT sum(l."onHand") FROM "part_variant" v
            JOIN "inventory_level" l ON l."variantId" = v."id"
            JOIN "warehouse" w ON w."id" = l."warehouseId"
            WHERE v."partId" = p."id" AND v."isActive" AND w."isActive"
              AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
          ), 0) AS "onHand",
          coalesce((
            SELECT sum(l."reserved") FROM "part_variant" v
            JOIN "inventory_level" l ON l."variantId" = v."id"
            JOIN "warehouse" w ON w."id" = l."warehouseId"
            WHERE v."partId" = p."id" AND v."isActive" AND w."isActive"
              AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
          ), 0) AS "reserved",
          EXISTS (
            SELECT 1 FROM "part_variant" v
            JOIN "inventory_level" l ON l."variantId" = v."id"
            JOIN "warehouse" w ON w."id" = l."warehouseId"
            WHERE v."partId" = p."id" AND v."isActive" AND w."isActive"
              AND l."reorderPoint" IS NOT NULL AND l."onHand" > 0
              AND l."onHand" - l."reserved" <= l."reorderPoint"
              AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
          ) AS "lowStock"
        FROM "part" p
        LEFT JOIN "part_category" c ON c."id" = p."categoryId"
        WHERE p."id" = ${partId}
      `;
      if (!summaryRow)
        throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Esa pieza no existe' });

      const [variants, vehicles, movements] = await Promise.all([
        this.variants(ctx, tx, partId),
        tx.$queryRaw<CatalogCompatibility[]>`
          SELECT pc."id", pc."vehicleId", vb."name" AS "brand", vm."name" AS "model",
                 veh."yearStart", veh."yearEnd", veh."engine", veh."bodyStyle", pc."notes"
          FROM "part_compatibility" pc
          JOIN "vehicle" veh ON veh."id" = pc."vehicleId"
          JOIN "vehicle_model" vm ON vm."id" = veh."modelId"
          JOIN "vehicle_brand" vb ON vb."id" = vm."brandId"
          WHERE pc."partId" = ${partId}
          ORDER BY vb."name", vm."name", veh."yearStart"`,
        tx.$queryRaw<CatalogMovement[]>`
          SELECT m."id", m."createdAt", m."type"::text AS "type", m."delta", m."balanceAfter",
                 w."code" AS "warehouseCode", m."reason", u."name" AS "userName"
          FROM "stock_movement" m
          JOIN "warehouse" w ON w."id" = m."warehouseId"
          LEFT JOIN "user" u ON u."id" = m."userId"
          WHERE m."variantId" IN (SELECT "id" FROM "part_variant" WHERE "partId" = ${partId})
          ORDER BY m."createdAt" DESC LIMIT 20`,
      ]);

      return {
        ...this.toSummary(summaryRow),
        description: part.description,
        isUniversal: part.isUniversal,
        tags: part.tags,
        images: part.images.map((i) => ({ id: i.id, url: i.url, alt: i.alt, position: i.position })),
        variants,
        vehicles: vehicles.map((v) => ({ ...v, notes: v.notes ?? null })),
        movements: movements.map((m) => ({ ...m, createdAt: new Date(m.createdAt).toISOString() })),
      };
    });
  }

  /** Variantes con existencia por bodega, respetando las bodegas asignadas al usuario. */
  private async variants(ctx: Ctx, tx: TxClient, partId: string): Promise<CatalogVariant[]> {
    const allowed = ctx.tenant.warehouseIds;
    const showCost = ctx.tenant.permissions.has('catalog.cost.view');

    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        sku: string;
        title: string;
        partNumber: string | null;
        oemNumbers: string[];
        barcode: string | null;
        priceCents: number;
        costCents: number;
        isActive: boolean;
        position: number;
        warehouseId: string | null;
        warehouseCode: string | null;
        warehouseName: string | null;
        onHand: number | null;
        reserved: number | null;
        reorderPoint: number | null;
        binLocation: string | null;
      }>
    >`
      SELECT v."id", v."sku", v."title", v."partNumber", v."oemNumbers", v."barcode",
             v."priceCents", v."costCents", v."isActive", v."position",
             w."id" AS "warehouseId", w."code" AS "warehouseCode", w."name" AS "warehouseName",
             l."onHand", l."reserved", l."reorderPoint", l."binLocation"
      FROM "part_variant" v
      LEFT JOIN "inventory_level" l ON l."variantId" = v."id"
      LEFT JOIN "warehouse" w ON w."id" = l."warehouseId"
        AND w."isActive" AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
      WHERE v."partId" = ${partId}
      ORDER BY v."position", v."sku", w."code"
    `;

    const byVariant = new Map<string, CatalogVariant>();
    for (const r of rows) {
      let variant = byVariant.get(r.id);
      if (!variant) {
        variant = {
          id: r.id,
          sku: r.sku,
          title: r.title,
          partNumber: r.partNumber,
          oemNumbers: r.oemNumbers ?? [],
          barcode: r.barcode,
          priceCents: Number(r.priceCents),
          costCents: showCost ? Number(r.costCents) : null,
          isActive: r.isActive,
          position: r.position,
          onHand: 0,
          reserved: 0,
          stock: [],
        };
        byVariant.set(r.id, variant);
      }
      if (r.warehouseId && r.warehouseCode && r.warehouseName) {
        const onHand = Number(r.onHand ?? 0);
        const reserved = Number(r.reserved ?? 0);
        variant.onHand += onHand;
        variant.reserved += reserved;
        variant.stock.push({
          warehouseId: r.warehouseId,
          warehouseCode: r.warehouseCode,
          warehouseName: r.warehouseName,
          onHand,
          reserved,
          available: onHand - reserved,
          reorderPoint: r.reorderPoint === null ? null : Number(r.reorderPoint),
          binLocation: r.binLocation,
        });
      }
    }
    return [...byVariant.values()];
  }

  // ───────────────────────────── Alta y edición ─────────────────────────────

  async create(ctx: Ctx, input: PartCreateData): Promise<CatalogPartDetail> {
    const tenantId = ctx.tenant.tenantId;

    const partId = await this.db.tx(tenantId, async (tx) => {
      // El tope se comprueba dentro de la misma transacción que crea: dos altas simultáneas en el
      // borde del límite no pueden colarse las dos.
      await this.plan.assertCanAddParts(ctx, tx, 1);
      const categoryId = await this.resolveCategory(tx, tenantId, input.categoryId, input.categoryName);
      const slug = await this.freeSlug(tx, tenantId, partSlug(input.name));

      await this.assertSkusFree(
        tx,
        tenantId,
        input.variants.map((v) => v.sku),
      );
      await this.assertOemFree(tx, tenantId, input.variants, null);

      const part = await tx.part.create({
        data: {
          tenantId,
          name: input.name,
          slug,
          brand: input.brand?.trim() || null,
          categoryId,
          condition: input.condition ?? 'NUEVO',
          unit: input.unit ?? 'UNIDAD',
          warrantyDays: input.warrantyDays ?? null,
          description: input.description?.trim() || null,
          isUniversal: input.isUniversal ?? false,
          tags: input.tags ?? [],
        },
        select: { id: true },
      });

      for (const [index, variant] of input.variants.entries()) {
        await tx.partVariant.create({
          data: {
            tenantId,
            partId: part.id,
            sku: variant.sku,
            title: variant.title?.trim() || input.name,
            partNumber: variant.partNumber?.trim() || null,
            oemNumbers: variant.oemNumbers ?? [],
            barcode: variant.barcode?.trim() || null,
            priceCents: variant.price,
            costCents: variant.cost ?? 0,
            position: index,
          },
        });
      }

      if (input.vehicleIds?.length) {
        await this.linkVehicles(tx, tenantId, part.id, input.vehicleIds);
      }

      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'catalog.part_created',
        entity: 'part',
        entityId: part.id,
        after: { name: input.name, sku: input.variants[0]?.sku, variants: input.variants.length },
        ip: ctx.ip,
      });

      return part.id;
    });

    this.search.invalidate(tenantId);
    return this.detail(ctx, partId);
  }

  async update(ctx: Ctx, partId: string, input: PartUpdateData): Promise<CatalogPartDetail> {
    await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const before = await tx.part.findUnique({ where: { id: partId } });
      if (!before) throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Esa pieza no existe' });

      const categoryId =
        input.categoryId !== undefined || input.categoryName !== undefined
          ? await this.resolveCategory(tx, ctx.tenant.tenantId, input.categoryId, input.categoryName)
          : undefined;

      const data = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.brand !== undefined ? { brand: input.brand } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(input.condition !== undefined ? { condition: input.condition } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
        ...(input.warrantyDays !== undefined ? { warrantyDays: input.warrantyDays } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isUniversal !== undefined ? { isUniversal: input.isUniversal } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      };

      await tx.part.update({ where: { id: partId }, data });

      const changes = diff(
        {
          name: before.name,
          brand: before.brand,
          categoryId: before.categoryId,
          condition: before.condition,
          unit: before.unit,
          warrantyDays: before.warrantyDays,
          isUniversal: before.isUniversal,
          tags: before.tags,
          status: before.status,
          description: before.description,
        },
        data as Record<string, unknown>,
      );
      if (changes) {
        await audit(tx, {
          tenantId: ctx.tenant.tenantId,
          userId: ctx.user.id,
          action: 'catalog.part_updated',
          entity: 'part',
          entityId: partId,
          before: changes.before,
          after: changes.after,
          ip: ctx.ip,
        });
      }
    });

    this.search.invalidate(ctx.tenant.tenantId);
    return this.detail(ctx, partId);
  }

  /**
   * Borrar o archivar.
   *
   * Si la pieza tiene cualquier movimiento de inventario o línea de venta, se archiva: el recibo
   * viejo no puede quedar apuntando a una pieza que no existe. La respuesta dice cuál de las dos
   * cosas pasó para que la interfaz no tenga que adivinarlo.
   */
  async remove(ctx: Ctx, partId: string): Promise<{ archived: boolean }> {
    const result = await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const part = await tx.part.findUnique({
        where: { id: partId },
        select: { id: true, name: true, status: true },
      });
      if (!part) throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Esa pieza no existe' });

      const [movements, sold] = await Promise.all([
        tx.stockMovement.count({ where: { variant: { partId } } }),
        /**
         * `sales_order_item` no declara relación con `part_variant` en Prisma: se cuenta en SQL en
         * vez de agregar una relación que solo existe para esta comprobación.
         */
        tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS "count" FROM "sales_order_item" i
          WHERE i."variantId" IN (SELECT "id" FROM "part_variant" WHERE "partId" = ${partId})`,
      ]);

      const hasHistory = movements > 0 || Number(sold[0]?.count ?? 0) > 0;
      if (hasHistory) {
        await tx.part.update({ where: { id: partId }, data: { status: 'ARCHIVADO' } });
        await audit(tx, {
          tenantId: ctx.tenant.tenantId,
          userId: ctx.user.id,
          action: 'catalog.part_archived',
          entity: 'part',
          entityId: partId,
          before: { status: part.status },
          after: { status: 'ARCHIVADO', reason: 'tiene movimientos' },
          ip: ctx.ip,
        });
        return { archived: true };
      }

      // Sin historial: se borra de verdad, pero las imágenes se limpian del almacenamiento; si no,
      // quedan archivos en el bucket que nadie puede asociar con nada.
      const images = await tx.partImage.findMany({
        where: { partId },
        select: { url: true, fallbackUrl: true },
      });
      await tx.part.delete({ where: { id: partId } });
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'catalog.part_deleted',
        entity: 'part',
        entityId: partId,
        before: { name: part.name },
        ip: ctx.ip,
      });
      for (const image of images) {
        await this.images.removeImage(image.url, image.fallbackUrl);
      }
      return { archived: false };
    });

    this.search.invalidate(ctx.tenant.tenantId);
    return result;
  }

  async bulk(ctx: Ctx, input: BulkPartsData): Promise<{ updated: number }> {
    const result = await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const data =
        input.action === 'ARCHIVAR'
          ? { status: 'ARCHIVADO' as const }
          : input.action === 'ACTIVAR'
            ? { status: 'ACTIVO' as const }
            : { categoryId: input.categoryId ?? null };

      const updated = await tx.part.updateMany({ where: { id: { in: input.ids } }, data });
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: `catalog.bulk_${input.action.toLowerCase()}`,
        entity: 'part',
        entityId: null,
        after: { ids: input.ids, count: updated.count, ...data },
        ip: ctx.ip,
      });
      return { updated: updated.count };
    });

    this.search.invalidate(ctx.tenant.tenantId);
    return result;
  }

  // ───────────────────────────── Variantes ─────────────────────────────

  async createVariant(
    ctx: Ctx,
    partId: string,
    input: {
      sku: string;
      title?: string;
      partNumber?: string;
      oemNumbers?: string[];
      barcode?: string;
      price: number;
      cost?: number;
    },
  ): Promise<CatalogPartDetail> {
    await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const part = await tx.part.findUnique({ where: { id: partId }, select: { id: true, name: true } });
      if (!part) throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Esa pieza no existe' });

      await this.assertSkusFree(tx, ctx.tenant.tenantId, [input.sku]);
      await this.assertOemFree(tx, ctx.tenant.tenantId, [input], partId);

      const last = await tx.partVariant.aggregate({ where: { partId }, _max: { position: true } });
      const created = await tx.partVariant.create({
        data: {
          tenantId: ctx.tenant.tenantId,
          partId,
          sku: input.sku,
          title: input.title?.trim() || part.name,
          partNumber: input.partNumber?.trim() || null,
          oemNumbers: input.oemNumbers ?? [],
          barcode: input.barcode?.trim() || null,
          priceCents: input.price,
          costCents: input.cost ?? 0,
          position: (last._max.position ?? -1) + 1,
        },
        select: { id: true },
      });
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'catalog.variant_created',
        entity: 'part_variant',
        entityId: created.id,
        after: { sku: input.sku, price: input.price, partId },
        ip: ctx.ip,
      });
    });

    this.search.invalidate(ctx.tenant.tenantId);
    return this.detail(ctx, partId);
  }

  async updateVariant(
    ctx: Ctx,
    partId: string,
    variantId: string,
    input: {
      title?: string;
      partNumber?: string | null;
      oemNumbers?: string[];
      barcode?: string | null;
      price?: number;
      cost?: number;
      isActive?: boolean;
      position?: number;
    },
  ): Promise<CatalogPartDetail> {
    await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const before = await tx.partVariant.findFirst({
        where: { id: variantId, partId },
        select: {
          priceCents: true,
          costCents: true,
          title: true,
          partNumber: true,
          oemNumbers: true,
          isActive: true,
        },
      });
      if (!before)
        throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Esa variante no existe' });

      if (input.oemNumbers) {
        await this.assertOemFree(tx, ctx.tenant.tenantId, [input], partId, variantId);
      }

      await tx.partVariant.update({
        where: { id: variantId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.partNumber !== undefined ? { partNumber: input.partNumber } : {}),
          ...(input.oemNumbers !== undefined ? { oemNumbers: input.oemNumbers } : {}),
          ...(input.barcode !== undefined ? { barcode: input.barcode } : {}),
          ...(input.price !== undefined ? { priceCents: input.price } : {}),
          ...(input.cost !== undefined ? { costCents: input.cost } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        },
      });

      const changes = diff(
        {
          priceCents: before.priceCents,
          costCents: before.costCents,
          title: before.title,
          partNumber: before.partNumber,
          oemNumbers: before.oemNumbers,
          isActive: before.isActive,
        },
        {
          ...(input.price !== undefined ? { priceCents: input.price } : {}),
          ...(input.cost !== undefined ? { costCents: input.cost } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.partNumber !== undefined ? { partNumber: input.partNumber } : {}),
          ...(input.oemNumbers !== undefined ? { oemNumbers: input.oemNumbers } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      );
      if (changes) {
        await audit(tx, {
          tenantId: ctx.tenant.tenantId,
          userId: ctx.user.id,
          action: 'catalog.variant_updated',
          entity: 'part_variant',
          entityId: variantId,
          before: changes.before,
          after: changes.after,
          ip: ctx.ip,
        });
      }
    });

    this.search.invalidate(ctx.tenant.tenantId);
    return this.detail(ctx, partId);
  }

  /**
   * Una variante con existencia o historial no se borra: se desactiva. Borrarla dejaría el ledger
   * apuntando a una fila inexistente y el stock físico sin nombre.
   */
  async removeVariant(ctx: Ctx, partId: string, variantId: string): Promise<{ deactivated: boolean }> {
    const result = await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const variant = await tx.partVariant.findFirst({
        where: { id: variantId, partId },
        select: { id: true, sku: true },
      });
      if (!variant)
        throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Esa variante no existe' });

      const [movements, levels] = await Promise.all([
        tx.stockMovement.count({ where: { variantId } }),
        tx.inventoryLevel.count({
          where: { variantId, OR: [{ onHand: { gt: 0 } }, { reserved: { gt: 0 } }] },
        }),
      ]);

      if (movements > 0 || levels > 0) {
        await tx.partVariant.update({ where: { id: variantId }, data: { isActive: false } });
        await audit(tx, {
          tenantId: ctx.tenant.tenantId,
          userId: ctx.user.id,
          action: 'catalog.variant_deactivated',
          entity: 'part_variant',
          entityId: variantId,
          after: { sku: variant.sku, reason: 'tiene movimientos' },
          ip: ctx.ip,
        });
        return { deactivated: true };
      }

      await tx.partVariant.delete({ where: { id: variantId } });
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'catalog.variant_deleted',
        entity: 'part_variant',
        entityId: variantId,
        before: { sku: variant.sku },
        ip: ctx.ip,
      });
      return { deactivated: false };
    });

    this.search.invalidate(ctx.tenant.tenantId);
    return result;
  }

  // ───────────────────────────── Compatibilidad ─────────────────────────────

  /**
   * Alta masiva por rango de años.
   *
   * Es idempotente: aplicar el mismo rango dos veces no duplica la compatibilidad. El vehículo se
   * busca antes de crear y la pareja (pieza, vehículo) se inserta con `ON CONFLICT DO NOTHING`,
   * así que reenviar el formulario desde el teléfono en el pasillo no ensucia nada.
   */
  async addCompatibility(
    ctx: Ctx,
    partId: string,
    ranges: CompatibilityRangeData[],
  ): Promise<{ added: number; skipped: number }> {
    const result = await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const part = await tx.part.findUnique({ where: { id: partId }, select: { id: true } });
      if (!part) throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Esa pieza no existe' });

      let added = 0;
      let skipped = 0;

      for (const range of ranges) {
        const vehicleId = await this.ensureVehicle(tx, range);
        const exists = await tx.partCompatibility.findUnique({
          where: { partId_vehicleId: { partId, vehicleId } },
          select: { id: true, notes: true },
        });
        if (exists) {
          // La nota sí se actualiza: es lo que agrega información después ("solo con ABS").
          if (range.notes && range.notes !== exists.notes) {
            await tx.partCompatibility.update({ where: { id: exists.id }, data: { notes: range.notes } });
          }
          skipped += 1;
          continue;
        }
        await tx.partCompatibility.create({
          data: { tenantId: ctx.tenant.tenantId, partId, vehicleId, notes: range.notes ?? null },
        });
        added += 1;
      }

      if (added) {
        await audit(tx, {
          tenantId: ctx.tenant.tenantId,
          userId: ctx.user.id,
          action: 'catalog.compatibility_added',
          entity: 'part',
          entityId: partId,
          after: { added, skipped },
          ip: ctx.ip,
        });
      }
      return { added, skipped };
    });

    if (result.added) this.search.invalidate(ctx.tenant.tenantId);
    return result;
  }

  async addVehicleIds(
    ctx: Ctx,
    partId: string,
    vehicleIds: string[],
  ): Promise<{ added: number; skipped: number }> {
    const result = await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const part = await tx.part.findUnique({ where: { id: partId }, select: { id: true } });
      if (!part) throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Esa pieza no existe' });
      const valid = await tx.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { id: true } });
      const added = await this.linkVehicles(
        tx,
        ctx.tenant.tenantId,
        partId,
        valid.map((v) => v.id),
      );
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'catalog.compatibility_added',
        entity: 'part',
        entityId: partId,
        after: { added, skipped: vehicleIds.length - added },
        ip: ctx.ip,
      });
      return { added, skipped: vehicleIds.length - added };
    });

    if (result.added) this.search.invalidate(ctx.tenant.tenantId);
    return result;
  }

  async removeCompatibility(ctx: Ctx, partId: string, compatibilityId: string) {
    await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const row = await tx.partCompatibility.findFirst({
        where: { id: compatibilityId, partId },
        select: { id: true, vehicleId: true },
      });
      if (!row) {
        throw new NotFoundException({ code: 'COMPATIBILITY_NOT_FOUND', message: 'Esa aplicación no existe' });
      }
      await tx.partCompatibility.delete({ where: { id: row.id } });
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'catalog.compatibility_removed',
        entity: 'part',
        entityId: partId,
        before: { vehicleId: row.vehicleId },
        ip: ctx.ip,
      });
    });
    this.search.invalidate(ctx.tenant.tenantId);
    return { ok: true };
  }

  /** `INSERT ... ON CONFLICT DO NOTHING` en lote; devuelve cuántas parejas nuevas quedaron. */
  private async linkVehicles(
    tx: TxClient,
    tenantId: string,
    partId: string,
    vehicleIds: string[],
  ): Promise<number> {
    if (!vehicleIds.length) return 0;
    const inserted = await tx.$queryRaw<Array<{ count: bigint }>>`
      WITH ins AS (
        INSERT INTO "part_compatibility" ("id", "tenantId", "partId", "vehicleId")
        SELECT gen_random_uuid()::text, ${tenantId}, ${partId}, v
        FROM unnest(${vehicleIds}::text[]) AS v
        ON CONFLICT ("partId", "vehicleId") DO NOTHING
        RETURNING 1
      )
      SELECT count(*) AS "count" FROM ins`;
    return Number(inserted[0]?.count ?? 0);
  }

  /**
   * Encuentra o crea la aplicación vehicular.
   *
   * `findFirst` y no `upsert`: la clave única incluye columnas nulables (`engine`, `bodyStyle`) y en
   * Postgres dos NULL no son iguales, así que un `upsert` por esa clave crearía duplicados en
   * silencio cada vez que el motor no se especifica.
   */
  private async ensureVehicle(tx: TxClient, range: CompatibilityRangeData): Promise<string> {
    const brand = await tx.vehicleBrand.upsert({
      where: { name: range.brand },
      update: {},
      create: { name: range.brand },
      select: { id: true },
    });
    const model = await tx.vehicleModel.upsert({
      where: { brandId_name: { brandId: brand.id, name: range.model } },
      update: {},
      create: { brandId: brand.id, name: range.model },
      select: { id: true },
    });
    const engine = range.engine?.trim() || null;
    const bodyStyle = range.bodyStyle?.trim() || null;

    const existing = await tx.vehicle.findFirst({
      where: { modelId: model.id, yearStart: range.yearStart, yearEnd: range.yearEnd, engine, bodyStyle },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await tx.vehicle.create({
      data: { modelId: model.id, yearStart: range.yearStart, yearEnd: range.yearEnd, engine, bodyStyle },
      select: { id: true },
    });
    return created.id;
  }

  /** Aplicaciones para el selector: búsqueda por marca/modelo/año, con cuántas piezas las usan. */
  async vehicleOptions(
    ctx: Ctx,
    args: { q?: string; brand?: string; model?: string; limit?: number },
  ): Promise<VehicleOption[]> {
    const q = (args.q ?? '').trim();
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const brand = args.brand?.trim() || null;
    const model = args.model?.trim() || null;

    const rows = await this.db.tx(
      ctx.tenant.tenantId,
      (tx) =>
        tx.$queryRaw<Array<Omit<VehicleOption, 'parts'> & { parts: bigint }>>`
        SELECT veh."id", vb."name" AS "brand", vm."name" AS "model",
               veh."yearStart", veh."yearEnd", veh."engine", veh."bodyStyle",
               (SELECT count(*) FROM "part_compatibility" pc
                 WHERE pc."vehicleId" = veh."id" AND pc."tenantId" = ${ctx.tenant.tenantId}) AS "parts"
        FROM "vehicle" veh
        JOIN "vehicle_model" vm ON vm."id" = veh."modelId"
        JOIN "vehicle_brand" vb ON vb."id" = vm."brandId"
        WHERE (${q === ''}::boolean OR vb."name" ILIKE ${like} OR vm."name" ILIKE ${like})
          AND (${brand}::text IS NULL OR lower(vb."name") = lower(${brand}))
          AND (${model}::text IS NULL OR lower(vm."name") = lower(${model}))
        ORDER BY vb."name", vm."name", veh."yearStart" DESC
        LIMIT ${limit}`,
    );

    return rows.map((r) => ({ ...r, parts: Number(r.parts) }));
  }

  // ───────────────────────────── Imágenes ─────────────────────────────

  async addImage(
    ctx: Ctx,
    partId: string,
    file: { buffer: Buffer; size: number; mimetype: string; originalname: string },
  ) {
    const count = await this.db.tx(ctx.tenant.tenantId, (tx) => tx.partImage.count({ where: { partId } }));
    this.images.assertCapacity(count);

    const processed = await this.images.process(file, ctx.tenant.tenantId, partId);

    return this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const last = await tx.partImage.aggregate({ where: { partId }, _max: { position: true } });
      const image = await tx.partImage.create({
        data: {
          tenantId: ctx.tenant.tenantId,
          partId,
          url: processed.url,
          fallbackUrl: processed.fallbackUrl,
          width: processed.width,
          height: processed.height,
          position: (last._max.position ?? -1) + 1,
        },
        select: { id: true, url: true, alt: true, position: true },
      });
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'catalog.image_added',
        entity: 'part',
        entityId: partId,
        after: { url: processed.url, bytes: processed.bytes },
        ip: ctx.ip,
      });
      return image;
    });
  }

  async removeImage(ctx: Ctx, partId: string, imageId: string) {
    const removed = await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const image = await tx.partImage.findFirst({ where: { id: imageId, partId } });
      if (!image) throw new NotFoundException({ code: 'IMAGE_NOT_FOUND', message: 'Esa imagen no existe' });
      await tx.partImage.delete({ where: { id: image.id } });
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'catalog.image_removed',
        entity: 'part',
        entityId: partId,
        before: { url: image.url },
        ip: ctx.ip,
      });
      return image;
    });

    await this.images.removeImage(removed.url, removed.fallbackUrl);
    return { ok: true };
  }

  /** Orden de las imágenes: la primera es la portada del listado y del catálogo público. */
  async reorderImages(ctx: Ctx, partId: string, ids: string[]) {
    await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const owned = await tx.partImage.findMany({ where: { partId }, select: { id: true } });
      const ownedIds = new Set(owned.map((i) => i.id));
      if (ids.some((id) => !ownedIds.has(id))) {
        throw new BadRequestException({
          code: 'IMAGE_NOT_OWNED',
          message: 'Una imagen no pertenece a esta pieza',
        });
      }
      await Promise.all(
        ids.map((id, position) => tx.partImage.update({ where: { id }, data: { position } })),
      );
    });
    return { ok: true };
  }

  // ───────────────────────────── Existencias y categorías ─────────────────────────────

  /**
   * Ajuste desde la ficha: la persona escribe la existencia final ("quedan 4"), no el delta.
   * La conversión se hace aquí y queda en el ledger con el motivo, que es lo que permite explicar
   * un descuadre tres meses después.
   */
  async adjustStock(
    ctx: Ctx,
    partId: string,
    variantId: string,
    input: { warehouseId: string; onHand: number; reason?: string },
  ) {
    return this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const variant = await tx.partVariant.findFirst({
        where: { id: variantId, partId },
        select: { id: true, sku: true },
      });
      if (!variant)
        throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Esa variante no existe' });

      const level = await tx.inventoryLevel.findUnique({
        where: { variantId_warehouseId: { variantId, warehouseId: input.warehouseId } },
        select: { onHand: true, reserved: true },
      });
      const current = level?.onHand ?? 0;
      const delta = input.onHand - current;
      if (delta === 0) {
        return {
          onHand: current,
          reserved: level?.reserved ?? 0,
          available: current - (level?.reserved ?? 0),
          delta: 0,
        };
      }

      const result = await this.inventory.adjust(tx, {
        tenantId: ctx.tenant.tenantId,
        variantId,
        warehouseId: input.warehouseId,
        delta,
        reason: input.reason?.trim() || 'Ajuste desde la ficha de la pieza',
        userId: ctx.user.id,
      });

      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'inventory.adjusted',
        entity: 'part_variant',
        entityId: variantId,
        before: { onHand: current },
        after: { onHand: result.onHand, delta, warehouseId: input.warehouseId },
        ip: ctx.ip,
      });

      return { ...result, delta };
    });
  }

  async categories(ctx: Ctx) {
    const rows = await this.db.tx(ctx.tenant.tenantId, (tx) =>
      tx.partCategory.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, slug: true, _count: { select: { parts: true } } },
      }),
    );
    return rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, parts: c._count.parts }));
  }

  async createCategory(ctx: Ctx, name: string) {
    const category = await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const slug = slugifyName(name);
      const existing = await tx.partCategory.findUnique({
        where: { tenantId_slug: { tenantId: ctx.tenant.tenantId, slug } },
        select: { id: true, name: true, slug: true },
      });
      if (existing) return existing;

      const created = await tx.partCategory.create({
        data: { tenantId: ctx.tenant.tenantId, name, slug },
        select: { id: true, name: true, slug: true },
      });
      await audit(tx, {
        tenantId: ctx.tenant.tenantId,
        userId: ctx.user.id,
        action: 'catalog.category_created',
        entity: 'part_category',
        entityId: created.id,
        after: { name },
        ip: ctx.ip,
      });
      return created;
    });

    // Las categorías alimentan el vocabulario del parser de búsqueda: sin invalidar, un
    // "amortiguador" recién creado tarda cinco minutos en reconocerse como categoría.
    this.search.invalidate(ctx.tenant.tenantId);
    return category;
  }

  // ───────────────────────────── Auxiliares ─────────────────────────────

  /**
   * Bodegas donde el usuario puede mover existencia.
   *
   * Se filtra por `warehouseIds` del contexto: quien solo atiende la sucursal no debe poder
   * escribir un ajuste en la bodega central, y el selector de la ficha es el único lugar donde
   * eso se decide. La respuesta ya viene acotada para que el cliente no tenga que repetir la regla.
   */
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

  private async resolveCategory(
    tx: TxClient,
    tenantId: string,
    categoryId?: string | null,
    categoryName?: string | null,
  ): Promise<string | null> {
    if (categoryId) {
      const found = await tx.partCategory.findFirst({ where: { id: categoryId }, select: { id: true } });
      if (!found) {
        throw new BadRequestException({ code: 'CATEGORY_NOT_FOUND', message: 'Esa categoría no existe' });
      }
      return found.id;
    }
    const name = categoryName?.trim();
    if (!name) return null;
    const slug = slugifyName(name);
    const row = await tx.partCategory.upsert({
      where: { tenantId_slug: { tenantId, slug } },
      update: {},
      create: { tenantId, name, slug },
      select: { id: true },
    });
    return row.id;
  }

  private async freeSlug(tx: TxClient, tenantId: string, base: string): Promise<string> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const slug = partSlugCandidate(base, attempt);
      const taken = await tx.part.findUnique({
        where: { tenantId_slug: { tenantId, slug } },
        select: { id: true },
      });
      if (!taken) return slug;
    }
    throw new ConflictException({
      code: 'SLUG_TAKEN',
      message: 'Ya hay demasiadas piezas con ese nombre. Cambia el nombre para distinguirlas.',
    });
  }

  /** SKU único por negocio: un SKU repetido rompe la etiqueta y el escáner. */
  private async assertSkusFree(tx: TxClient, tenantId: string, skus: string[]) {
    const upper = skus.map((s) => s.toUpperCase());
    const dupInForm = upper.find((s, i) => upper.indexOf(s) !== i);
    if (dupInForm) {
      throw new ConflictException({
        code: 'DUPLICATE_SKU',
        message: `El SKU ${dupInForm} está repetido en el formulario`,
        sku: dupInForm,
      });
    }
    const existing = await tx.partVariant.findFirst({
      where: { tenantId, sku: { in: upper } },
      select: { sku: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'DUPLICATE_SKU',
        message: `El SKU ${existing.sku} ya existe en el catálogo`,
        sku: existing.sku,
      });
    }
  }

  /**
   * OEM único por negocio entre piezas distintas.
   *
   * Se permite el mismo código en dos variantes de la MISMA pieza: es el caso real de la pieza
   * original y su equivalente, que el mostrador quiere ver juntas. Lo que se rechaza es el mismo
   * OEM en dos piezas distintas, que es lo que duplica el catálogo y desconcierta al vendedor.
   */
  private async assertOemFree(
    tx: TxClient,
    tenantId: string,
    variants: Array<{ oemNumbers?: string[] }>,
    /**
     * Pieza a la que pertenecen las variantes que se están guardando. Sus otras variantes no
     * cuentan como conflicto: el mismo código en el original y en su equivalente es justo lo que
     * el mostrador quiere ver juntos.
     */
    samePartId: string | null,
    excludeVariantId: string | null = null,
  ) {
    const codes: string[] = [];
    for (const v of variants) for (const code of v.oemNumbers ?? []) codes.push(normalizePartCode(code));
    if (!codes.length) return;

    const rows = await tx.$queryRaw<Array<{ sku: string; partId: string; code: string }>>`
      SELECT v."sku", v."partId", upper(regexp_replace(o, '[^A-Za-z0-9]', '', 'g')) AS "code"
      FROM "part_variant" v, unnest(v."oemNumbers") AS o
      WHERE v."tenantId" = ${tenantId}
        AND upper(regexp_replace(o, '[^A-Za-z0-9]', '', 'g')) = ANY(${codes}::text[])
        AND (${excludeVariantId}::text IS NULL OR v."id" <> ${excludeVariantId})`;
    if (!rows.length) return;

    const conflict = rows.find((r) => !samePartId || r.partId !== samePartId);
    if (conflict) {
      throw new ConflictException({
        code: 'DUPLICATE_OEM',
        message: `El código OEM ${conflict.code} ya está en la variante ${conflict.sku}`,
        codeValue: conflict.code,
      });
    }
  }
}

/** `Suspensión` → `suspension`. Compartido por categorías y por el alta rápida desde la ficha. */
function slugifyName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
