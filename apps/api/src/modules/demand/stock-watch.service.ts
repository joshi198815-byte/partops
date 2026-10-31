import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type StockWatchCustomer,
  type StockWatchGroup,
  type StockWatchInput,
  type StockWatchNotification,
  stockArrivalBroadcast,
  stockArrivalMessage,
  stockWatchWhatsAppUrl,
} from '@partops/contracts';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';

/**
 * Bandeja de "avísame cuando llegue".
 *
 * El valor de esta lista está en que se llena sola: el cliente la usa cuando la pieza no está, y
 * cuando entra la mercancía el bodeguero tiene enfrente los teléfonos de quienes la pidieron. Por
 * eso el aviso se marca al enviarlo —con nombre de quién lo mandó— y no al "abrir" la lista: dos
 * vendedores con la misma pantalla abierta no pueden mandar el mismo WhatsApp dos veces.
 *
 * La lista se agrupa por pieza y no por persona: lo que la bodega compra es la pieza. Los clientes
 * de esa pieza son el detalle, y ahí sí se ven nombres y teléfonos, que es lo que se necesita para
 * escribir.
 */

/** Tope de clientes que se devuelven por grupo. Una pieza con 300 esperas no cabe en una pantalla. */
const MAX_CUSTOMERS_PER_GROUP = 60;

interface RawWatch {
  id: string;
  variantId: string | null;
  partId: string | null;
  rawQuery: string;
  customerName: string;
  customerPhone: string;
  createdAt: Date;
}

interface RawAvailability {
  variantId: string;
  partId: string;
  available: number;
}

@Injectable()
export class StockWatchService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  // ───────────────────────────── Alta (vitrina pública) ─────────────────────────────

  /**
   * Registra un aviso desde la vitrina.
   *
   * Es idempotente por (pieza, teléfono): quien toca dos veces "avísame" o recarga la página no
   * aparece dos veces en la lista de llamadas. Si ya estaba avisado y todavía no se le avisó, se
   * actualiza el nombre —la gente corrige cómo escribió su nombre más seguido de lo que uno cree—
   * y se deja la fecha original, que es la que mide cuánto lleva esperando.
   */
  async register(
    tenantId: string,
    input: StockWatchInput,
    phone: string,
  ): Promise<{ ok: true; already?: boolean }> {
    return this.db.tx(tenantId, async (tx) => {
      // El destino tiene que existir de verdad en este negocio: sin esto, un `variantId` inventado
      // quedaría en la bandeja como una pieza fantasma que nunca va a llegar.
      let partId = input.partId ?? null;
      if (input.variantId) {
        const variant = await tx.partVariant.findFirst({
          where: { id: input.variantId, tenantId },
          select: { id: true, partId: true },
        });
        if (!variant) throw new BadRequestException({ code: 'NOT_FOUND', message: 'Pieza no encontrada' });
        partId = variant.partId;
      } else if (partId) {
        const part = await tx.part.findFirst({ where: { id: partId, tenantId }, select: { id: true } });
        if (!part) throw new BadRequestException({ code: 'NOT_FOUND', message: 'Pieza no encontrada' });
      }

      const rawQuery = (input.q ?? '').trim().slice(0, 120);
      // El destino manda la identidad del aviso: con variante se busca por variante aunque la fila
      // guardada también lleve `partId` (se deriva de la variante). Comparar los dos campos a la vez
      // hacía que el segundo "avísame" del mismo teléfono creara una fila paralela.
      const existing = await tx.stockWatch.findFirst({
        where: {
          tenantId,
          customerPhone: phone,
          notifiedAt: null,
          ...(input.variantId
            ? { variantId: input.variantId }
            : partId
              ? { variantId: null, partId }
              : { variantId: null, partId: null, rawQuery }),
        },
        select: { id: true },
      });

      if (existing) {
        await tx.stockWatch.update({
          where: { id: existing.id },
          data: { customerName: input.name },
        });
        return { ok: true as const, already: true };
      }

      await tx.stockWatch.create({
        data: {
          tenantId,
          variantId: input.variantId ?? null,
          partId,
          rawQuery,
          customerName: input.name,
          customerPhone: phone,
        },
      });
      return { ok: true as const };
    });
  }

  // ───────────────────────────── Bandeja ─────────────────────────────

  /**
   * Avisos pendientes agrupados por pieza, con la existencia de hoy.
   *
   * `availableNow` es lo que convierte una lista en una acción: si la pieza ya entró, el grupo
   * aparece primero y con el botón listo. Si sigue en cero, el grupo sigue ahí —es la lista de
   * compras— pero sin ofrecer un aviso que sería mentira.
   */
  async tray(ctx: Ctx): Promise<{ groups: StockWatchGroup[]; pending: number; ready: number }> {
    const tenantId = ctx.tenant.tenantId;

    const watches = await this.db.tx(tenantId, (tx) =>
      tx.stockWatch.findMany({
        where: { tenantId, notifiedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          variantId: true,
          partId: true,
          rawQuery: true,
          customerName: true,
          customerPhone: true,
          createdAt: true,
        },
        take: 4000,
      }),
    );
    if (!watches.length) return { groups: [], pending: 0, ready: 0 };

    const variantIds = [...new Set(watches.map((w) => w.variantId).filter((v): v is string => Boolean(v)))];
    const partIds = [
      ...new Set([
        ...watches.map((w) => w.partId).filter((v): v is string => Boolean(v)),
        ...watches.map((w) => w.variantId).filter((v): v is string => Boolean(v)),
      ]),
    ];

    const availability = await this.availability(tenantId, variantIds, partIds);
    const labels = await this.labels(tenantId, variantIds, partIds);

    const groups = new Map<string, { group: StockWatchGroup; count: number }>();
    for (const w of watches) {
      const key = w.variantId
        ? `variant:${w.variantId}`
        : w.partId
          ? `part:${w.partId}`
          : `term:${w.rawQuery.toLowerCase()}`;
      const label = w.variantId
        ? labels.variants.get(w.variantId)
        : w.partId
          ? labels.parts.get(w.partId)
          : null;
      const availableUnits = w.variantId
        ? (availability.byVariant.get(w.variantId) ?? 0)
        : w.partId
          ? (availability.byPart.get(w.partId) ?? 0)
          : 0;

      const acc = groups.get(key);
      if (acc) {
        acc.group.pending += 1;
        acc.group.availableUnits = Math.max(acc.group.availableUnits, availableUnits);
        continue;
      }

      groups.set(key, {
        count: 1,
        group: {
          key,
          variantId: w.variantId,
          partId: w.partId ?? label?.partId ?? null,
          term: label?.name ?? w.rawQuery ?? 'Pieza sin identificar',
          partName: label?.name ?? null,
          sku: label?.sku ?? null,
          pending: 1,
          oldestAt: w.createdAt.toISOString(),
          availableUnits,
          availableNow: availableUnits > 0,
        },
      });
    }

    const list = [...groups.values()].map((g) => g.group);
    // Primero lo que ya se puede avisar, y dentro de eso lo que lleva más gente esperando. La
    // bandeja existe para vaciarla, no para leerla.
    list.sort((a, b) => {
      if (a.availableNow !== b.availableNow) return a.availableNow ? -1 : 1;
      if (a.availableNow && a.pending !== b.pending) return b.pending - a.pending;
      return a.oldestAt.localeCompare(b.oldestAt);
    });

    return {
      groups: list.slice(0, 60),
      pending: watches.length,
      ready: list.filter((g) => g.availableNow).length,
    };
  }

  /**
   * Clientes de un grupo, con el mensaje ya escrito.
   *
   * Se arma aquí y no en la pantalla porque el mismo texto va al botón "WhatsApp" de cada cliente y
   * al "copiar lista": dos plantillas acaban diciendo cosas distintas de la misma pieza.
   */
  async notification(ctx: Ctx, key: string, catalogUrl: string): Promise<StockWatchNotification> {
    const tenantId = ctx.tenant.tenantId;
    const scope = scopeOf(key);

    const watches = await this.db.tx(tenantId, (tx) =>
      tx.stockWatch.findMany({
        where: { tenantId, notifiedAt: null, ...scope },
        orderBy: { createdAt: 'asc' },
        take: MAX_CUSTOMERS_PER_GROUP,
      }),
    );
    if (!watches.length) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Ese aviso ya se envió o no existe' });
    }

    const tenant = await this.db.system((tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    );
    const shopName = tenant?.name ?? 'la bodega';

    const labels = await this.labels(
      tenantId,
      watches.map((w) => w.variantId).filter((v): v is string => Boolean(v)),
      watches.map((w) => w.partId).filter((v): v is string => Boolean(v)),
    );
    const first = watches[0] as RawWatch;
    const label = first.variantId
      ? labels.variants.get(first.variantId)
      : first.partId
        ? labels.parts.get(first.partId)
        : null;
    const partName = label?.name ?? (first.rawQuery || 'la pieza que buscabas');
    const sku = label?.sku ?? null;

    const customers: StockWatchCustomer[] = watches.map((w) => ({
      id: w.id,
      name: w.customerName,
      phone: w.customerPhone,
      whatsappUrl: stockWatchWhatsAppUrl(
        w.customerPhone,
        stockArrivalMessage({ shopName, customerName: w.customerName, partName, sku, catalogUrl }),
      ),
      waitedSince: w.createdAt.toISOString(),
    }));

    // La existencia del grupo se consulta aquí y no reutilizando `tray`: esa consulta agrupa los
    // cientos de avisos abiertos para pintar la bandeja, y al abrir un grupo solo hacen falta los
    // números de esta pieza.
    const availability = await this.availability(
      tenantId,
      first.variantId ? [first.variantId] : [],
      first.partId ? [first.partId] : [],
    );
    const availableUnits = first.variantId
      ? (availability.byVariant.get(first.variantId) ?? 0)
      : first.partId
        ? (availability.byPart.get(first.partId) ?? 0)
        : 0;

    return {
      group: {
        key,
        variantId: first.variantId,
        partId: first.partId,
        term: partName,
        partName,
        sku,
        pending: customers.length,
        oldestAt: first.createdAt.toISOString(),
        availableUnits,
        availableNow: availableUnits > 0,
      },
      customers,
      broadcastText: stockArrivalBroadcast({
        shopName,
        partName,
        sku,
        catalogUrl,
        count: customers.length,
      }),
    };
  }

  /**
   * Marca como avisados.
   *
   * Se marcan solo los que se mostraron: si entraron cien personas esperando la misma pieza y se
   * avisaron sesenta, las otras cuarenta siguen en la bandeja. Marcarlas todas sería dar por hecho
   * un mensaje que nadie mandó.
   */
  async markNotified(ctx: Ctx, ids: string[]): Promise<{ updated: number }> {
    if (!ids.length) return { updated: 0 };
    const tenantId = ctx.tenant.tenantId;
    const updated = await this.db.tx(tenantId, (tx) =>
      tx.stockWatch.updateMany({
        where: { tenantId, id: { in: ids.slice(0, 500) }, notifiedAt: null },
        data: { notifiedAt: new Date(), notifiedBy: ctx.user.id },
      }),
    );
    return { updated: updated.count };
  }

  /**
   * Descarta avisos que no se van a cumplir (el cliente dijo que ya no lo necesita, o la pieza ya
   * no se consigue). Se borran: marcarlos como "avisado" ensuciaría el dato de cuántos avisos se
   * enviaron de verdad, que es justamente lo que mide si la bandeja sirve.
   */
  async dismiss(ctx: Ctx, ids: string[]): Promise<{ removed: number }> {
    if (!ids.length) return { removed: 0 };
    const tenantId = ctx.tenant.tenantId;
    const removed = await this.db.tx(tenantId, (tx) =>
      tx.stockWatch.deleteMany({
        where: { tenantId, id: { in: ids.slice(0, 500) }, notifiedAt: null },
      }),
    );
    return { removed: removed.count };
  }

  // ───────────────────────────── Auxiliares ─────────────────────────────

  /**
   * Existencia libre por variante y por pieza.
   *
   * Solo bodegas activas que venden en línea: es la misma regla de la vitrina. Avisar "ya llegó" de
   * una pieza que está en un depósito que no despacha dejaría al cliente caminando hasta la bodega
   * equivocada.
   */
  private async availability(tenantId: string, variantIds: string[], partIds: string[]) {
    if (!variantIds.length && !partIds.length) {
      return { byVariant: new Map<string, number>(), byPart: new Map<string, number>() };
    }
    const rows = await this.db.tx(
      tenantId,
      (tx) =>
        tx.$queryRaw<RawAvailability[]>`
        SELECT v."id" AS "variantId", v."partId",
               sum(l."onHand" - l."reserved")::int AS "available"
        FROM "part_variant" v
        JOIN "part" p ON p."id" = v."partId" AND p."status" = 'ACTIVO'
        JOIN "inventory_level" l ON l."variantId" = v."id"
        JOIN "warehouse" w ON w."id" = l."warehouseId"
        WHERE v."tenantId" = ${tenantId}
          AND v."isActive" AND w."isActive" AND w."sellsOnline"
          AND (v."id" = ANY(${variantIds}::text[]) OR v."partId" = ANY(${partIds}::text[]))
        GROUP BY v."id", v."partId"`,
    );

    const byVariant = new Map<string, number>();
    const byPart = new Map<string, number>();
    for (const r of rows) {
      const units = Math.max(0, Number(r.available ?? 0));
      byVariant.set(r.variantId, units);
      byPart.set(r.partId, (byPart.get(r.partId) ?? 0) + units);
    }
    return { byVariant, byPart };
  }

  private async labels(tenantId: string, variantIds: string[], partIds: string[]) {
    return this.db.tx(tenantId, async (tx) => {
      const [variants, parts] = await Promise.all([
        variantIds.length
          ? tx.partVariant.findMany({
              where: { id: { in: variantIds }, tenantId },
              select: { id: true, sku: true, title: true, partId: true, part: { select: { name: true } } },
            })
          : Promise.resolve([]),
        partIds.length
          ? tx.part.findMany({
              where: { id: { in: partIds }, tenantId },
              select: { id: true, name: true, variants: { select: { sku: true }, take: 1 } },
            })
          : Promise.resolve([]),
      ]);

      const vmap = new Map(
        variants.map((v) => [
          v.id,
          {
            name: v.title ? `${v.part.name} · ${v.title}` : v.part.name,
            sku: v.sku,
            partId: v.partId,
          },
        ]),
      );
      const pmap = new Map(
        parts.map((p) => [p.id, { name: p.name, sku: p.variants[0]?.sku ?? null, partId: p.id }]),
      );
      return { variants: vmap, parts: pmap };
    });
  }
}

/**
 * La clave del grupo viaja en la URL (`?grupo=<key>`). Se aceptan tres formas y ninguna otra: un
 * prefijo libre terminaría siendo un `where` armado con texto del cliente.
 */
function scopeOf(key: string): { variantId?: string; partId?: string; rawQuery?: string } {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (key.startsWith('variant:')) {
    const id = key.slice('variant:'.length);
    if (uuid.test(id)) return { variantId: id };
  }
  if (key.startsWith('part:')) {
    const id = key.slice('part:'.length);
    if (uuid.test(id)) return { partId: id };
  }
  if (key.startsWith('term:')) {
    const term = key.slice('term:'.length).slice(0, 120);
    if (term) return { rawQuery: term };
  }
  throw new BadRequestException({ code: 'INVALID_GROUP', message: 'Grupo de aviso inválido' });
}
