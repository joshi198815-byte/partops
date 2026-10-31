import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AvailabilityBucket,
  availabilityBucket,
  catalogInquiryMessage,
  extractPartCodes,
  normalizeGtPhone,
  normalizeQuery,
  type ParsedQuery,
  type PartConditionKey,
  PUBLIC_PAGE_SIZE,
  type PublicAvailability,
  type PublicCatalogItem,
  type PublicCatalogQuery,
  type PublicCatalogResponse,
  type PublicFacet,
  type PublicFacetModel,
  type PublicOrderData,
  type PublicOrderLine,
  type PublicOrderResult,
  type PublicPart,
  type PublicPartResponse,
  type PublicShop,
  type PublicVariant,
  type PublicVehicle,
  parsePartQuery,
  publicOrderWhatsAppMessage,
  type StockWatchInput,
  shopWhatsAppUrl,
  toTsQuery,
  type VehicleVocabulary,
} from '@partops/contracts';
import { Prisma, type TxClient } from '@partops/db';
import type { Ctx } from '../../common/context.js';
import { env } from '../../config/env.js';
import { DatabaseService } from '../../infra/database.module.js';
import { StockWatchService } from '../demand/stock-watch.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { PublicGuardService, type PublicScope } from './public-guard.service.js';

/**
 * Catálogo público de un negocio.
 *
 * Es la superficie más expuesta del sistema: sin sesión, en internet abierto, con datos de negocio
 * reales. Las reglas que la separan del catálogo interno:
 *
 *  1. **Solo bodegas con `sellsOnline`.** Publicar la existencia de una sucursal cerrada o de un
 *     depósito fiscal genera un pedido que nadie puede surtir.
 *  2. **Solo piezas activas y con al menos una variante activa.** Una pieza archivada no debe
 *     aparecer ni por enlace directo.
 *  3. **Sin costo.** No hay una sola columna de costo en las consultas de este archivo.
 *  4. **La existencia es un cubo, no un número.** `HAY` / `POCAS` / `AGOTADO`: el número exacto es
 *     información competitiva y una promesa que cambia mientras el cliente lee.
 *  5. **El tenant sale del slug, nunca de la URL del pedido.** Un `?tenantId=` sería un oráculo para
 *     recorrer la base.
 */

/** Piezas por página. Veinte tarjetas caben en dos pantallas de teléfono sin scroll infinito. */
const PAGE_SIZE = PUBLIC_PAGE_SIZE;

interface RawItem {
  partId: string;
  name: string;
  slug: string;
  brand: string | null;
  category: string | null;
  condition: string;
  unit: string;
  warrantyDays: number | null;
  description: string | null;
  imageUrl: string | null;
  imageFallbackUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  priceMin: number;
  priceMax: number;
  updatedAt: Date;
}

interface RawVariant {
  variantId: string;
  partId: string;
  sku: string;
  title: string;
  partNumber: string | null;
  oemNumbers: string[] | null;
  priceCents: number;
  warehouseName: string;
  onHand: number;
  reserved: number;
}

@Injectable()
export class PublicCatalogService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(PublicGuardService) private readonly guard: PublicGuardService,
    @Inject(StockWatchService) private readonly watches: StockWatchService,
  ) {}

  // ───────────────────────────── Negocio ─────────────────────────────

  /**
   * Negocio por slug.
   *
   * Un slug inexistente, uno deshabilitado y uno suspendido dan el MISMO 404: si el mensaje
   * cambiara, cualquiera podría enumerar qué bodegas existen y cuáles están al día con el pago.
   */
  async shop(slug: string): Promise<PublicShop> {
    const clean = slug.trim().toLowerCase();
    if (!/^[a-z0-9-]{2,48}$/.test(clean)) throw notFound();

    const tenant = await this.db.system((tx) =>
      tx.tenant.findUnique({
        where: { slug: clean },
        select: {
          slug: true,
          name: true,
          catalogTagline: true,
          address: true,
          phone: true,
          whatsapp: true,
          logoUrl: true,
          brandPrimary: true,
          brandAccent: true,
          currency: true,
          pricesIncludeTax: true,
          taxRateBps: true,
          catalogEnabled: true,
          suspended: true,
        },
      }),
    );
    if (!tenant?.catalogEnabled || tenant.suspended) throw notFound();

    return {
      slug: tenant.slug,
      name: tenant.name,
      tagline: tenant.catalogTagline,
      address: tenant.address,
      phone: tenant.phone,
      whatsappE164: digits(tenant.whatsapp ?? tenant.phone),
      logoUrl: tenant.logoUrl,
      brandPrimary: tenant.brandPrimary,
      brandAccent: tenant.brandAccent,
      currency: tenant.currency,
      pricesIncludeTax: tenant.pricesIncludeTax,
      taxRateBps: tenant.taxRateBps,
    };
  }

  /** Resuelve el negocio y devuelve su id, para no repetir la consulta en cada método. */
  private async shopId(slug: string): Promise<{ shop: PublicShop; tenantId: string }> {
    const shop = await this.shop(slug);
    const row = await this.db.system((tx) =>
      tx.tenant.findUnique({ where: { slug: shop.slug }, select: { id: true } }),
    );
    if (!row) throw notFound();
    return { shop, tenantId: row.id };
  }

  // ───────────────────────────── Listado ─────────────────────────────

  /**
   * Vitrina paginada.
   *
   * Una sola transacción con RLS fijado al negocio resuelto por slug: aunque la consulta olvidara el
   * `WHERE tenantId`, la política de la base la cortaría igual.
   */
  async list(slug: string, query: PublicCatalogQuery): Promise<PublicCatalogResponse> {
    const { shop, tenantId } = await this.shopId(slug);
    const page = Math.max(query.page, 1);
    const offset = (page - 1) * PAGE_SIZE;
    const raw = query.q.trim();

    return this.db.tx(tenantId, async (tx) => {
      const vocab = await this.vocabulary(tx);
      const parsed = parsePartQuery(raw, vocab);
      const brand = query.brand?.trim() || parsed.brand;
      const model = query.model?.trim() || parsed.model;
      const year = query.year ?? parsed.year;
      const term = parsed.term.trim();
      const tsq = toTsQuery(term) ?? 'partopspublicnomatch';
      const codes = extractPartCodes(raw);

      const filter = this.listFilter({ tenantId, codes, term, tsq, brand, model, year });

      const [rows, countRow] = await Promise.all([
        tx.$queryRaw<RawItem[]>`
          SELECT
            p."id" AS "partId", p."name", p."slug", p."brand",
            c."name" AS "category", p."condition"::text AS "condition", p."unit",
            p."warrantyDays", p."description",
            img."url" AS "imageUrl", img."fallbackUrl" AS "imageFallbackUrl",
            img."width" AS "imageWidth", img."height" AS "imageHeight",
            st."priceMin", st."priceMax", p."updatedAt"
          FROM "part" p
          LEFT JOIN "part_category" c ON c."id" = p."categoryId"
          LEFT JOIN LATERAL (
            SELECT i."url", i."fallbackUrl", i."width", i."height"
            FROM "part_image" i WHERE i."partId" = p."id"
            ORDER BY i."position" ASC LIMIT 1
          ) img ON TRUE
          JOIN LATERAL (
            SELECT min(v."priceCents") AS "priceMin", max(v."priceCents") AS "priceMax"
            FROM "part_variant" v
            WHERE v."partId" = p."id" AND v."isActive"
          ) st ON st."priceMin" IS NOT NULL
          WHERE ${filter}
          ORDER BY p."name" ASC
          LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
        tx.$queryRaw<{ total: bigint }[]>`
          SELECT count(*) AS "total" FROM "part" p WHERE ${filter}`,
      ]);

      const partIds = rows.map((r) => r.partId);
      const [variants, vehicles, facets] = await Promise.all([
        this.variantsFor(tx, partIds),
        this.vehiclesFor(tx, partIds),
        this.facets(tx, { tenantId, codes, term, tsq, year }),
      ]);

      return {
        shop,
        filters: { q: raw, brand, model, year },
        items: rows.map((row) => this.toItem(row, variants, vehicles)),
        total: Number(countRow[0]?.total ?? 0),
        page,
        pageSize: PAGE_SIZE,
        facets,
        turnstile: { required: this.guard.siteKey !== null, siteKey: this.guard.siteKey },
      };
    });
  }

  /** Pieza por slug o SKU. El segundo es lo que se pega desde un WhatsApp con la referencia. */
  async part(slug: string, key: string): Promise<PublicPartResponse> {
    const { shop, tenantId } = await this.shopId(slug);
    const needle = key.trim().toLowerCase();

    const result = await this.db.tx(tenantId, async (tx) => {
      const row = await tx.$queryRaw<RawItem[]>`
        SELECT
          p."id" AS "partId", p."name", p."slug", p."brand",
          c."name" AS "category", p."condition"::text AS "condition", p."unit",
          p."warrantyDays", p."description",
          img."url" AS "imageUrl", img."fallbackUrl" AS "imageFallbackUrl",
          img."width" AS "imageWidth", img."height" AS "imageHeight",
          st."priceMin", st."priceMax", p."updatedAt"
        FROM "part" p
        LEFT JOIN "part_category" c ON c."id" = p."categoryId"
        LEFT JOIN LATERAL (
          SELECT i."url", i."fallbackUrl", i."width", i."height"
          FROM "part_image" i WHERE i."partId" = p."id"
          ORDER BY i."position" ASC LIMIT 1
        ) img ON TRUE
        JOIN LATERAL (
          SELECT min(v."priceCents") AS "priceMin", max(v."priceCents") AS "priceMax"
          FROM "part_variant" v WHERE v."partId" = p."id" AND v."isActive"
        ) st ON st."priceMin" IS NOT NULL
        WHERE p."tenantId" = ${tenantId} AND p."status" = 'ACTIVO'
          AND (
            lower(p."slug") = ${needle}
            OR EXISTS (
              SELECT 1 FROM "part_variant" v
              WHERE v."partId" = p."id" AND v."isActive"
                AND (
                  lower(v."sku") = ${needle}
                  OR lower(coalesce(v."partNumber", '')) = ${needle}
                  OR EXISTS (SELECT 1 FROM unnest(v."oemNumbers") AS o WHERE lower(o) = ${needle})
                )
            )
          )
        LIMIT 1`;

      const found = row[0];
      if (!found) return null;

      const partIds = [found.partId];
      const [variants, vehicles] = await Promise.all([
        this.variantsFor(tx, partIds),
        this.vehiclesFor(tx, partIds),
      ]);
      const item = this.toItem(found, variants, vehicles);
      return { ...item, description: found.description } satisfies PublicPart;
    });

    if (!result) throw notFound();
    return {
      shop,
      part: result,
      turnstile: { required: this.guard.siteKey !== null, siteKey: this.guard.siteKey },
    };
  }

  // ───────────────────────────── Pedido ─────────────────────────────

  /**
   * Pedido de invitado desde la vitrina.
   *
   * El orden de las comprobaciones es el que ahorra trabajo: primero el slug (¿existe el negocio?),
   * después el rate limit (¿es abuso?), después Turnstile, y solo al final se toca el inventario.
   * Validar piezas antes de frenar el abuso dejaría que un bot consumiera la base gratis.
   *
   * El pedido entra por `OrdersService.create` con `guest`: misma reserva atómica, mismo folio,
   * misma cola de bodega y mismo aviso push. Un camino paralelo para la web sería la forma más
   * rápida de vender dos veces la misma pieza.
   */
  async order(
    slug: string,
    input: PublicOrderData,
    meta: { ip?: string; userAgent?: string; origin: string },
  ): Promise<PublicOrderResult> {
    const { shop, tenantId } = await this.shopId(slug);

    const withinBudget = await this.guard.hit(this.guard.keyFor(meta.ip), 'PEDIDO', tenantId);
    if (!withinBudget) {
      throw new BadRequestException({
        code: 'RATE_LIMITED',
        message: 'Recibimos varios pedidos desde tu conexión. Escríbenos por WhatsApp y te atendemos.',
      });
    }

    const captcha = await this.guard.verifyTurnstile(input.turnstileToken, meta.ip);
    if (!captcha.ok) {
      throw new BadRequestException({
        code: captcha.code ?? 'TURNSTILE_FAILED',
        message: 'No pudimos comprobar que no eres un robot. Recarga la página e intenta otra vez.',
      });
    }

    // La vitrina solo vende lo que la bodega marcó como vendible en línea. Se comprueba aquí y no
    // en el cliente: el navegador pudo tener la página abierta desde ayer.
    const purchasable = await this.db.tx(tenantId, async (tx) =>
      this.purchasableVariants(
        tx,
        input.items.map((i) => i.variantId),
      ),
    );
    const missing = input.items.filter((i) => !purchasable.has(i.variantId));
    if (missing.length) {
      throw new BadRequestException({
        code: 'NOT_PURCHASABLE',
        message: 'Una de las piezas ya no está disponible. Actualiza el catálogo e intenta de nuevo.',
      });
    }

    const phone = normalizePhone(input.customerPhone);
    if (!phone) {
      throw new BadRequestException({
        code: 'INVALID_PHONE',
        message: 'Escribe un teléfono válido para avisarte cuando esté listo.',
      });
    }

    /**
     * Contexto sintético del pedido.
     *
     * El alta de pedidos pide un `Ctx` con usuario y permisos porque el 99% de las ventas las hace
     * un empleado. Aquí no hay empleado: se arma un contexto con el tenant resuelto por slug y sin
     * permisos. `guest: true` en las opciones es lo que apaga la validación de precio y deja el
     * `sellerId` en nulo; el permiso ausente hace que cualquier intento de sobreescribir precio
     * reviente aunque alguien cambie esas opciones en el futuro.
     */
    const ctx = {
      user: {
        id: `catalogo:${shop.slug}`,
        email: `catalogo@${shop.slug}.partops.local`,
        name: 'Catálogo en línea',
        emailVerified: true,
        mustChangePassword: false,
      },
      sessionId: 'catalogo',
      tenant: {
        tenantId,
        tenantName: shop.name,
        tenantSlug: shop.slug,
        role: 'catalogo',
        permissions: new Set(),
        warehouseIds: [],
      },
      activeTenantId: tenantId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    } as unknown as Ctx;

    const detail = await this.orders.create(
      ctx,
      {
        customerName: input.customerName,
        customerPhone: phone,
        channel: 'CATALOGO',
        notes: input.note,
        idempotencyKey: input.idempotencyKey,
        items: input.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      },
      { guest: true, sourceSlug: shop.slug, lockPrice: true },
    );

    const lines: PublicOrderLine[] = detail.lines.map((l) => ({
      name: l.name,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      totalCents: l.totalCents,
    }));
    const allAvailable = detail.lines.every((l) => l.status !== 'SIN_STOCK');
    const catalogUrl = `${meta.origin.replace(/\/+$/, '')}/c/${shop.slug}`;

    const message = publicOrderWhatsAppMessage({
      shopName: shop.name,
      orderCode: detail.code,
      customerName: input.customerName,
      customerPhone: phone,
      lines,
      totalCents: detail.totalCents,
      currency: shop.currency,
      catalogUrl,
      note: input.note,
    });

    return {
      code: detail.code,
      totalCents: detail.totalCents,
      currency: shop.currency,
      status: detail.status,
      allAvailable,
      whatsappUrl: shopWhatsAppUrl(shop, message),
      lines,
    };
  }

  /**
   * "Avísame cuando llegue".
   *
   * Se verifica el límite por IP antes de tocar la tabla: un bot aquí no llena la base de pedidos
   * sino de teléfonos de terceros, y el daño se lo lleva un cliente que empieza a recibir mensajes
   * que no pidió. Sin límite, además, la bandeja de la bodega se vuelve inservible.
   */
  async watch(slug: string, input: StockWatchInput, meta: { ip?: string }): Promise<{ ok: boolean }> {
    const { tenantId } = await this.shopId(slug);
    const phone = normalizePhone(input.phone);
    if (!phone) {
      throw new BadRequestException({
        code: 'INVALID_PHONE',
        message: 'Escribe un teléfono válido para avisarte cuando llegue.',
      });
    }

    const allowed = await this.guard.hit(this.guard.keyFor(meta.ip), 'AVISO', tenantId);
    if (!allowed) {
      throw new BadRequestException({
        code: 'RATE_LIMITED',
        message: 'Recibimos varios avisos desde tu conexión. Escríbenos por WhatsApp y te ayudamos.',
      });
    }

    const normalizedPhrase = normalizeQuery(input.q ?? '');
    await this.watches.register(tenantId, { ...input, q: normalizedPhrase ? input.q : undefined }, phone);
    return { ok: true };
  }

  /** Mensaje de WhatsApp para la pieza que no se encontró. No crea nada: es una conversación. */
  async inquiry(slug: string, query: string, origin: string): Promise<{ whatsappUrl: string | null }> {
    const shop = await this.shop(slug);
    const text = catalogInquiryMessage({
      shopName: shop.name,
      query,
      catalogUrl: `${origin.replace(/\/+$/, '')}/c/${shop.slug}`,
    });
    return { whatsappUrl: shopWhatsAppUrl(shop, text) };
  }

  /**
   * Contabiliza una búsqueda del visitante.
   *
   * No se llama en la ruta de lectura porque un `GET` que escribe no se puede cachear en el borde,
   * y la vitrina tiene que ser cacheable para llegar a un TTFB decente. Se registra desde el
   * cliente con un `POST` aparte, y si falla no pasa nada: el catálogo ya respondió.
   */
  async trackSearch(slug: string, term: string, ip: string | undefined): Promise<{ ok: boolean }> {
    const { tenantId } = await this.shopId(slug);
    const allowed = await this.guard.hit(this.guard.keyFor(ip), 'BUSQUEDA', tenantId);
    if (!allowed) return { ok: false };
    const clean = term.trim().slice(0, 120);
    if (!clean) return { ok: true };

    await this.db.tx(tenantId, async (tx) => {
      const vocab = await this.vocabulary(tx);
      const parsed = parsePartQuery(clean, vocab);
      const term = parsed.term.trim();
      const filter = this.listFilter({
        tenantId,
        codes: extractPartCodes(clean),
        term,
        tsq: toTsQuery(term) ?? 'partopspublicnomatch',
        brand: parsed.brand,
        model: parsed.model,
        year: parsed.year,
      });
      const [row] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS "total" FROM "part" p WHERE ${filter}`;
      await tx.searchEvent.create({
        data: {
          tenantId,
          rawQuery: clean,
          normalized: (parsed.term || parsed.normalized).slice(0, 160),
          brand: parsed.brand,
          model: parsed.model,
          year: parsed.year,
          resultCount: Number(row?.total ?? 0),
          source: 'CATALOGO',
        },
      });
    });
    return { ok: true };
  }

  // ───────────────────────────── Auxiliares ─────────────────────────────

  /**
   * Filtro de la vitrina, compartido por el listado, el conteo y la demanda.
   *
   * Tres cosas que no aparecen en el catálogo interno y que aquí son obligatorias:
   *  - `status = 'ACTIVO'`: una pieza archivada no se muestra ni por enlace.
   *  - al menos una variante activa: sin variante no hay precio ni existencia, es una fila huérfana.
   *  - al menos una bodega con `sellsOnline`: es lo que hace que la pieza se pueda comprar hoy.
   */
  private listFilter(args: {
    tenantId: string;
    codes: string[];
    term: string;
    tsq: string;
    brand: string | null;
    model: string | null;
    year: number | null;
  }): Prisma.Sql {
    const { codes, term, tsq } = args;
    const hasTerm = term.length > 0;

    const byCode = codes.length
      ? Prisma.sql`EXISTS (
          SELECT 1 FROM "part_variant" v
          WHERE v."partId" = p."id" AND v."isActive"
            AND (
              upper(regexp_replace(v."sku", '[^A-Za-z0-9]', '', 'g')) = ANY(${codes}::text[])
              OR upper(regexp_replace(coalesce(v."partNumber", ''), '[^A-Za-z0-9]', '', 'g'))
                 = ANY(${codes}::text[])
              OR EXISTS (
                SELECT 1 FROM unnest(v."oemNumbers") AS o
                WHERE upper(regexp_replace(o, '[^A-Za-z0-9]', '', 'g')) = ANY(${codes}::text[])
              )
            )
        )`
      : null;

    const byText = hasTerm
      ? Prisma.sql`(
          to_tsvector('spanish', part_immutable_unaccent(coalesce(p."searchText", '')))
            @@ to_tsquery('spanish', ${tsq})
          OR similarity(lower(coalesce(p."searchText", '')), lower(${term})) > 0.15
          OR lower(p."name") LIKE ${`%${term.toLowerCase()}%`}
        )`
      : null;

    const match = byCode && byText ? Prisma.sql`(${byCode} OR ${byText})` : (byCode ?? byText);

    const vehicle = buildVehicleFilter(args);

    const sellable = Prisma.sql`EXISTS (
      SELECT 1 FROM "part_variant" v
      JOIN "inventory_level" l ON l."variantId" = v."id"
      JOIN "warehouse" w ON w."id" = l."warehouseId"
      WHERE v."partId" = p."id" AND v."isActive"
        AND w."isActive" AND w."sellsOnline"
        AND (l."onHand" - l."reserved") > 0
    )`;

    return Prisma.sql`
      p."tenantId" = ${args.tenantId}
      AND p."status" = 'ACTIVO'
      ${match ? Prisma.sql`AND ${match}` : Prisma.empty}
      AND ${vehicle}
      AND ${sellable}`;
  }

  /** Variantes con existencia, solo de bodegas en línea. Sin costos. */
  private async variantsFor(tx: TxClient, partIds: string[]): Promise<RawVariant[]> {
    if (!partIds.length) return [];
    return tx.$queryRaw<RawVariant[]>`
      SELECT
        v."id" AS "variantId", v."partId", v."sku", v."title", v."partNumber", v."oemNumbers",
        v."priceCents",
        w."name" AS "warehouseName",
        coalesce(l."onHand", 0) AS "onHand",
        coalesce(l."reserved", 0) AS "reserved"
      FROM "part_variant" v
      JOIN "inventory_level" l ON l."variantId" = v."id"
      JOIN "warehouse" w ON w."id" = l."warehouseId"
      WHERE v."partId" = ANY(${partIds}::text[])
        AND v."isActive"
        AND w."isActive" AND w."sellsOnline"
        AND (l."onHand" - l."reserved") > 0
      ORDER BY v."position" ASC, v."sku" ASC, w."name" ASC`;
  }

  /**
   * Años y motores de la pieza.
   *
   * Se agrupan por (marca, modelo, rango) en vez de listar una fila por año: "Corolla 2003–2008" es
   * una línea, no seis, y seis líneas idénticas hacen que la ficha parezca generada por una máquina.
   */
  private async vehiclesFor(tx: TxClient, partIds: string[]): Promise<Map<string, PublicVehicle[]>> {
    const out = new Map<string, PublicVehicle[]>();
    if (!partIds.length) return out;
    const rows = await tx.$queryRaw<
      Array<{
        partId: string;
        brand: string;
        model: string;
        yearStart: number;
        yearEnd: number;
        engine: string | null;
      }>
    >`
      SELECT DISTINCT
        pc."partId", vb."name" AS "brand", vm."name" AS "model",
        veh."yearStart", veh."yearEnd", veh."engine"
      FROM "part_compatibility" pc
      JOIN "vehicle" veh ON veh."id" = pc."vehicleId"
      JOIN "vehicle_model" vm ON vm."id" = veh."modelId"
      JOIN "vehicle_brand" vb ON vb."id" = vm."brandId"
      WHERE pc."partId" = ANY(${partIds}::text[])
      ORDER BY vb."name" ASC, vm."name" ASC, veh."yearStart" ASC
      LIMIT 240`;

    for (const r of rows) {
      const list = out.get(r.partId) ?? [];
      const existing = list.find((v) => v.brand === r.brand && v.model === r.model && v.engine === r.engine);
      if (existing) {
        existing.yearStart = Math.min(existing.yearStart, r.yearStart);
        existing.yearEnd = Math.max(existing.yearEnd, r.yearEnd);
      } else {
        list.push({
          brand: r.brand,
          model: r.model,
          yearStart: r.yearStart,
          yearEnd: r.yearEnd,
          engine: r.engine,
        });
      }
      out.set(r.partId, list);
    }
    return out;
  }

  /**
   * Facetas de la vitrina.
   *
   * Marcas y categorías se calculan sobre el texto SIN el filtro de vehículo (quitarlo es un clic),
   * y los modelos sí aplican el año, que viene escrito en el buscador. Es la misma lógica que la
   * búsqueda interna por la misma razón: una faceta que desaparece no se puede deseleccionar.
   */
  private async facets(
    tx: TxClient,
    args: {
      tenantId: string;
      codes: string[];
      term: string;
      tsq: string;
      year: number | null;
    },
  ): Promise<PublicCatalogResponse['facets']> {
    const base = this.listFilter({ ...args, brand: null, model: null });

    const [brandRows, categoryRows, modelRows] = await Promise.all([
      tx.$queryRaw<Array<{ name: string; count: bigint }>>`
        SELECT p."brand" AS "name", count(*) AS "count"
        FROM "part" p
        WHERE ${base} AND p."brand" IS NOT NULL AND p."brand" <> ''
        GROUP BY p."brand" ORDER BY count(*) DESC, p."brand" ASC LIMIT 12`,
      tx.$queryRaw<Array<{ name: string; count: bigint }>>`
        SELECT c."name", count(*) AS "count"
        FROM "part" p
        JOIN "part_category" c ON c."id" = p."categoryId"
        WHERE ${base}
        GROUP BY c."name" ORDER BY count(*) DESC, c."name" ASC LIMIT 12`,
      tx.$queryRaw<
        Array<{
          brand: string;
          model: string;
          yearStart: number;
          yearEnd: number;
          count: bigint;
        }>
      >`
        WITH matched AS (
          SELECT p."id" FROM "part" p WHERE ${base}
        )
        SELECT vb."name" AS "brand", vm."name" AS "model",
               min(veh."yearStart") AS "yearStart", max(veh."yearEnd") AS "yearEnd",
               count(DISTINCT m."id") AS "count"
        FROM matched m
        JOIN "part_compatibility" pc ON pc."partId" = m."id"
        JOIN "vehicle" veh ON veh."id" = pc."vehicleId"
        JOIN "vehicle_model" vm ON vm."id" = veh."modelId"
        JOIN "vehicle_brand" vb ON vb."id" = vm."brandId"
        GROUP BY vb."name", vm."name"
        ORDER BY count(*) DESC, vb."name" ASC, vm."name" ASC
        LIMIT 24`,
    ]);

    // Las marcas del selector de vehículo salen de la compatibilidad, no de la marca de la pieza:
    // "Toyota" en el selector significa "piezas que le quedan a un Toyota", y una pieza de marca
    // genérica compatible con Toyota tiene que aparecer al elegir ese vehículo.
    const vehicleBrandRows = await tx.$queryRaw<Array<{ name: string; count: bigint }>>`
      WITH matched AS (
        SELECT p."id" FROM "part" p WHERE ${base}
      )
      SELECT vb."name", count(DISTINCT m."id") AS "count"
      FROM matched m
      JOIN "part_compatibility" pc ON pc."partId" = m."id"
      JOIN "vehicle" veh ON veh."id" = pc."vehicleId"
      JOIN "vehicle_model" vm ON vm."id" = veh."modelId"
      JOIN "vehicle_brand" vb ON vb."id" = vm."brandId"
      GROUP BY vb."name"
      ORDER BY count(DISTINCT m."id") DESC, vb."name" ASC
      LIMIT 12`;

    return {
      brands: brandRows.map((r) => ({ name: r.name, count: Number(r.count) })),
      categories: categoryRows.map((r): PublicFacet => ({ name: r.name, count: Number(r.count) })),
      vehicles: {
        brands: vehicleBrandRows.map((r): PublicFacet => ({ name: r.name, count: Number(r.count) })),
        models: modelRows.map(
          (r): PublicFacetModel => ({
            brand: r.brand,
            model: r.model,
            yearStart: Number(r.yearStart),
            yearEnd: Number(r.yearEnd),
            count: Number(r.count),
          }),
        ),
      },
    };
  }

  /** Vocabulario vehicular. Se relee por negocio y se cachea 5 min: cambia rara vez. */
  private readonly vocabCache = new Map<string, { loadedAt: number; data: VehicleVocabulary }>();
  private async vocabulary(tx: TxClient): Promise<VehicleVocabulary> {
    const cached = this.vocabCache.get('global');
    if (cached && Date.now() - cached.loadedAt < 5 * 60_000) return cached.data;

    const [brands, models, categories] = await Promise.all([
      tx.vehicleBrand.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
      tx.vehicleModel.findMany({
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
    this.vocabCache.set('global', { loadedAt: Date.now(), data });
    return data;
  }

  /**
   * Vocabulario para la portada pública y para cualquier demo del parser.
   *
   * Solo marcas y modelos: son la tabla curada global (`vehicle_brand` / `vehicle_model`, sin
   * `tenantId`). Las **categorías de pieza sí son de cada negocio** (`part_category.tenantId`), así
   * que no salen de aquí: exponer la de un negocio sería filtrar su catálogo por la puerta de atrás.
   * El tipo lo permite porque `categories` es opcional.
   *
   * Corre con `db.system` porque no hay tenant que fijar: es la única consulta de este archivo que
   * no pasa por RLS, y por eso no toca ninguna tabla de negocio.
   */
  private refVocabCache: { loadedAt: number; data: VehicleVocabulary } | null = null;
  async referenceVocabulary(): Promise<VehicleVocabulary> {
    const cached = this.refVocabCache;
    if (cached && Date.now() - cached.loadedAt < 60 * 60_000) return cached.data;

    const data = await this.db.system(async (tx) => {
      const [brands, models] = await Promise.all([
        tx.vehicleBrand.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
        tx.vehicleModel.findMany({
          select: { name: true, brand: { select: { name: true } } },
          orderBy: { name: 'asc' },
        }),
      ]);
      const vocab: VehicleVocabulary = {
        brands: brands.map((b) => b.name),
        models: models.map((m) => ({ name: m.name, brand: m.brand.name })),
      };
      return vocab;
    });

    this.refVocabCache = { loadedAt: Date.now(), data };
    return data;
  }

  /** Variantes que de verdad se pueden pedir hoy: activas, en bodega en línea y con existencia. */
  private async purchasableVariants(tx: TxClient, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT v."id"
      FROM "part_variant" v
      JOIN "part" p ON p."id" = v."partId" AND p."status" = 'ACTIVO'
      JOIN "inventory_level" l ON l."variantId" = v."id"
      JOIN "warehouse" w ON w."id" = l."warehouseId"
      WHERE v."id" = ANY(${ids}::text[])
        AND v."isActive" AND w."isActive" AND w."sellsOnline"
        AND (l."onHand" - l."reserved") > 0`;
    return new Set(rows.map((r) => r.id));
  }

  private toItem(
    row: RawItem,
    variants: RawVariant[],
    vehicles: Map<string, PublicVehicle[]>,
  ): PublicCatalogItem {
    const own = variants.filter((v) => v.partId === row.partId);
    const byVariant = new Map<string, PublicVariant>();

    for (const v of own) {
      const available = Number(v.onHand) - Number(v.reserved);
      let variant = byVariant.get(v.variantId);
      if (!variant) {
        variant = {
          id: v.variantId,
          sku: v.sku,
          title: v.title,
          partNumber: v.partNumber,
          oemNumbers: v.oemNumbers ?? [],
          priceCents: Number(v.priceCents),
          availability: [],
          purchasable: false,
        };
        byVariant.set(v.variantId, variant);
      }
      const bucket = availabilityBucket(available);
      variant.availability.push({ warehouseName: v.warehouseName, bucket } satisfies PublicAvailability);
      if (bucket !== 'AGOTADO') variant.purchasable = true;
    }

    const best = mostAvailable(
      [...byVariant.values()].map((v) =>
        v.availability.reduce<AvailabilityBucket>(
          (a, x) => (rankOf(x.bucket) > rankOf(a) ? x.bucket : a),
          'AGOTADO',
        ),
      ),
    );

    return {
      id: row.partId,
      slug: row.slug,
      name: row.name,
      brand: row.brand,
      category: row.category,
      condition: row.condition as PartConditionKey,
      unit: row.unit,
      warrantyDays: row.warrantyDays,
      imageUrl: this.publicUrl(row.imageUrl),
      imageFallbackUrl: this.publicUrl(row.imageFallbackUrl),
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      priceMinCents: Number(row.priceMin),
      priceMaxCents: Number(row.priceMax),
      availability: best,
      vehicles: (vehicles.get(row.partId) ?? []).slice(0, 4),
      variants: [...byVariant.values()],
    };
  }

  /**
   * URL de imagen absoluta.
   *
   * En desarrollo las fotos se sirven por `/api/media/<key>` desde la API, y el navegador de la
   * vitrina no está en el origen de la API: sin absolutizar, la imagen no carga. En producción la
   * URL ya viene de R2 y se deja intacta.
   */
  private publicUrl(url: string | null): string | null {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (!url.startsWith('/')) return url;
    return `${env.API_PUBLIC_URL.replace(/\/+$/, '')}${url}`;
  }
}

/** Filtro de vehículo compartido con la búsqueda interna, con la misma semántica. */
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

/**
 * Teléfono del cliente.
 *
 * Se acepta cualquier forma razonable y se guarda como llegó si no es guatemalteco: rechazar a un
 * cliente que escribe desde otro país por "formato inválido" es perder la venta por un detalle que
 * el vendedor resuelve en una llamada.
 */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return null;
  if (digits.startsWith('502') && digits.length === 11) return `+${digits}`;
  if (/^[2-6]\d{7}$/.test(digits)) return `+502${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

/**
 * Número de WhatsApp listo para `wa.me`.
 *
 * Un negocio escribe "5555-0000", que es el número nacional guatemalteco y no funciona en `wa.me`:
 * sin el país, el enlace abre WhatsApp con un número de otro lugar o con error. Se normaliza a
 * E.164 sin el `+`; si ya viene con país, se respeta.
 */
function digits(raw: string | null): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const gt = normalizeGtPhone(value);
  if (gt) return gt.replace(/\D/g, '');
  const d = value.replace(/\D/g, '');
  return d.length >= 10 ? d : null;
}

const RANK: Record<AvailabilityBucket, number> = { AGOTADO: 0, POCAS: 1, HAY: 2 };
const rankOf = (b: AvailabilityBucket): number => RANK[b];

/** La mejor disponibilidad entre varias: una pieza en dos bodegas se anuncia por la mejor. */
function mostAvailable(buckets: AvailabilityBucket[]): AvailabilityBucket {
  return buckets.reduce<AvailabilityBucket>((a, b) => (rankOf(b) > rankOf(a) ? b : a), 'AGOTADO');
}

function notFound() {
  return new NotFoundException({
    code: 'CATALOG_NOT_FOUND',
    message: 'Ese catálogo no existe',
  });
}

export type { ParsedQuery, PublicScope };
