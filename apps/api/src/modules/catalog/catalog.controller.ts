import { Controller, Get, Inject } from '@nestjs/common';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';

export interface CatalogOverview {
  /** Piezas activas del negocio. */
  parts: number;
  variants: number;
  /** Variantes con existencia por debajo de su punto de reorden (o en cero). */
  lowStock: number;
  outOfStock: number;
  /** Búsquedas sin resultado en los últimos 30 días: la señal de qué comprar. */
  missedSearches: number;
  /** Solo cuentan las bodegas que el usuario puede ver. */
  warehouseCount: number;
}

/**
 * Resumen del catálogo para el tablero.
 *
 * Existe para que el tablero no tenga que mentir. Antes decía "todavía no hay piezas cargadas"
 * porque no había forma de saberlo sin cargar todo el catálogo; con este conteo la frase es cierta
 * o no se muestra.
 *
 * El cálculo va en SQL y no en el cliente: `lowStock` es una comparación contra
 * `inventory_level.reorderPoint`, y traer todas las variantes para contarlas en JavaScript es
 * justo el tipo de consulta que se cae el día que la bodega importa su Excel de 4.000 filas.
 */
@Controller('catalog')
export class CatalogController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get('overview')
  @RequirePermissions('catalog.view')
  overview(@CurrentCtx() ctx: Ctx): Promise<CatalogOverview> {
    const allowed = ctx.tenant.warehouseIds;
    return this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const [counts] = await tx.$queryRaw<
        Array<{
          parts: bigint;
          variants: bigint;
          lowStock: bigint;
          outOfStock: bigint;
          missedSearches: bigint;
          warehouseCount: bigint;
        }>
      >`
        SELECT
          (SELECT count(*) FROM "part" p
            WHERE p."tenantId" = ${ctx.tenant.tenantId} AND p."status" = 'ACTIVO') AS "parts",
          (SELECT count(*) FROM "part_variant" v
            JOIN "part" p ON p."id" = v."partId"
            WHERE v."tenantId" = ${ctx.tenant.tenantId} AND v."isActive" AND p."status" = 'ACTIVO')
            AS "variants",
          (SELECT count(*) FROM "inventory_level" l
            JOIN "warehouse" w ON w."id" = l."warehouseId"
            WHERE l."tenantId" = ${ctx.tenant.tenantId}
              AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
              AND l."onHand" > 0
              AND l."reorderPoint" IS NOT NULL
              AND l."onHand" - l."reserved" <= l."reorderPoint") AS "lowStock",
          (SELECT count(*) FROM "part_variant" v
            JOIN "part" p ON p."id" = v."partId"
            JOIN "warehouse" w ON w."tenantId" = v."tenantId"
            WHERE v."tenantId" = ${ctx.tenant.tenantId} AND v."isActive" AND p."status" = 'ACTIVO'
              AND w."isActive"
              AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
              AND NOT EXISTS (
                SELECT 1 FROM "inventory_level" l
                WHERE l."variantId" = v."id" AND l."warehouseId" = w."id" AND l."onHand" > 0
              )) AS "outOfStock",
          (SELECT count(*) FROM "search_event" e
            WHERE e."tenantId" = ${ctx.tenant.tenantId}
              AND e."resultCount" = 0
              AND e."createdAt" > now() - make_interval(days => 30)) AS "missedSearches",
          (SELECT count(*) FROM "warehouse" w
            WHERE w."tenantId" = ${ctx.tenant.tenantId} AND w."isActive"
              AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[])))
            AS "warehouseCount"
      `;

      return {
        parts: Number(counts?.parts ?? 0),
        variants: Number(counts?.variants ?? 0),
        lowStock: Number(counts?.lowStock ?? 0),
        outOfStock: Number(counts?.outOfStock ?? 0),
        missedSearches: Number(counts?.missedSearches ?? 0),
        warehouseCount: Number(counts?.warehouseCount ?? 0),
      };
    });
  }
}
