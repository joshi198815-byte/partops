import type { IncomingHttpHeaders } from 'node:http';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ALL_PERMISSIONS, OWNER_ROLE, type Permission } from '@partops/contracts';
import type { TxClient } from '@partops/db';
import { fromNodeHeaders } from 'better-auth/node';
import type { AuthUser, TenantContext } from '../common/context.js';
import { DatabaseService } from '../infra/database.module.js';
import { MailService } from '../mail/mail.service.js';
import { type Auth, createAuth } from './auth.js';

interface CachedTenant {
  value: TenantContext;
  expires: number;
}

/**
 * Sesión y acceso al negocio.
 *
 * El camino caliente es `resolveTenant`: corre en el guard de CADA request autenticado. Por eso:
 *  - las lecturas de membresía, rol y negocio van en UNA transacción RLS, no en tres;
 *  - el resultado se cachea 30 s por (negocio, usuario), así una pantalla con seis llamadas no
 *    paga seis resoluciones de rol;
 *  - todo cambio de rol, bodega o estado del miembro invalida la caché al instante, para que
 *    quitarle acceso a alguien surta efecto sin esperar medio minuto.
 */
@Injectable()
export class AuthService {
  readonly auth: Auth;
  private readonly tenantCache = new Map<string, CachedTenant>();

  constructor(
    // `@Inject` explícito: la resolución por tipo depende de `emitDecoratorMetadata`, que esbuild
    // (y por tanto vitest) no emite. Con esto el contenedor funciona igual en build y en pruebas.
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(MailService) mail: MailService,
  ) {
    this.auth = createAuth(db.client, mail);
  }

  getSession(headers: IncomingHttpHeaders) {
    return this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
  }

  /** `user.role` es de plataforma, no del negocio: solo el panel interno lo usa. */
  isPlatformAdmin(user: AuthUser): boolean {
    return user.role === 'admin';
  }

  /** Primer negocio activo. Evita pedirle a alguien con un solo negocio que "elija" entre uno. */
  async firstMembership(userId: string): Promise<string | null> {
    // `member` está bajo RLS y aquí todavía no hay tenant fijado: con el cliente normal la consulta
    // devolvería cero filas y el guard mandaría a onboarding a alguien que ya tiene negocio.
    return this.db.system(async (tx) => {
      const member = await tx.member.findFirst({
        where: { userId, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { tenantId: true },
      });
      return member?.tenantId ?? null;
    });
  }

  invalidateTenant(tenantId: string, userId?: string) {
    for (const key of this.tenantCache.keys()) {
      const [cachedTenant, cachedUser] = key.split(':');
      if (cachedTenant === tenantId && (!userId || cachedUser === userId)) {
        this.tenantCache.delete(key);
      }
    }
  }

  /**
   * Membresía, permisos del rol y bodegas asignadas.
   *
   * Acepta un `tx` abierto porque el guard ya tiene una transacción con el tenant fijado; abrir
   * otra aquí duplicaría el costo de cada request.
   */
  async loadTenantAccess(userId: string, tenantId: string, tx?: TxClient): Promise<TenantContext> {
    const load = async (c: TxClient) => {
      const member = await c.member.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { roleId: true, warehouseIds: true, isActive: true },
      });
      if (!member?.isActive) {
        // Mismo mensaje para "no existe" y "está desactivado": no se confirma quién trabajó aquí.
        throw new ForbiddenException('No perteneces a este negocio');
      }
      const [role, tenant] = await Promise.all([
        c.role.findUnique({
          where: { id: member.roleId },
          select: { key: true, name: true, permissions: true },
        }),
        c.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true, suspended: true } }),
      ]);
      return { member, role, tenant };
    };

    const { member, role, tenant } = tx ? await load(tx) : await this.db.tx(tenantId, load);

    if (!tenant) throw new ForbiddenException('Negocio no encontrado');
    if (tenant.suspended) {
      throw new ForbiddenException({
        code: 'TENANT_SUSPENDED',
        message: 'Este negocio está suspendido. Escribe a soporte para reactivarlo.',
      });
    }

    // El propietario conserva todo aunque alguien edite su rol por error desde la base.
    const permissions =
      role?.key === OWNER_ROLE
        ? new Set<Permission>(ALL_PERMISSIONS)
        : new Set<Permission>((role?.permissions ?? []) as Permission[]);

    return {
      tenantId,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      role: role?.key ?? 'vendedor',
      permissions,
      warehouseIds: member.warehouseIds ?? [],
    };
  }

  /** Igual que arriba, con caché de 30 s. Es lo que usa el guard en cada request. */
  async resolveTenant(userId: string, tenantId: string): Promise<TenantContext> {
    const key = `${tenantId}:${userId}`;
    const cached = this.tenantCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

    const value = await this.db.tx(tenantId, (tx) => this.loadTenantAccess(userId, tenantId, tx));
    this.tenantCache.set(key, { value, expires: Date.now() + 30_000 });
    return value;
  }

  /**
   * Negocios del usuario, para el selector.
   *
   * Es la única lectura de `member` fuera de un contexto de tenant —la pantalla de selección aún
   * no tiene uno— y devuelve solo nombre, slug y rol, nunca datos de negocio.
   */
  async listMemberships(userId: string) {
    return this.db.system(async (tx) => {
      const members = await tx.member.findMany({
        where: { userId, isActive: true },
        select: {
          tenantId: true,
          warehouseIds: true,
          role: { select: { key: true, name: true } },
          tenant: { select: { name: true, slug: true, logoUrl: true, suspended: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return members.map((m) => ({
        tenantId: m.tenantId,
        tenantName: m.tenant.name,
        slug: m.tenant.slug,
        logoUrl: m.tenant.logoUrl,
        role: m.role.key,
        roleName: m.role.name,
        suspended: m.tenant.suspended,
      }));
    });
  }

  /**
   * Cambia el negocio activo de la sesión. La sesión es la fuente persistente; el header
   * `x-tenant-id` sirve para mirar otro negocio un rato sin tocar la preferencia.
   */
  async setActiveTenant(userId: string, tenantId: string): Promise<void> {
    const member = await this.db.system((tx) =>
      tx.member.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { isActive: true },
      }),
    );
    if (!member?.isActive) throw new NotFoundException('Negocio no encontrado');
    // `activeOrganizationId` empieza en NULL, y en SQL `NULL <> 'x'` es NULL (falso): un
    // `updateMany` con `not` no tocaría ninguna sesión nueva. Se incluye el NULL explícitamente.
    await this.db.client.session.updateMany({
      where: {
        userId,
        OR: [{ activeOrganizationId: null }, { activeOrganizationId: { not: tenantId } }],
      },
      data: { activeOrganizationId: tenantId },
    });
  }

  /**
   * Revoca todas las sesiones salvo la actual. Se usa cuando el equipo comparte una computadora y
   * alguien se va: cerrar la propia obligaría a volver a entrar sin motivo.
   */
  async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    const { count } = await this.db.client.session.deleteMany({
      where: { userId, id: { not: keepSessionId } },
    });
    return count;
  }
}
