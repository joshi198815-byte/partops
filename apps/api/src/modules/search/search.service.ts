import { Inject, Injectable } from '@nestjs/common';
import {
  type DemandRow,
  extractPartCodes,
  parsePartQuery,
  type SearchFacet,
  type SearchHit,
  type SearchResponse,
  type SearchVariant,
  toTsQuery,
  type VehicleVocabulary,
} from '@partops/contracts';
import { Prisma, type TxClient } from '@partops/db';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';

export interface SearchInput {
  q: string;
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  limit?: number;
  /** Desplazamiento para paginar la vitrina. El mostrador nunca lo usa. */
  offset?: number;
  /**
   * Registrar la consulta como demanda. La vitrina pagina, y la página 2 con cero resultados no es
   * una pieza que falta: es la continuación de una búsqueda que sí encontró. Se registra una vez.
   */
  record?: boolean;
  /** Conteo total para paginar. Sin esto el cliente no sabe si hay más páginas. */
  withTotal?: boolean;
  source?: string;
}

interface RawHit {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  condition: 'NUEVO' | 'USADO' | 'REMANUFACTURADO';
  unit: string;
  warrantyDays: number | null;
  imageUrl: string | null;
  codeMatch: boolean;
  score: number;
}

interface RawVariant {
  id: string;
  partId: string;
  sku: string;
  title: string;
  partNumber: string | null;
  oemNumbers: string[];
  priceCents: number;
  costCents: number;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  onHand: number;
  reserved: number;
  binLocation: string | null;
  reorderPoint: number | null;
}

interface RawVehicle {
  partId: string;
  brand: string;
  model: string;
  yearStart: number;
  yearEnd: number;
  engine: string | null;
}

/** Cinco minutos: el vocabulario cambia cuando la plataforma cura un modelo nuevo, no cada minuto. */
const VOCAB_TTL_MS = 5 * 60_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 30 días de historia: suficiente para decidir la próxima compra sin arrastrar temporadas viejas. */
const DEMAND_WINDOW_DAYS = 30;

/** Umbral de trigramas. Más bajo llena la lista de ruido; más alto pierde erratas reales. */
const TRGM_THRESHOLD = 0.15;

/**
 * Condición "esta pieza coincide con la consulta".
 *
 * Es una función y no un texto pegado en cada consulta por un motivo concreto: hay tres lugares
 * que la necesitan —resultados, facetas y orden por relevancia— y si las tres versiones divergen,
 * las facetas ofrecen un filtro que devuelve cero resultados. Se compone con `Prisma.sql`, que
 * parametriza igual que una plantilla normal.
 */
function matchesQuery(args: { codes: string[]; term: string; tsq: string; hasTerm: boolean }) {
  const { codes, term, tsq, hasTerm } = args;
  if (!codes.length && !hasTerm) return Prisma.sql`TRUE`;

  const byCode = Prisma.sql`EXISTS (
    SELECT 1 FROM "part_variant" v
    WHERE v."partId" = p."id"
      AND (
        upper(regexp_replace(v."sku", '[^A-Za-z0-9]', '', 'g')) = ANY(${codes}::text[])
        OR upper(regexp_replace(coalesce(v."partNumber", ''), '[^A-Za-z0-9]', '', 'g'))
           = ANY(${codes}::text[])
        OR EXISTS (
          SELECT 1 FROM unnest(v."oemNumbers") AS o
          WHERE upper(regexp_replace(o, '[^A-Za-z0-9]', '', 'g')) = ANY(${codes}::text[])
        )
      )
  )`;

  if (!hasTerm) return byCode;

  const byText = Prisma.sql`(
    to_tsvector('spanish', part_immutable_unaccent(coalesce(p."searchText", '')))
      @@ to_tsquery('spanish', ${tsq})
    OR similarity(lower(coalesce(p."searchText", '')), lower(${term})) > ${TRGM_THRESHOLD}
  )`;

  return codes.length ? Prisma.sql`(${byCode} OR ${byText})` : byText;
}

/**
 * Búsqueda de piezas.
 *
 * El orden de los resultados es una decisión de negocio, no un `orderBy` decorativo:
 *
 *  1. Código exacto (OEM, SKU, número de parte) primero. Quien tiene el código en la mano quiere
 *     ESA pieza, no "algo parecido con buena ortografía".
 *  2. Nombre exacto, después prefijo de nombre.
 *  3. Relevancia de texto completo en español (tsvector), y al final similitud por trigramas.
 *
 * La compatibilidad vehicular filtra, no puntúa: si el vendedor dijo "Corolla 2009", una pieza que
 * no aplica a ese año no es una pieza peor, es un error de venta. Por eso va en el `WHERE`.
 *
 * Cada consulta se registra en `search_event`, incluida —y sobre todo— la que no devolvió nada:
 * esa es la lista de compras del mes que viene.
 */
@Injectable()
export class SearchService {
  /** El vocabulario es global salvo las categorías; se cachea por tenant en un solo mapa. */
  private readonly vocabCache = new Map<string, { loadedAt: number; data: VehicleVocabulary }>();

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * Marcas, modelos y categorías.
   *
   * `vehicle_*` es referencia global sin `tenantId` (no lleva RLS) y se lee con el cliente base;
   * las categorías sí son del negocio y se leen dentro de la transacción del request.
   */
  async vocabulary(tx: TxClient, tenantId: string): Promise<VehicleVocabulary> {
    const cached = this.vocabCache.get(tenantId);
    if (cached && Date.now() - cached.loadedAt < VOCAB_TTL_MS) return cached.data;

    const [brands, models, categories] = await Promise.all([
      this.db.client.vehicleBrand.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
      this.db.client.vehicleModel.findMany({
        select: { name: true, brand: { select: { name: true } } },
        orderBy: { name: 'asc' },
      }),
      tx.partCategory.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
    ]);

    const data: VehicleVocabulary = {
      brands: brands.map((b) => b.name),
      models: models.map((m) => ({ name: m.name, brand: m.brand.name })),
      categories: categories.map((c) => c.name),
    };
    this.vocabCache.set(tenantId, { loadedAt: Date.now(), data });
    return data;
  }

  async run(ctx: Ctx, input: SearchInput): Promise<SearchResponse> {
    const started = Date.now();
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(input.offset ?? 0, 0);
    const raw = input.q.trim();

    return this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const vocab = await this.vocabulary(tx, ctx.tenant.tenantId);
      const parsed = parsePartQuery(raw, vocab);

      // Un filtro explícito de la barra de facetas gana sobre lo que se dedujo del texto: si la
      // persona escribió "faro toyota" y luego filtró Mazda, quiere Mazda.
      const brand = input.brand?.trim() || parsed.brand;
      const model = input.model?.trim() || parsed.model;
      const year = input.year ?? parsed.year;

      // `parsed.term` ya viene con el sinónimo canonizado y conserva los calificadores que no son
      // vehículo ("delanteras", "izquierdo"), que es justo lo que distingue dos piezas parecidas.
      const term = parsed.term.trim();
      const hasTerm = term.length > 0;
      /**
       * `to_tsquery('spanish', '')` revienta con error de sintaxis, y un `AND` no garantiza
       * cortocircuito en Postgres. Con un término imposible la consulta sigue siendo válida, no
       * encuentra nada por texto y deja que el código exacto mande.
       */
      const tsq = toTsQuery(term) ?? 'partopsnomatch';
      const codes = extractPartCodes(raw);

      const matched = matchesQuery({ codes, term, tsq, hasTerm });
      const vehicleFilter = buildVehicleFilter({ brand, model, year });

      const rows = await tx.$queryRaw<RawHit[]>`
        SELECT
          p."id", p."name", p."brand",
          c."name" AS "category",
          p."condition", p."unit", p."warrantyDays",
          (
            SELECT i."url" FROM "part_image" i
            WHERE i."partId" = p."id" ORDER BY i."position" ASC LIMIT 1
          ) AS "imageUrl",
          ${matchesByCodeOnly(codes)} AS "codeMatch",
          (
            CASE WHEN ${matchesByCodeOnly(codes)} THEN 1000 ELSE 0 END
            + CASE WHEN lower(p."name") = lower(${term}) THEN 400 ELSE 0 END
            + CASE WHEN lower(p."name") LIKE ${`%${term.toLowerCase()}%`} THEN 120 ELSE 0 END
            + ts_rank_cd(
                to_tsvector('spanish', part_immutable_unaccent(coalesce(p."searchText", ''))),
                to_tsquery('spanish', ${tsq})
              ) * 100
            + similarity(lower(coalesce(p."searchText", '')), lower(${term})) * 50
          ) AS "score"
        FROM "part" p
        LEFT JOIN "part_category" c ON c."id" = p."categoryId"
        WHERE p."tenantId" = ${ctx.tenant.tenantId}
          AND p."status" = 'ACTIVO'
          AND ${matched}
          AND ${vehicleFilter}
        ORDER BY "score" DESC, p."name" ASC
        LIMIT ${limit + 1} OFFSET ${offset}
      `;

      const truncated = rows.length > limit;
      const page = truncated ? rows.slice(0, limit) : rows;
      const partIds = page.map((r) => r.id);

      const [variants, vehicles, facets] = await Promise.all([
        this.variantsWithStock(tx, ctx, partIds),
        this.vehiclesFor(tx, partIds),
        this.facets(tx, {
          tenantId: ctx.tenant.tenantId,
          codes,
          term,
          tsq,
          hasTerm,
          year,
        }),
      ]);

      const hits: SearchHit[] = page.map((row) => {
        const own = variants.filter((v) => v.partId === row.id);
        return {
          partId: row.id,
          name: row.name,
          brand: row.brand,
          category: row.category,
          condition: row.condition,
          unit: row.unit,
          warrantyDays: row.warrantyDays,
          imageUrl: row.imageUrl,
          codeMatch: row.codeMatch,
          totalAvailable: own.reduce((sum, v) => sum + v.totalAvailable, 0),
          // `partId` se descarta: repetido en cada variante es ruido en el cable.
          variants: own.map(({ partId: _p, ...v }) => v),
          vehicles: vehicles.filter((v) => v.partId === row.id).map(({ partId: _p, ...v }) => v),
        };
      });

      // El registro va DESPUÉS de calcular, y con el conteo real: "sin resultado" es la señal que
      // dispara la lista de compras, y solo es cierta si refleja lo que de verdad se encontró.
      // En la vitrina solo registra la primera página: la dos con cero resultados no es una pieza
      // que falta, es la continuación de una búsqueda que sí encontró.
      if (input.record !== false && offset === 0) {
        await this.record(tx, ctx, {
          raw,
          parsed,
          brand,
          model,
          year,
          resultCount: hits.length,
          source: input.source ?? 'MOSTRADOR',
        });
      }

      // El conteo se pide solo cuando alguien va a paginar. `count(*)` sobre el mismo `WHERE` es
      // barato comparado con traer la página, pero no gratis: el mostrador no lo necesita.
      const total = input.withTotal
        ? Number(
            (
              await tx.$queryRaw<{ total: bigint }[]>`
                SELECT count(*) AS "total"
                FROM "part" p
                WHERE p."tenantId" = ${ctx.tenant.tenantId}
                  AND p."status" = 'ACTIVO'
                  AND ${matched}
                  AND ${vehicleFilter}`
            )[0]?.total ?? 0,
          )
        : offset + hits.length + (truncated ? 1 : 0);

      return {
        query: raw,
        parsed: {
          term,
          brand,
          model,
          year,
          suggestions: parsed.suggestions,
          synonym: parsed.termFromSynonym,
        },
        hits,
        facets,
        total,
        truncated,
        tookMs: Date.now() - started,
      };
    });
  }

  /** Variantes con existencia por bodega, respetando las bodegas asignadas al usuario. */
  private async variantsWithStock(
    tx: TxClient,
    ctx: Ctx,
    partIds: string[],
  ): Promise<(SearchVariant & { partId: string })[]> {
    if (!partIds.length) return [];
    const allowed = ctx.tenant.warehouseIds;
    const showCost = ctx.tenant.permissions.has('catalog.cost.view');

    const rows = await tx.$queryRaw<RawVariant[]>`
      SELECT
        v."id", v."partId", v."sku", v."title", v."partNumber", v."oemNumbers",
        v."priceCents", v."costCents",
        w."id" AS "warehouseId", w."code" AS "warehouseCode", w."name" AS "warehouseName",
        coalesce(l."onHand", 0) AS "onHand",
        coalesce(l."reserved", 0) AS "reserved",
        l."binLocation", l."reorderPoint"
      FROM "part_variant" v
      CROSS JOIN "warehouse" w
      LEFT JOIN "inventory_level" l
        ON l."variantId" = v."id" AND l."warehouseId" = w."id"
      WHERE v."partId" = ANY(${partIds}::text[])
        AND v."isActive" = true
        AND w."tenantId" = ${ctx.tenant.tenantId}
        AND w."isActive" = true
        AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
      ORDER BY v."position" ASC, v."sku" ASC, w."code" ASC
    `;

    const byVariant = new Map<string, SearchVariant & { partId: string }>();
    for (const r of rows) {
      let variant = byVariant.get(r.id);
      if (!variant) {
        variant = {
          id: r.id,
          partId: r.partId,
          sku: r.sku,
          title: r.title,
          partNumber: r.partNumber,
          oemNumbers: r.oemNumbers ?? [],
          priceCents: Number(r.priceCents),
          costCents: showCost ? Number(r.costCents) : null,
          totalAvailable: 0,
          availability: [],
        };
        byVariant.set(r.id, variant);
      }
      const available = Number(r.onHand) - Number(r.reserved);
      variant.totalAvailable += available;
      variant.availability.push({
        warehouseId: r.warehouseId,
        warehouseCode: r.warehouseCode,
        warehouseName: r.warehouseName,
        available,
        binLocation: r.binLocation,
        reorderPoint: r.reorderPoint === null ? null : Number(r.reorderPoint),
      });
    }
    return [...byVariant.values()];
  }

  private async vehiclesFor(tx: TxClient, partIds: string[]): Promise<RawVehicle[]> {
    if (!partIds.length) return [];
    return tx.$queryRaw<RawVehicle[]>`
      SELECT
        pc."partId",
        vb."name" AS "brand",
        vm."name" AS "model",
        veh."yearStart", veh."yearEnd", veh."engine"
      FROM "part_compatibility" pc
      JOIN "vehicle" veh ON veh."id" = pc."vehicleId"
      JOIN "vehicle_model" vm ON vm."id" = veh."modelId"
      JOIN "vehicle_brand" vb ON vb."id" = vm."brandId"
      WHERE pc."partId" = ANY(${partIds}::text[])
      ORDER BY vb."name" ASC, vm."name" ASC, veh."yearStart" ASC
      LIMIT 200
    `;
  }

  /**
   * Facetas sobre el texto, sin aplicar marca/modelo: si se aplicaran, al elegir Toyota
   * desaparecerían Nissan y Mazda y no habría forma de volver atrás sin borrar el filtro.
   *
   * El AÑO sí se aplica, porque no es una faceta que se pueda quitar con un clic: viene del texto
   * ("corolla 2009"). Sin él, el contador diría "Toyota 2" sobre una lista de 1 y el vendedor
   * creería que el filtro está roto.
   */
  private async facets(
    tx: TxClient,
    args: {
      tenantId: string;
      codes: string[];
      term: string;
      tsq: string;
      hasTerm: boolean;
      year: number | null;
    },
  ): Promise<{ brands: SearchFacet[]; models: SearchFacet[] }> {
    const matched = matchesQuery(args);
    const yearOnly = buildVehicleFilter({ brand: null, model: null, year: args.year });

    const rows = await tx.$queryRaw<{ brand: string; model: string; count: bigint }[]>`
      WITH matched AS (
        SELECT p."id"
        FROM "part" p
        WHERE p."tenantId" = ${args.tenantId}
          AND p."status" = 'ACTIVO'
          AND ${matched}
          AND ${yearOnly}
      )
      SELECT vb."name" AS "brand", vm."name" AS "model", count(DISTINCT m."id") AS "count"
      FROM matched m
      JOIN "part_compatibility" pc ON pc."partId" = m."id"
      JOIN "vehicle" veh ON veh."id" = pc."vehicleId"
      JOIN "vehicle_model" vm ON vm."id" = veh."modelId"
      JOIN "vehicle_brand" vb ON vb."id" = vm."brandId"
      GROUP BY vb."name", vm."name"
      ORDER BY "count" DESC, vb."name" ASC, vm."name" ASC
      LIMIT 60
    `;

    const brandCounts = new Map<string, number>();
    for (const r of rows) brandCounts.set(r.brand, (brandCounts.get(r.brand) ?? 0) + Number(r.count));

    return {
      brands: [...brandCounts]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 12),
      models: rows.slice(0, 20).map((r) => ({
        name: r.model,
        brand: r.brand,
        count: Number(r.count),
      })),
    };
  }

  private async record(
    tx: TxClient,
    ctx: Ctx,
    args: {
      raw: string;
      parsed: ReturnType<typeof parsePartQuery>;
      brand: string | null;
      model: string | null;
      year: number | null;
      resultCount: number;
      source: string;
    },
  ): Promise<void> {
    if (!args.raw) return;
    await tx.searchEvent.create({
      data: {
        tenantId: ctx.tenant.tenantId,
        rawQuery: args.raw.slice(0, 240),
        // El término canónico, no el texto crudo: así "capó" y "capo" cuentan como la misma
        // demanda y la lista de compras no se parte en diez variantes de la misma palabra.
        normalized: (args.parsed.term || args.parsed.normalized).slice(0, 160),
        brand: args.brand,
        model: args.model,
        year: args.year,
        resultCount: args.resultCount,
        source: args.source,
      },
    });
  }

  /**
   * Demanda incumplida del periodo.
   *
   * Se calcula sobre `search_event` en vivo en vez de esperar el rollup diario: con el volumen de
   * una bodega (miles de filas al mes) es barato, y un reporte que solo aparece "mañana" no se usa.
   * El rollup de `demand_daily` sigue existiendo para el histórico largo.
   */
  async demand(ctx: Ctx): Promise<DemandRow[]> {
    const rows = await this.db.tx(
      ctx.tenant.tenantId,
      (tx) =>
        tx.$queryRaw<
          {
            term: string;
            brand: string | null;
            model: string | null;
            year: number | null;
            searches: bigint;
            withResults: bigint;
            missedCount: bigint;
            lastSeenAt: Date | null;
          }[]
        >`
        SELECT
          "normalized" AS "term",
          max("brand") AS "brand",
          max("model") AS "model",
          max("year") AS "year",
          count(*) AS "searches",
          count(*) FILTER (WHERE "resultCount" > 0) AS "withResults",
          count(*) FILTER (WHERE "resultCount" = 0) AS "missedCount",
          max("createdAt") AS "lastSeenAt"
        FROM "search_event"
        WHERE "tenantId" = ${ctx.tenant.tenantId}
          AND "createdAt" > now() - make_interval(days => ${DEMAND_WINDOW_DAYS})
        GROUP BY "normalized"
        HAVING count(*) FILTER (WHERE "resultCount" = 0) > 0
        ORDER BY "missedCount" DESC, "searches" DESC
        LIMIT 50
      `,
    );

    return rows.map((r) => ({
      term: r.term,
      brand: r.brand,
      model: r.model,
      year: r.year,
      searches: Number(r.searches),
      withResults: Number(r.withResults),
      missedCount: Number(r.missedCount),
      lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
    }));
  }

  /** Invalida el vocabulario de un negocio cuando cambian sus categorías. */
  invalidate(tenantId: string): void {
    this.vocabCache.delete(tenantId);
  }
}

/** Solo código: es el criterio que ordena primero y no depende del texto. */
function matchesByCodeOnly(codes: string[]) {
  if (!codes.length) return Prisma.sql`FALSE`;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "part_variant" v
    WHERE v."partId" = p."id"
      AND (
        upper(regexp_replace(v."sku", '[^A-Za-z0-9]', '', 'g')) = ANY(${codes}::text[])
        OR upper(regexp_replace(coalesce(v."partNumber", ''), '[^A-Za-z0-9]', '', 'g'))
           = ANY(${codes}::text[])
        OR EXISTS (
          SELECT 1 FROM unnest(v."oemNumbers") AS o
          WHERE upper(regexp_replace(o, '[^A-Za-z0-9]', '', 'g')) = ANY(${codes}::text[])
        )
      )
  )`;
}

/** Compatibilidad vehicular. `TRUE` cuando no se filtró por vehículo. */
function buildVehicleFilter(args: { brand: string | null; model: string | null; year: number | null }) {
  const { brand, model, year } = args;
  if (brand === null && model === null && year === null) return Prisma.sql`TRUE`;
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "part_compatibility" pc
    JOIN "vehicle" veh ON veh."id" = pc."vehicleId"
    JOIN "vehicle_model" vm ON vm."id" = veh."modelId"
    JOIN "vehicle_brand" vb ON vb."id" = vm."brandId"
    WHERE pc."partId" = p."id"
      AND (${brand}::text IS NULL OR lower(vb."name") = lower(${brand}))
      AND (${model}::text IS NULL OR lower(vm."name") = lower(${model}))
      AND (${year}::int IS NULL OR ${year} BETWEEN veh."yearStart" AND veh."yearEnd")
  )`;
}
