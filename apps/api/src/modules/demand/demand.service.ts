import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEMAND_EVENT_RETENTION_DAYS,
  DEMAND_ROLLUP_DAYS,
  DEMAND_WINDOW_DAYS,
  type DemandCategoryRow,
  type DemandMonthRow,
  type DemandOverview,
  type DemandTimelineRow,
  type DemandTotals,
  type DemandVehicleRow,
  normalizeQuery,
} from '@partops/contracts';
import type { TxClient } from '@partops/db';
import type { Ctx } from '../../common/context.js';
import {
  daysAgo,
  daysBetween,
  localBoundary,
  localDay,
  nextDay,
  shiftDay,
  todayIn,
} from '../../common/time.js';
import { DatabaseService } from '../../infra/database.module.js';
import { SearchService } from '../search/search.service.js';

/**
 * Demanda incumplida.
 *
 * Tres piezas que se sostienen entre sí y que por eso viven juntas:
 *
 *  1. **El panel** (`overview`) lee `search_event` en vivo: un reporte que solo aparece "mañana"
 *     no sirve para decidir la compra de hoy.
 *  2. **El rollup** copia cada día cerrado a `demand_daily`. Es lo único que sobrevive a la purga,
 *     y es lo que permite decir "en marzo buscaron esto 400 veces" un año después.
 *  3. **La retención** borra eventos viejos, nunca agregados. El texto crudo de lo que tecleó una
 *     persona deja de ser útil a los 30 días; el conteo no caduca.
 *
 * La zona horaria sale del negocio y no de UTC: en Guatemala el día cierra a las 18:00 UTC, y un
 * rollup en UTC partiría la venta del sábado por la tarde en dos días distintos.
 */

/** Tope de días que recalcula una sola corrida. Más atrás ya está agregado y no cambia. */
const MAX_ROLLUP_DAYS = 400;

interface RawTotals {
  searches: bigint;
  withResults: bigint;
  missed: bigint;
  catalogSearches: bigint;
}

interface TotalsSummary {
  searches: number;
  withResults: number;
  missed: number;
  catalogSearches: number;
  catalogOrders: number;
}

@Injectable()
export class DemandService {
  private readonly log = new Logger(DemandService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(SearchService) private readonly search: SearchService,
  ) {}

  // ───────────────────────────── Panel ─────────────────────────────

  /**
   * Todo lo que el panel necesita en una sola llamada.
   *
   * Cinco consultas cortas en paralelo en vez de una con cinco `UNION`: cada una se lee y se
   * explica sola, y el planificador las corre en conexiones distintas del pool. El panel se abre
   * decenas de veces al día; mantenerlo legible cuesta menos que ahorrar tres milisegundos.
   */
  async overview(ctx: Ctx): Promise<DemandOverview> {
    const tenantId = ctx.tenant.tenantId;
    const timezone = await this.timezoneOf(tenantId);

    const [totals, byVehicle, byCategory, timeline, months, topTerms, watchers] = await Promise.all([
      this.totals(tenantId),
      this.byVehicle(tenantId),
      this.byCategory(tenantId),
      this.timeline(tenantId, timezone),
      this.months(tenantId),
      this.search.demand(ctx),
      this.pendingWatchers(tenantId),
    ]);

    const data: DemandTotals = {
      searches: totals.searches,
      withResults: totals.withResults,
      missed: totals.missed,
      missedRateBps: bps(totals.missed, totals.searches),
      catalogOrders: totals.catalogOrders,
      conversionBps: bps(totals.catalogOrders, totals.catalogSearches),
      watchers,
    };

    return {
      windowDays: DEMAND_WINDOW_DAYS,
      totals: data,
      topTerms,
      byVehicle,
      byCategory,
      timeline,
      months,
    };
  }

  private async totals(tenantId: string): Promise<TotalsSummary> {
    return this.db.tx(tenantId, async (tx) => {
      const [searches] = await tx.$queryRaw<RawTotals[]>`
        SELECT
          count(*) AS "searches",
          count(*) FILTER (WHERE "resultCount" > 0) AS "withResults",
          count(*) FILTER (WHERE "resultCount" = 0) AS "missed",
          count(*) FILTER (WHERE "source" = 'CATALOGO') AS "catalogSearches"
        FROM "search_event"
        WHERE "tenantId" = ${tenantId}
          AND "createdAt" > now() - make_interval(days => ${DEMAND_WINDOW_DAYS})`;

      const [orders] = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM "sales_order"
        WHERE "tenantId" = ${tenantId}
          AND "channel" = 'CATALOGO'
          AND "createdAt" > now() - make_interval(days => ${DEMAND_WINDOW_DAYS})`;

      return {
        searches: Number(searches?.searches ?? 0),
        withResults: Number(searches?.withResults ?? 0),
        missed: Number(searches?.missed ?? 0),
        catalogSearches: Number(searches?.catalogSearches ?? 0),
        catalogOrders: Number(orders?.count ?? 0),
      };
    });
  }

  /** Personas esperando una pieza. Cuenta avisos, no clientes: alguien puede esperar dos cosas. */
  private async pendingWatchers(tenantId: string): Promise<number> {
    return this.db.tx(tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM "stock_watch"
        WHERE "tenantId" = ${tenantId} AND "notifiedAt" IS NULL`;
      return Number(row?.count ?? 0);
    });
  }

  /**
   * Por vehículo.
   *
   * Se ordena por faltantes y no por búsquedas: un modelo que se busca mucho y siempre se encuentra
   * no dice nada nuevo. El año se conserva porque "Corolla 2009" y "Corolla 2015" son compras
   * distintas aunque compartan modelo.
   */
  private async byVehicle(tenantId: string): Promise<DemandVehicleRow[]> {
    return this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        { brand: string; model: string; year: number | null; searches: bigint; missed: bigint }[]
      >`
        SELECT "brand", "model", "year",
               count(*) AS "searches",
               count(*) FILTER (WHERE "resultCount" = 0) AS "missed"
        FROM "search_event"
        WHERE "tenantId" = ${tenantId}
          AND "createdAt" > now() - make_interval(days => ${DEMAND_WINDOW_DAYS})
          AND "brand" IS NOT NULL
        GROUP BY "brand", "model", "year"
        ORDER BY "missed" DESC, "searches" DESC
        LIMIT 15`;
      return rows.map((r) => ({
        brand: r.brand,
        model: r.model ?? '—',
        year: r.year,
        searches: Number(r.searches),
        missed: Number(r.missed),
      }));
    });
  }

  /**
   * Por categoría.
   *
   * El término de la búsqueda ya viene canonizado ("cubierta" → "capo"), así que se compara contra
   * el nombre normalizado de las categorías del negocio. La clasificación se hace en memoria con
   * las categorías reales: un `JOIN` con `unaccent` sobre cada fila de evento sería más lento y,
   * peor, ataría el reporte a cómo estén escritas las categorías hoy.
   */
  private async byCategory(tenantId: string): Promise<DemandCategoryRow[]> {
    const { categories, terms } = await this.db.tx(tenantId, async (tx) => {
      const cats = await tx.partCategory.findMany({ select: { name: true }, orderBy: { name: 'asc' } });
      const rows = await tx.$queryRaw<{ term: string; searches: bigint; missed: bigint }[]>`
        SELECT "normalized" AS "term",
               count(*) AS "searches",
               count(*) FILTER (WHERE "resultCount" = 0) AS "missed"
        FROM "search_event"
        WHERE "tenantId" = ${tenantId}
          AND "createdAt" > now() - make_interval(days => ${DEMAND_WINDOW_DAYS})
        GROUP BY "normalized"
        ORDER BY 3 DESC, 2 DESC
        LIMIT 200`;
      return { categories: cats.map((c) => c.name), terms: rows };
    });

    const known = categories
      .map((name) => ({ name, norm: normalizeQuery(name) }))
      .filter((c) => c.norm.length >= 3)
      // El más largo gana: "pastillas de freno" clasifica mejor que "pastillas" si las dos existen.
      .sort((a, b) => b.norm.length - a.norm.length);

    const acc = new Map<string, { searches: number; missed: number }>();
    for (const row of terms) {
      const tokens = ` ${row.term} `;
      const match = known.find((c) => tokens.includes(` ${c.norm} `));
      const key = match?.name ?? 'Sin clasificar';
      const prev = acc.get(key) ?? { searches: 0, missed: 0 };
      acc.set(key, {
        searches: prev.searches + Number(row.searches),
        missed: prev.missed + Number(row.missed),
      });
    }

    return [...acc]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.missed - a.missed || b.searches - a.searches)
      .slice(0, 12);
  }

  /**
   * Serie diaria de la ventana.
   *
   * Se rellenan los días sin actividad en memoria en vez de con `generate_series` en SQL: el eje
   * tiene que estar completo para que la gráfica no mienta, y cuesta treinta iteraciones.
   */
  private async timeline(tenantId: string, timezone: string): Promise<DemandTimelineRow[]> {
    const rows = await this.db.tx(tenantId, async (tx) => {
      const days = await tx.$queryRaw<{ day: string; searches: bigint; missed: bigint }[]>`
        SELECT to_char(${localDay('"createdAt"', timezone)}, 'YYYY-MM-DD') AS "day",
               count(*) AS "searches",
               count(*) FILTER (WHERE "resultCount" = 0) AS "missed"
        FROM "search_event"
        WHERE "tenantId" = ${tenantId}
          AND "createdAt" > now() - make_interval(days => ${DEMAND_WINDOW_DAYS})
        GROUP BY 1`;

      const orders = await tx.$queryRaw<{ day: string; count: bigint }[]>`
        SELECT to_char(${localDay('"createdAt"', timezone)}, 'YYYY-MM-DD') AS "day",
               count(*) AS "count"
        FROM "sales_order"
        WHERE "tenantId" = ${tenantId}
          AND "channel" = 'CATALOGO'
          AND "createdAt" > now() - make_interval(days => ${DEMAND_WINDOW_DAYS})
        GROUP BY 1`;
      return { days, orders };
    });

    const searchesByDay = new Map(rows.days.map((d) => [d.day, d]));
    const ordersByDay = new Map(rows.orders.map((d) => [d.day, Number(d.count)]));

    // El eje se arma con los días locales, no con los de UTC: a las 18:00 de Guatemala ya es el día
    // siguiente en UTC y la gráfica terminaría mostrando un día que en la bodega no ha empezado.
    const todayLocal = todayIn(timezone);
    const out: DemandTimelineRow[] = [];
    for (let i = DEMAND_WINDOW_DAYS - 1; i >= 0; i -= 1) {
      const day = shiftDay(todayLocal, -i);
      const row = searchesByDay.get(day);
      out.push({
        day,
        searches: Number(row?.searches ?? 0),
        missed: Number(row?.missed ?? 0),
        orders: ordersByDay.get(day) ?? 0,
      });
    }
    return out;
  }

  /**
   * Evolución mensual desde el agregado.
   *
   * Doce meses y no la vida entera: una bodega decide con el año en curso en la cabeza. Lo de antes
   * sigue en la tabla y lo lee el reporte de compras cuando haga falta.
   */
  private async months(tenantId: string): Promise<DemandMonthRow[]> {
    return this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ month: string; searches: bigint; missed: bigint }[]>`
        SELECT to_char("day", 'YYYY-MM') AS "month",
               sum("searches")::bigint AS "searches",
               sum("missedCount")::bigint AS "missed"
        FROM "demand_daily"
        WHERE "tenantId" = ${tenantId}
          AND "day" >= (current_date - interval '12 months')
        GROUP BY 1
        ORDER BY 1`;
      return rows.map((r) => ({
        month: r.month,
        searches: Number(r.searches),
        missed: Number(r.missed),
      }));
    });
  }

  // ───────────────────────────── Rollup y retención ─────────────────────────────

  /**
   * Recalcula el agregado de un negocio para un rango de días.
   *
   * Borra e inserta en la misma transacción en vez de `upsert` fila por fila. Un día se recalcula
   * completo o no se toca: si una corrida se cae a la mitad, la transacción se revierte y el día
   * queda como estaba, en vez de a medio actualizar con conteos de dos corridas distintas.
   */
  async rollupTenant(tenantId: string, timezone: string, fromDay: string, toDay: string): Promise<number> {
    return this.db.tx(tenantId, async (tx) => {
      await this.deleteRange(tx, tenantId, fromDay, toDay);
      const inserted = await tx.$executeRaw`
        INSERT INTO "demand_daily"
          ("tenantId", "day", "term", "brand", "model", "year", "searches", "withResults", "missedCount")
        SELECT
          ${tenantId},
          ${localDay('"createdAt"', timezone)} AS "day",
          "normalized" AS "term",
          max("brand"), max("model"), max("year"),
          count(*),
          count(*) FILTER (WHERE "resultCount" > 0),
          count(*) FILTER (WHERE "resultCount" = 0)
        FROM "search_event"
        WHERE "tenantId" = ${tenantId}
          -- Los límites del día se calculan en la zona del negocio y se comparan en UTC, que es
          -- como está guardado createdAt: así el índice de (tenantId, createdAt) sirve.
          AND "createdAt" >= ${localBoundary(fromDay, timezone)}
          AND "createdAt" <  ${localBoundary(nextDay(toDay), timezone)}
        GROUP BY 1, 2, 3
        ON CONFLICT ("tenantId", "day", "term") DO NOTHING`;
      return Number(inserted);
    });
  }

  private async deleteRange(tx: TxClient, tenantId: string, fromDay: string, toDay: string) {
    await tx.$executeRaw`
      DELETE FROM "demand_daily"
      WHERE "tenantId" = ${tenantId}
        AND "day" >= ${fromDay}::date
        AND "day" <= ${toDay}::date`;
  }

  /**
   * Mantenimiento diario: agregar y después purgar.
   *
   * El orden es la única regla dura. Se agrega desde el evento más viejo que exista —no solo los
   * últimos tres días— porque si el proceso estuvo caído una semana, purgar primero borraría una
   * semana de demanda que nadie alcanzó a contar. Purgar es irreversible; agregar no.
   */
  async runDaily(): Promise<{ tenants: number; rolledDays: number; purgedEvents: number }> {
    const tenants = await this.db.system(
      (tx) => tx.$queryRaw<{ id: string; timezone: string }[]>`SELECT "id", "timezone" FROM "tenant"`,
    );

    let rolledDays = 0;
    let purgedEvents = 0;

    for (const tenant of tenants) {
      try {
        const span = await this.db.tx(tenant.id, async (tx) => {
          const [row] = await tx.$queryRaw<{ from: string | null; to: string | null }[]>`
            SELECT
              to_char(min(${localDay('"createdAt"', tenant.timezone)}), 'YYYY-MM-DD') AS "from",
              to_char(max(${localDay('"createdAt"', tenant.timezone)}), 'YYYY-MM-DD') AS "to"
            FROM "search_event" WHERE "tenantId" = ${tenant.id}`;
          return row ?? { from: null, to: null };
        });
        if (!span.from || !span.to) continue;

        const from = laterOf(span.from, daysAgo(MAX_ROLLUP_DAYS));
        // Hasta hoy aunque no haya eventos: un día recién agregado puede quedar desactualizado si
        // entra una búsqueda con la marca de tiempo del día anterior.
        const to = todayIn(tenant.timezone);
        if (from > to) continue;
        await this.rollupTenant(tenant.id, tenant.timezone, from, to);
        rolledDays += daysBetween(from, to);

        purgedEvents += await this.purgeEvents(tenant.id, tenant.timezone);
      } catch (err) {
        // Un negocio con datos raros no puede frenar el mantenimiento de los demás.
        this.log.error(`Rollup de demanda falló para ${tenant.id}: ${(err as Error).message}`);
      }
    }

    return { tenants: tenants.length, rolledDays, purgedEvents };
  }

  /**
   * Borra eventos fuera de la ventana de retención.
   *
   * Solo el texto crudo se va. Los agregados de esos días ya están escritos y no se tocan: borrar
   * `demand_daily` sería borrar la historia de la bodega para ahorrar unos kilobytes.
   */
  private async purgeEvents(tenantId: string, timezone: string): Promise<number> {
    const cutoff = daysAgo(DEMAND_EVENT_RETENTION_DAYS);
    const deleted = await this.db.tx(
      tenantId,
      (tx) =>
        tx.$executeRaw`
        DELETE FROM "search_event"
        WHERE "tenantId" = ${tenantId}
          AND "createdAt" < ${localBoundary(cutoff, timezone)}`,
    );
    return Number(deleted);
  }

  /** Recalcula los últimos días de un negocio: botón del panel y respaldo del cron manual. */
  async recomputeRecent(ctx: Ctx): Promise<{ days: number }> {
    const timezone = await this.timezoneOf(ctx.tenant.tenantId);
    const to = todayIn(timezone);
    const from = daysAgo(DEMAND_ROLLUP_DAYS);
    await this.rollupTenant(ctx.tenant.tenantId, timezone, from, to);
    return { days: daysBetween(from, to) };
  }

  private async timezoneOf(tenantId: string): Promise<string> {
    return this.db.system(async (tx) => {
      const row = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
      return row?.timezone ?? 'America/Guatemala';
    });
  }
}
/**
 * Puntos base con denominador cero: 0, no `Infinity` ni `NaN` en el JSON.
 *
 * Los helpers de fecha (`localDay`, `localBoundary`, `nextDay`, `daysAgo`, `todayIn`, `shiftDay`,
 * `daysBetween`) viven en `common/time.ts` y se comparten con finanzas: el corte del día tiene que
 * ser el mismo en los dos reportes o el mismo sábado cae en días distintos según la pantalla.
 */
function bps(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 10_000);
}

function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

/** Exportado para las pruebas: el rango de un día tiene que incluir el último segundo. */
export const __test = { daysAgo, todayIn, laterOf, daysBetween, shiftDay, nextDay };
