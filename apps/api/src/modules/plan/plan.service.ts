import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { nextPlan, type PlanFeature, type PlanSpec, planSpec } from '@partops/contracts';
import type { TxClient } from '@partops/db';
import type { TenantContext } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';

/**
 * Lo único que un candado necesita del request: el negocio activo.
 *
 * Se pide `TenantContext` y no `Ctx` porque el equipo y las invitaciones reciben el tenant suelto,
 * sin el usuario ni la sesión. Un tipo más ancho obligaría a esos servicios a fabricar un `Ctx`
 * falso solo para consultar el plan.
 */
export type PlanCtx = { tenant: Pick<TenantContext, 'tenantId'> };

/**
 * El plan del negocio y los topes que la API hace cumplir.
 *
 * Tres decisiones que se ven en el código:
 *
 *  1. **El plan se lee de `plan_grant`, no del `tenant`.** Cada concesión es una fila con fecha, así
 *     que el historial de qué se le prometió a quién y desde cuándo nunca se sobrescribe.
 *  2. **Un plan vencido degrada a FREE; nunca bloquea la venta.** Si el dueño olvidó renovar, el
 *     negocio sigue operando con los topes del plan gratis, conserva todo lo que ya cargó y ve el
 *     aviso en Configuración. Cortarle la caja un lunes por la mañana es cómo se pierde un cliente.
 *  3. **El tope frena crear, no vender ni editar.** Un negocio con 2.100 piezas y plan PRO sigue
 *     vendiendo, ajustando y despachando; solo no puede crear la 2.101 hasta que suba o archive.
 *
 * Todos los conteos van dentro de la transacción con `app.tenant_id` fijado: `part` y `member`
 * están bajo RLS, y contar desde el cliente base devolvería cero filas.
 */
@Injectable()
export class PlanService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * Tier vigente.
   *
   * **Manda la concesión más reciente, vencida o no.** Si venció, el negocio queda en FREE; no
   * «resucita» a una concesión anterior que seguía vigente. Lo contrario haría que bajar de TALLER
   * a PRO y dejar vencer el PRO devolviera el TALLER viejo, que es lo opuesto a lo que pidió el
   * dueño y a lo que dice el recibo que pagó.
   *
   * Se acepta un `tx` opcional para que quien ya abrió una transacción no pague una segunda
   * conexión al pool de Neon.
   */
  async effective(ctx: PlanCtx, tx?: TxClient): Promise<PlanSpec> {
    const load = (c: TxClient) =>
      c.planGrant.findFirst({
        where: { tenantId: ctx.tenant.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { tier: true, expiresAt: true },
      });

    const row = tx ? await load(tx) : await this.db.tx(ctx.tenant.tenantId, load);
    if (!row) return planSpec(null);
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return planSpec(null);
    return planSpec(row.tier);
  }

  /**
   * ¿Caben `incoming` piezas nuevas?
   *
   * `incoming = 0` es una consulta sin intención de escribir y nunca lanza, aunque el negocio ya
   * esté por encima del tope por una baja de plan: se usa para pintar el aviso sin romper la vista.
   */
  async assertCanAddParts(ctx: PlanCtx, tx: TxClient, incoming: number): Promise<void> {
    const spec = await this.effective(ctx, tx);
    const limit = spec.limits.parts;
    if (limit === null || incoming <= 0) return;

    const used = await tx.part.count({
      where: { tenantId: ctx.tenant.tenantId, status: { not: 'ARCHIVADO' } },
    });
    if (used + incoming <= limit) return;

    throw this.limitError('piezas', used, limit, spec);
  }

  /**
   * Cuántas piezas nuevas caben todavía, para presupuestar un lote de importación.
   *
   * Devuelve `Number.POSITIVE_INFINITY` cuando el plan no tiene tope y `0` cuando ya no cabe
   * ninguna. **No lanza**: quien llama decide qué hacer con las filas que sobren, porque un archivo
   * de 400 filas puede caber a medias y hay que decirlo fila por fila, no abortar el archivo entero.
   */
  async partBudget(ctx: PlanCtx, tx: TxClient): Promise<number> {
    const spec = await this.effective(ctx, tx);
    const limit = spec.limits.parts;
    if (limit === null) return Number.POSITIVE_INFINITY;

    const used = await tx.part.count({
      where: { tenantId: ctx.tenant.tenantId, status: { not: 'ARCHIVADO' } },
    });
    return Math.max(0, limit - used);
  }

  /**
   * Invitar a una persona más.
   *
   * Cuenta miembros activos **más invitaciones pendientes**: un enlace sin canjear ya ocupa su
   * lugar; si solo contara miembros, se podrían mandar diez invitaciones con tope de cinco.
   */
  async assertCanAddMember(ctx: PlanCtx, tx: TxClient): Promise<void> {
    const spec = await this.effective(ctx, tx);
    const limit = spec.limits.members;
    if (limit === null) return;

    const [members, pending] = await Promise.all([
      tx.member.count({ where: { tenantId: ctx.tenant.tenantId, isActive: true } }),
      tx.invitation.count({
        where: { tenantId: ctx.tenant.tenantId, status: 'PENDIENTE', expiresAt: { gt: new Date() } },
      }),
    ]);
    const used = members + pending;
    if (used + 1 <= limit) return;

    throw this.limitError('usuarios', used, limit, spec);
  }

  /**
   * Filas por archivo. Se comprueba antes de interpretar: no tiene sentido validar 4.000 filas que
   * no se van a poder guardar.
   */
  async assertImportRows(ctx: PlanCtx, rows: number): Promise<void> {
    const spec = await this.effective(ctx);
    const limit = spec.limits.importRowsPerFile;
    if (limit === null || rows <= limit) return;

    const next = nextPlan(spec.tier);
    throw new ForbiddenException({
      code: 'PLAN_LIMIT',
      message:
        `Tu plan ${spec.name} acepta hasta ${limit} filas por archivo y este tiene ${rows}.` +
        (next ? ` El plan ${next.name} acepta ${next.limits.importRowsPerFile}.` : ''),
    });
  }

  /** Características de sí/no (catálogo público, exportar). */
  async assertFeature(ctx: PlanCtx, feature: PlanFeature): Promise<void> {
    const spec = await this.effective(ctx);
    if (spec.limits[feature]) return;

    const next = nextPlan(spec.tier);
    const what = feature === 'publicCatalog' ? 'El catálogo público' : 'Exportar datos';
    throw new ForbiddenException({
      code: 'PLAN_LIMIT',
      message: `${what} entra desde el plan ${next?.name ?? 'Mostrador'}. Hoy tienes ${spec.name}.`,
    });
  }

  /** Cifras para la pantalla de Configuración, en una sola transacción. */
  async usage(ctx: PlanCtx): Promise<{ parts: number; members: number }> {
    return this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const [parts, members] = await Promise.all([
        tx.part.count({ where: { tenantId: ctx.tenant.tenantId, status: { not: 'ARCHIVADO' } } }),
        tx.member.count({ where: { tenantId: ctx.tenant.tenantId, isActive: true } }),
      ]);
      return { parts, members };
    });
  }

  private limitError(unit: string, used: number, limit: number, spec: PlanSpec): ForbiddenException {
    const next = nextPlan(spec.tier);
    return new ForbiddenException({
      code: 'PLAN_LIMIT',
      message:
        `Tu plan ${spec.name} incluye ${limit} ${unit} y ya tienes ${used}.` +
        (next ? ` Sube a ${next.name} para seguir cargando.` : ' Archiva lo que no usas para hacer espacio.'),
    });
  }
}
