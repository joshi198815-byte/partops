import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@partops/contracts';
import type { AuthedRequest, RequestContext } from '../common/context.js';
import { IS_PUBLIC, NO_TENANT, PENDING_PASSWORD_OK, PERMISSIONS, PLATFORM_ADMIN } from '../common/context.js';
import { AuthService } from './auth.service.js';

/**
 * Guard global: sesión, negocio activo y permisos, en ese orden.
 *
 * Orden deliberado:
 *  1. `@Public()` → pasa sin tocar la base (salud, catálogo público, webhooks).
 *  2. Sesión: sin cookie válida, 401.
 *  3. `@NoTenant()` → pasa con sesión pero sin negocio (onboarding, elegir negocio, /me).
 *  4. Negocio: header `x-tenant-id` > negocio activo de la sesión > primer negocio. Si el usuario
 *     no pertenece a ese negocio, 403 — nunca se "cae" a otro negocio por comodidad, porque eso
 *     enseñaría datos de una bodega a un empleado de otra.
 *  5. Permisos del rol resueltos con caché de 30 s.
 *
 * Todo lo que el handler necesita queda en `req.ctx`, y los decoradores de `@common/context` lo
 * leen de ahí. Así un controlador no vuelve a consultar membresía ni rol.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    if (isPublic) return true;

    // Solo HTTP: los gateways de WebSocket validan el handshake por su cuenta.
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const session = await this.auth.getSession(req.headers);
    if (!session?.user) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Inicia sesión' });
    }

    const ctx: RequestContext = {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? null,
        emailVerified: session.user.emailVerified,
        mustChangePassword: Boolean((session.user as { mustChangePassword?: boolean }).mustChangePassword),
        role: (session.user as { role?: string | null }).role ?? null,
      },
      sessionId: session.session.id,
      activeTenantId: session.session.activeTenantId ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
    req.ctx = ctx;

    // Contraseña temporal sin cambiar: fuera de las pocas rutas marcadas, el guard corta aquí.
    // El vendedor al que se le entrega una cuenta con contraseña dictada no puede seguir usando
    // el sistema con esa clave: es la clave que conoce el dueño y probablemente el grupo de
    // WhatsApp de la bodega.
    if (
      ctx.user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(PENDING_PASSWORD_OK, targets)
    ) {
      throw new ForbiddenException({
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Cambia la contraseña temporal para continuar',
      });
    }

    if (this.reflector.getAllAndOverride<boolean>(NO_TENANT, targets)) return true;

    // El panel de plataforma va antes de resolver negocio: quien lo usa es el dueño de PartOps y
    // puede no pertenecer a ningún negocio. Si se comprobara después, un admin sin membresía
    // recibiría «termina de configurar tu negocio» en vez del panel.
    const needsAdmin = this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN, targets);
    if (needsAdmin) {
      if (!this.auth.isPlatformAdmin(ctx.user)) {
        // 404 y no 403: el panel de plataforma no debe confirmar su existencia a un cliente.
        throw new NotFoundException('No encontrado');
      }
      return true;
    }

    const tenantId = await this.pickTenant(req, ctx);
    if (!tenantId) {
      throw new ForbiddenException({
        code: 'NO_TENANT',
        message: 'Termina la configuración de tu negocio para continuar',
      });
    }

    ctx.tenant = await this.auth.resolveTenant(ctx.user.id, tenantId);
    ctx.activeTenantId = tenantId;

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS, targets) ?? [];
    const missing = required.filter((p) => !ctx.tenant?.permissions.has(p));
    if (missing.length) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'No tienes permiso para esta acción',
        missing,
      });
    }

    return true;
  }

  /**
   * Negocio activo. El header manda para que una pestaña pueda mirar otro negocio sin cambiar el
   * de la sesión (el propietario que tiene dos sucursales); la sesión es el respaldo persistente.
   *
   * Si no hay ninguno, se toma el primer negocio del usuario: quien tiene uno solo nunca ve una
   * pantalla pidiendo elegir entre una lista de uno.
   */
  private async pickTenant(req: AuthedRequest, ctx: RequestContext): Promise<string | null> {
    const header = req.headers['x-tenant-id'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    if (ctx.activeTenantId) return ctx.activeTenantId;
    return this.auth.firstMembership(ctx.user.id);
  }
}
