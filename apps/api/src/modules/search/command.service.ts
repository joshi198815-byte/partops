import { Inject, Injectable } from '@nestjs/common';
import { type CommandHit, type CommandResponse, groupHits, rankHits } from '@partops/contracts';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { SearchService } from '../search/search.service.js';

/**
 * Búsqueda global de la paleta.
 *
 * Tres fuentes en paralelo y una regla: **todo pasa por el tenant del contexto**. La paleta es la
 * pantalla que más texto libre recibe y la que más fácil filtraría datos de otro negocio si alguna
 * consulta olvidara el `WHERE`.
 *
 * La búsqueda de piezas reutiliza `SearchService` con `record: false`: escribir en `search_event`
 * desde la paleta contaminaría el BI de demanda, que mide lo que la gente buscó en el mostrador y
 * la vitrina. Aquí es navegación, no una consulta de venta.
 */
@Injectable()
export class CommandService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(SearchService) private readonly search: SearchService,
  ) {}

  async find(ctx: Ctx, query: string): Promise<CommandResponse> {
    const q = query.trim();
    const tenantId = ctx.tenant.tenantId;

    if (!q) {
      return { query: q, groups: groupHits(this.actions(ctx)) };
    }

    const like = `%${q}%`;
    const digits = q.replace(/\D/g, '');
    // El prefijo del folio vive en el negocio y el contexto no lo trae: se lee una vez y se usa para
    // pintar `PD-0042` como se dice en el mostrador.
    const prefix = await this.db
      .tx(
        tenantId,
        (tx) =>
          tx.$queryRaw<Array<{ orderPrefix: string }>>`
          SELECT "orderPrefix" FROM "tenant" WHERE "id" = ${tenantId}`,
      )
      .then((rows) => rows[0]?.orderPrefix ?? 'PD')
      .catch(() => 'PD');
    const folio = (number: number) => `${prefix}-${String(number).padStart(4, '0')}`;

    const [parts, orders, customers] = await Promise.all([
      this.search
        .run(ctx, { q, limit: 6, record: false })
        .then((res) => res.hits.map((hit) => this.partHit(hit)))
        .catch(() => [] as CommandHit[]),
      this.db
        .tx(
          tenantId,
          (tx) =>
            tx.$queryRaw<Array<{ id: string; number: number; customerName: string; status: string }>>`
            SELECT o."id", o."number", o."customerName", o."status"::text AS "status"
            FROM "sales_order" o
            WHERE o."tenantId" = ${tenantId}
              AND (o."customerName" ILIKE ${like}
                OR coalesce(o."customerPhone", '') ILIKE ${like}
                OR (${digits || '-1'} <> '-1' AND o."number"::text = ${digits || '-1'}))
            ORDER BY o."createdAt" DESC
            LIMIT 6`,
        )
        .then((rows) =>
          rows.map((row) => ({
            id: row.id,
            kind: 'order' as const,
            title: `Pedido ${folio(row.number)}`,
            subtitle: `${row.customerName} · ${STATUS_LABEL[row.status] ?? row.status}`,
            code: folio(row.number),
            href: `/app/ventas/${row.id}`,
          })),
        )
        .catch(() => [] as CommandHit[]),
      this.db
        .tx(
          tenantId,
          (tx) =>
            tx.$queryRaw<Array<{ id: string; name: string; phone: string | null }>>`
            SELECT c."id", c."name", c."phone"
            FROM "customer" c
            WHERE c."tenantId" = ${tenantId}
              AND (c."name" ILIKE ${like} OR coalesce(c."phone", '') ILIKE ${like})
            ORDER BY c."name" ASC
            LIMIT 6`,
        )
        .then((rows) =>
          rows.map((row) => ({
            id: row.id,
            kind: 'customer' as const,
            title: row.name,
            subtitle: row.phone,
            code: row.phone,
            href: `/app/ventas?q=${encodeURIComponent(row.name)}`,
          })),
        )
        .catch(() => [] as CommandHit[]),
    ]);

    const ordered = rankHits([...parts, ...orders, ...customers], q, 20);
    return { query: q, groups: groupHits(ordered) };
  }

  /**
   * Acciones que la paleta ofrece cuando aún no hay texto.
   *
   * Se arman desde los permisos y no desde el rol: un rol propio con `catalog.import` ve "Importar
   * catálogo" aunque no se llame "administrador". Lo que no se puede hacer no se ofrece.
   */
  private actions(ctx: Ctx): CommandHit[] {
    const perms = ctx.tenant.permissions;
    const defs: Array<{ id: string; permission: string; title: string; href: string }> = [
      { id: 'new-sale', permission: 'orders.create', title: 'Nueva venta', href: '/app/ventas/nueva' },
      { id: 'search', permission: 'catalog.view', title: 'Buscar pieza', href: '/app/buscar' },
      { id: 'dispatch', permission: 'orders.dispatch', title: 'Preparar pedidos', href: '/app/despacho' },
      { id: 'inventory', permission: 'inventory.view', title: 'Ver inventario', href: '/app/inventario' },
      {
        id: 'import',
        permission: 'catalog.import',
        title: 'Importar catálogo',
        href: '/app/catalogo/importar',
      },
      { id: 'finance', permission: 'finance.view', title: 'Ver finanzas', href: '/app/finanzas' },
      { id: 'demand', permission: 'demand.view', title: 'Ver demanda', href: '/app/demanda' },
      { id: 'team', permission: 'team.manage', title: 'Equipo y roles', href: '/app/equipo' },
      {
        id: 'settings',
        permission: 'settings.manage',
        title: 'Configuración del negocio',
        href: '/app/configuracion',
      },
      { id: 'audit', permission: 'audit.view', title: 'Ver auditoría', href: '/app/auditoria' },
    ];

    return defs
      .filter((def) => perms.has(def.permission as never))
      .map((def) => ({
        id: def.id,
        kind: 'action' as const,
        title: def.title,
        subtitle: null,
        code: null,
        href: def.href,
      }));
  }

  /** Una pieza de `SearchService` como resultado de paleta: la variante más pertinente da el código. */
  private partHit(hit: {
    partId: string;
    name: string;
    brand: string | null;
    totalAvailable: number;
    variants: Array<{ sku: string; oemNumbers: string[] }>;
  }): CommandHit {
    const variant = hit.variants[0];
    const code = variant?.sku ?? variant?.oemNumbers[0] ?? null;
    return {
      id: hit.partId,
      kind: 'part',
      title: hit.name,
      subtitle: [hit.brand, hit.totalAvailable > 0 ? `${hit.totalAvailable} disponibles` : 'sin existencia']
        .filter(Boolean)
        .join(' · '),
      code,
      href: `/app/buscar?q=${encodeURIComponent(code ?? hit.name)}`,
    };
  }
}

const STATUS_LABEL: Record<string, string> = {
  ABIERTO: 'abierto',
  EN_PREPARACION: 'en preparación',
  LISTO: 'listo',
  ENTREGADO: 'entregado',
  PARCIAL: 'parcial',
  CANCELADO: 'cancelado',
};
