import { Inject, Injectable } from '@nestjs/common';
import type { DashboardToday } from '@partops/contracts';
import { canSeeSales } from '@partops/contracts';
import type { Ctx } from '../../common/context.js';
import { localBoundary, nextDay, todayIn } from '../../common/time.js';
import { DatabaseService } from '../../infra/database.module.js';

/**
 * Cifras del día para el tablero.
 *
 * Una sola transacción con cuatro consultas independientes en paralelo. Se prefiere eso a una
 * consulta con cinco `UNION`: cada bloque se lee solo y el planificador las corre en conexiones
 * distintas del pool. El tablero se abre decenas de veces al día; la diferencia de tres
 * milisegundos no paga la consulta ilegible.
 *
 * Lo que no se puede ver llega en `null`. El tablero de alguien sin `finance.view` no recibe ceros
 * de ventas: recibe la ausencia del dato, que es la verdad.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async today(ctx: Ctx): Promise<DashboardToday> {
    const tenantId = ctx.tenant.tenantId;
    const allowed = ctx.tenant.warehouseIds;
    const seesMoney = canSeeSales([...ctx.tenant.permissions]);

    return this.db.tx(tenantId, async (tx) => {
      // La zona del negocio manda: si algún día un tenant opera en otra, el corte sigue siendo suyo.
      const [tenant] = await tx.$queryRaw<Array<{ timezone: string }>>`
        SELECT "timezone" FROM "tenant" WHERE "id" = ${tenantId}`;
      const timezone = tenant?.timezone ?? 'America/Guatemala';
      const day = todayIn(timezone);
      const from = localBoundary(day, timezone);
      const to = localBoundary(nextDay(day), timezone);

      const [units, stock, missed, orders] = await Promise.all([
        // Unidades por preparar y listas, solo de las bodegas que esta persona ve. Sin el filtro,
        // el vendedor de la sucursal vería el trabajo de la central y caminaría a un estante ajeno.
        tx.$queryRaw<Array<{ pending: number; ready: number }>>`
          SELECT
            coalesce(sum(CASE WHEN i."status" IN ('PENDIENTE', 'EN_PREPARACION')
                              THEN i."quantity" ELSE 0 END), 0)::int AS "pending",
            coalesce(sum(CASE WHEN i."status" = 'LISTO'
                              THEN i."quantity" ELSE 0 END), 0)::int AS "ready"
          FROM "sales_order_item" i
          JOIN "sales_order" o ON o."id" = i."orderId" AND o."tenantId" = i."tenantId"
          WHERE i."tenantId" = ${tenantId}
            AND o."status" <> 'CANCELADO'
            AND (${allowed.length === 0}::boolean OR i."warehouseId" = ANY(${allowed}::text[]))`,

        // Agotados y bajo mínimo: mismo criterio que `/api/catalog/overview`, para que el tablero y
        // el catálogo no digan números distintos de la misma cosa.
        tx.$queryRaw<Array<{ lowStock: number; outOfStock: number }>>`
          SELECT
            (SELECT count(*) FROM "inventory_level" l
              JOIN "warehouse" w ON w."id" = l."warehouseId"
              WHERE l."tenantId" = ${tenantId}
                AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
                AND l."onHand" > 0
                AND l."reorderPoint" IS NOT NULL
                AND l."onHand" - l."reserved" <= l."reorderPoint")::int AS "lowStock",
            (SELECT count(*) FROM "part_variant" v
              JOIN "part" p ON p."id" = v."partId"
              JOIN "warehouse" w ON w."tenantId" = v."tenantId"
              WHERE v."tenantId" = ${tenantId} AND v."isActive" AND p."status" = 'ACTIVO'
                AND w."isActive"
                AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
                AND NOT EXISTS (
                  SELECT 1 FROM "inventory_level" l
                  WHERE l."variantId" = v."id" AND l."warehouseId" = w."id" AND l."onHand" > 0
                ))::int AS "outOfStock"`,

        tx.$queryRaw<Array<{ missed: number }>>`
          SELECT count(*)::int AS "missed" FROM "search_event" e
          WHERE e."tenantId" = ${tenantId}
            AND e."resultCount" = 0
            AND e."createdAt" > now() - make_interval(days => 30)`,

        // La cola de trabajo: pedidos que todavía no se cerraron ni se cancelaron. Es lo que le dice
        // al dueño si la bodega va al día, y no requiere permiso de finanzas.
        tx.$queryRaw<Array<{ open: number }>>`
          SELECT count(*)::int AS "open" FROM "sales_order" o
          WHERE o."tenantId" = ${tenantId}
            AND o."status" IN ('ABIERTO', 'EN_PREPARACION', 'LISTO', 'PARCIAL')
            AND (${allowed.length === 0}::boolean OR o."warehouseId" = ANY(${allowed}::text[]))`,
      ]);

      // Ventas solo si toca verlas. La consulta ni siquiera se ejecuta sin permiso: no hay razón
      // para que el pool traiga cifras que la persona no puede leer.
      let salesCents: number | null = null;
      let ordersTodayCount: number | null = null;
      if (seesMoney) {
        const [sales] = await tx.$queryRaw<Array<{ sales: number; orders: number }>>`
          SELECT
            coalesce(sum(i."totalCents"), 0)::int AS "sales",
            count(DISTINCT i."orderId")::int AS "orders"
          FROM "sales_order_item" i
          WHERE i."tenantId" = ${tenantId}
            AND i."status" = 'ENTREGADO'
            AND i."deliveredAt" IS NOT NULL
            AND i."deliveredAt" >= ${from}
            AND i."deliveredAt" <  ${to}
            AND (${allowed.length === 0}::boolean OR i."warehouseId" = ANY(${allowed}::text[]))`;
        salesCents = Number(sales?.sales ?? 0);
        ordersTodayCount = Number(sales?.orders ?? 0);
      }

      return {
        day,
        salesCents,
        ordersTodayCount,
        pendingUnits: Number(units[0]?.pending ?? 0),
        readyUnits: Number(units[0]?.ready ?? 0),
        lowStock: Number(stock[0]?.lowStock ?? 0),
        outOfStock: Number(stock[0]?.outOfStock ?? 0),
        missedSearches: Number(missed[0]?.missed ?? 0),
        openOrders: Number(orders[0]?.open ?? 0),
      };
    });
  }
}
