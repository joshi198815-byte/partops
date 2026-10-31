import { Inject, Injectable } from '@nestjs/common';
import type { AuditQuery, AuditResponse, AuditRow } from '@partops/contracts';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';

/**
 * Lectura de la bitácora.
 *
 * Todo bajo `db.tx(tenantId, …)`: la tabla ya tiene RLS forzado, así que un `WHERE` olvidado no
 * podría filtrar filas ajenas; aun así se escribe explícito para que la consulta se lea sola.
 *
 * Las fechas se comparan contra los límites locales del negocio y no contra `::date` de UTC. Un
 * cambio de las 19:00 en Guatemala es de hoy; contado en UTC caería mañana y el dueño revisaría el
 * día equivocado justo cuando está buscando quién movió el precio.
 */
@Injectable()
export class AuditQueryService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async list(ctx: Ctx, query: AuditQuery): Promise<AuditResponse> {
    const tenantId = ctx.tenant.tenantId;

    return this.db.tx(tenantId, async (tx) => {
      const [tenant] = await tx.$queryRaw<Array<{ timezone: string }>>`
        SELECT "timezone" FROM "tenant" WHERE "id" = ${tenantId}`;
      const timezone = tenant?.timezone ?? 'America/Guatemala';

      // Los filtros ausentes llegan como `null` y el `IS NULL` de cada condición los deja pasar: una
      // sola consulta sirve para todas las combinaciones sin armar SQL concatenando texto. Las
      // fechas se comparan contra los límites locales del negocio, no contra `::date` de UTC.
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          action: string;
          entity: string;
          entityId: string | null;
          before: unknown;
          after: unknown;
          ip: string | null;
          createdAt: Date;
          actorName: string | null;
          actorEmail: string | null;
        }>
      >`
        SELECT
          a."id", a."action", a."entity", a."entityId",
          a."before", a."after", a."ip", a."createdAt",
          u."name" AS "actorName", u."email" AS "actorEmail"
        FROM "audit_log" a
        LEFT JOIN "user" u ON u."id" = a."userId"
        WHERE a."tenantId" = ${tenantId}
          AND (${query.entity ?? null}::text IS NULL OR a."entity" = ${query.entity ?? null}::text)
          AND (${query.action ?? null}::text IS NULL OR a."action" = ${query.action ?? null}::text)
          AND (${query.actorId ?? null}::text IS NULL OR a."userId" = ${query.actorId ?? null}::text)
          AND (${query.from ?? null}::text IS NULL
               OR a."createdAt" >= (${query.from ?? null}::text::date::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC')
          AND (${query.to ?? null}::text IS NULL
               OR a."createdAt" <  ((${query.to ?? null}::text::date + 1)::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC')
        ORDER BY a."createdAt" DESC, a."id" DESC
        LIMIT ${query.limit} OFFSET ${query.offset}`;

      const [count] = await tx.$queryRaw<Array<{ total: bigint }>>`
        SELECT count(*) AS "total" FROM "audit_log" a
        WHERE a."tenantId" = ${tenantId}
          AND (${query.entity ?? null}::text IS NULL OR a."entity" = ${query.entity ?? null}::text)
          AND (${query.action ?? null}::text IS NULL OR a."action" = ${query.action ?? null}::text)
          AND (${query.actorId ?? null}::text IS NULL OR a."userId" = ${query.actorId ?? null}::text)
          AND (${query.from ?? null}::text IS NULL
               OR a."createdAt" >= (${query.from ?? null}::text::date::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC')
          AND (${query.to ?? null}::text IS NULL
               OR a."createdAt" <  ((${query.to ?? null}::text::date + 1)::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC')`;

      const [facets] = await tx.$queryRaw<Array<{ entities: string[]; actions: string[] }>>`
        SELECT
          coalesce(array_agg(DISTINCT "entity" ORDER BY "entity"), '{}') AS "entities",
          coalesce(array_agg(DISTINCT "action" ORDER BY "action"), '{}') AS "actions"
        FROM "audit_log" WHERE "tenantId" = ${tenantId}`;

      return {
        items: rows.map(
          (row): AuditRow => ({
            id: row.id,
            action: row.action,
            entity: row.entity,
            entityId: row.entityId,
            before: row.before,
            after: row.after,
            ip: row.ip,
            createdAt: row.createdAt.toISOString(),
            actorName: row.actorName,
            actorEmail: row.actorEmail,
          }),
        ),
        total: Number(count?.total ?? 0),
        entities: facets?.entities ?? [],
        actions: facets?.actions ?? [],
      };
    });
  }
}
