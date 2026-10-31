import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminJobRow, AdminOverview, AdminTenantRow, PlanGrant } from '@partops/contracts';
import { AuthService } from '../../auth/auth.service.js';
import { audit } from '../../common/audit.js';
import type { RequestContext } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';

/** Estado de los trabajos: lo que se considera sano y lo que ya pide atención. */
export const JOB_HEALTH = {
  ok: ['DONE', 'PENDING', 'RUNNING'],
  bad: ['FAILED'],
} as const;

/**
 * Operación de la plataforma.
 *
 * Todo pasa por `db.system`: el panel existe justamente para ver a través de los negocios. Por eso
 * `db.tx` no se usa ni una vez aquí; si alguna consulta necesitara `db.tx` sería señal de que no
 * pertenece a este módulo.
 *
 * `plan_grant` está bajo RLS forzado, pero la lectura ocurre dentro de `db.system`, y la escritura
 * también: el bypass es explícito, no un agujero. Cada mutación deja su renglón en `audit_log` del
 * negocio afectado, para que el dueño lo vea en `/app/auditoria` el día que le cambien el plan.
 */
@Injectable()
export class PlatformService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async overview(): Promise<AdminOverview> {
    return this.db.system(async (tx) => {
      const tenants = await tx.$queryRaw<
        Array<{
          id: string;
          name: string;
          slug: string;
          suspended: boolean;
          createdAt: Date;
          members: number;
          parts: number;
          orders30d: number;
          planTier: string | null;
          planExpiresAt: Date | null;
          lastActivityAt: Date | null;
        }>
      >`
        SELECT
          t."id", t."name", t."slug", t."suspended", t."createdAt",
          (SELECT count(*) FROM "member" m
            WHERE m."tenantId" = t."id" AND m."isActive")::int AS "members",
          (SELECT count(*) FROM "part" p
            WHERE p."tenantId" = t."id" AND p."status" = 'ACTIVO')::int AS "parts",
          (SELECT count(*) FROM "sales_order" o
            WHERE o."tenantId" = t."id" AND o."createdAt" > now() - interval '30 days')::int AS "orders30d",
          g."tier" AS "planTier",
          g."expiresAt" AS "planExpiresAt",
          -- GREATEST ignora los NULL: un negocio que nunca vendió pero sí buscó tiene actividad.
          GREATEST(
            (SELECT max(o."createdAt") FROM "sales_order" o WHERE o."tenantId" = t."id"),
            (SELECT max(s."createdAt") FROM "search_event" s WHERE s."tenantId" = t."id")
          ) AS "lastActivityAt"
        FROM "tenant" t
        -- El plan vigente: el más reciente que no venció. Los vencidos quedan como historial y no
        -- se borran, porque saber qué se le prometió a quién vale más que una tabla limpia.
        LEFT JOIN LATERAL (
          SELECT pg."tier", pg."expiresAt"
          FROM "plan_grant" pg
          WHERE pg."tenantId" = t."id" AND (pg."expiresAt" IS NULL OR pg."expiresAt" > now())
          ORDER BY pg."createdAt" DESC
          LIMIT 1
        ) g ON TRUE
        ORDER BY t."suspended" ASC, t."createdAt" DESC`;

      const jobs = await tx.$queryRaw<
        Array<{
          id: string;
          queue: string;
          status: string;
          runAt: Date;
          attempts: number;
          lastError: string | null;
        }>
      >`
        SELECT "id", "queue", "status", "runAt", "attempts", "lastError"
        FROM "background_job"
        ORDER BY "runAt" DESC
        LIMIT 20`;

      const [demand] = await tx.$queryRaw<Array<{ searches30d: number; missed30d: number }>>`
        SELECT
          (SELECT count(*) FROM "search_event"
            WHERE "createdAt" > now() - interval '30 days')::int AS "searches30d",
          (SELECT count(*) FROM "search_event"
            WHERE "resultCount" = 0 AND "createdAt" > now() - interval '30 days')::int AS "missed30d"`;

      const topTerms = await tx.$queryRaw<Array<{ term: string; count: number }>>`
        SELECT "normalized" AS "term", count(*)::int AS "count"
        FROM "search_event"
        WHERE "createdAt" > now() - interval '30 days'
        GROUP BY 1
        ORDER BY 2 DESC, 1 ASC
        LIMIT 10`;

      const [reference] = await tx.$queryRaw<Array<{ brands: number; models: number; vehicles: number }>>`
        SELECT
          (SELECT count(*) FROM "vehicle_brand")::int AS "brands",
          (SELECT count(*) FROM "vehicle_model")::int AS "models",
          (SELECT count(*) FROM "vehicle")::int AS "vehicles"`;

      return {
        tenants: tenants.map(
          (row): AdminTenantRow => ({
            id: row.id,
            name: row.name,
            slug: row.slug,
            suspended: row.suspended,
            members: Number(row.members),
            parts: Number(row.parts),
            orders30d: Number(row.orders30d),
            planTier: row.planTier,
            planExpiresAt: row.planExpiresAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
          }),
        ),
        jobs: jobs.map(
          (row): AdminJobRow => ({
            id: row.id,
            queue: row.queue,
            status: row.status,
            runAt: row.runAt.toISOString(),
            attempts: row.attempts,
            lastError: row.lastError,
          }),
        ),
        demand: {
          searches30d: Number(demand?.searches30d ?? 0),
          missed30d: Number(demand?.missed30d ?? 0),
          topTerms: topTerms.map((row) => ({ term: row.term, count: Number(row.count) })),
        },
        reference: {
          brands: Number(reference?.brands ?? 0),
          models: Number(reference?.models ?? 0),
          vehicles: Number(reference?.vehicles ?? 0),
        },
      };
    });
  }

  /** Concede un plan. El historial se conserva: cada concesión es una fila, no un campo sobrescrito. */
  async grantPlan(ctx: RequestContext, tenantId: string, input: PlanGrant): Promise<{ ok: true }> {
    await this.db.system(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
      if (!tenant) throw new NotFoundException('Negocio no encontrado');

      await tx.planGrant.create({
        data: {
          tenantId,
          tier: input.tier,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          note: input.note ?? null,
          grantedById: ctx.user.id,
        },
      });

      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'platform.plan_granted',
        entity: 'tenant',
        entityId: tenantId,
        after: { tier: input.tier, expiresAt: input.expiresAt, note: input.note ?? null },
      });
    });
    return { ok: true };
  }

  /**
   * Suspende o reactiva. No borra nada: el negocio conserva historial, pedidos y catálogo, y el
   * día que paga vuelve a entrar como si nada.
   *
   * La caché de permisos del guard se invalida aquí. Sin eso, el negocio suspendido seguiría
   * operando hasta treinta segundos después de la llamada, y el dueño juraría que la suspensión no
   * funciona.
   */
  async setSuspended(ctx: RequestContext, tenantId: string, suspended: boolean): Promise<{ ok: true }> {
    await this.db.system(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, suspended: true },
      });
      if (!tenant) throw new NotFoundException('Negocio no encontrado');
      if (tenant.suspended === suspended) return;

      await tx.tenant.update({ where: { id: tenantId }, data: { suspended } });
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: suspended ? 'platform.tenant_suspended' : 'platform.tenant_resumed',
        entity: 'tenant',
        entityId: tenantId,
        before: { suspended: tenant.suspended },
        after: { suspended },
      });
    });

    this.auth.invalidateTenant(tenantId);
    return { ok: true };
  }
}
