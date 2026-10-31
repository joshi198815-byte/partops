import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { acceptInvitationSchema, type MeResponse, staffHomePath } from '@partops/contracts';
import { z } from 'zod';
import type { AuthedRequest, Ctx } from '../common/context.js';
import { AllowPendingPassword, CurrentCtx, NoTenant, Public } from '../common/context.js';
import { ZodBody } from '../common/zod.js';
import { OnboardingService } from '../modules/onboarding/onboarding.service.js';
import { AuthService } from './auth.service.js';

const switchTenantSchema = z.object({ tenantId: z.string().uuid() });

/**
 * Identidad y sesión.
 *
 * `/me` es la primera llamada de la web al arrancar: devuelve en un solo viaje lo que el shell
 * necesita (usuario, negocio activo, permisos, negocios disponibles, si falta onboarding y a qué
 * pantalla ir). Evita el patrón de seis llamadas encadenadas antes de pintar nada, que en una
 * conexión de bodega se nota.
 */
@Controller()
export class MeController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
  ) {}

  @Get('me')
  @NoTenant()
  @AllowPendingPassword()
  async me(@CurrentCtx() ctx: Ctx, @Req() req: AuthedRequest): Promise<MeResponse> {
    const [memberships, onboarding] = await Promise.all([
      this.auth.listMemberships(ctx.user.id),
      this.onboarding.state(ctx.user),
    ]);

    // El negocio activo puede venir del header (una pestaña mirando otra sucursal) o de la sesión.
    const header = req.headers['x-tenant-id'];
    const requested = typeof header === 'string' && header.trim() ? header.trim() : null;
    const activeId =
      (requested && memberships.some((m) => m.tenantId === requested) ? requested : null) ??
      ctx.activeTenantId ??
      memberships.find((m) => !m.suspended)?.tenantId ??
      null;

    const active = activeId ? await this.safeTenant(ctx.user.id, activeId) : null;

    return {
      user: {
        id: ctx.user.id,
        name: ctx.user.name,
        email: ctx.user.email,
        image: ctx.user.image ?? null,
        emailVerified: ctx.user.emailVerified,
        mustChangePassword: ctx.user.mustChangePassword,
      },
      tenant: active
        ? {
            id: active.tenantId,
            name: active.tenantName,
            slug: active.tenantSlug,
            role: active.role,
            permissions: [...active.permissions],
            warehouseIds: active.warehouseIds,
          }
        : null,
      memberships,
      isPlatformAdmin: this.auth.isPlatformAdmin(ctx.user),
      // Solo se manda cuando falta algo: la web no debe mostrar el asistente a alguien que ya
      // terminó, ni volver a preguntarle el nombre de su negocio.
      onboarding: onboarding.nextStep ? onboarding : null,
      homePath: active ? staffHomePath([active.role], [...active.permissions]) : onboarding.nextPath,
    };
  }

  /** Cambia el negocio activo de la sesión (selector de sucursal). */
  @Post('me/tenant')
  @NoTenant()
  @HttpCode(200)
  async switchTenant(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(switchTenantSchema) body: z.output<typeof switchTenantSchema>,
  ) {
    await this.auth.setActiveTenant(ctx.user.id, body.tenantId);
    return { ok: true, tenantId: body.tenantId };
  }

  /** Cierra las demás sesiones. Se usa cuando el equipo comparte una computadora. */
  @Post('me/sessions/revoke-others')
  @NoTenant()
  @HttpCode(200)
  async revokeOthers(@CurrentCtx() ctx: Ctx) {
    const revoked = await this.auth.revokeOtherSessions(ctx.user.id, ctx.sessionId);
    return { revoked };
  }

  /**
   * Un negocio que no se puede resolver (miembro desactivado entre el login y esta llamada,
   * negocio suspendido) no debe romper `/me`: la web necesita pintar el selector para que la
   * persona elija otro negocio en vez de ver una pantalla en blanco.
   */
  private safeTenant(userId: string, tenantId: string) {
    return this.auth.resolveTenant(userId, tenantId).catch(() => null);
  }
}

/** Invitaciones. La vista previa es pública; el canje exige sesión. */
@Controller('invitations')
export class InvitationController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  /** Pinta el formulario antes de que exista una cuenta: nombre del negocio, quién invita, correo. */
  @Get(':token')
  @Public()
  preview(@Param('token') token: string) {
    return this.onboarding.previewInvitation(token);
  }

  /**
   * Canje. El nombre y la contraseña del cuerpo se usan solo cuando la cuenta acaba de crearse;
   * con sesión activa se ignora el cuerpo y manda la identidad ya autenticada, para que nadie
   * pueda unirse a un negocio con el correo de otra persona.
   */
  @Post('accept')
  @NoTenant()
  @AllowPendingPassword()
  @HttpCode(200)
  accept(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(acceptInvitationSchema) body: z.output<typeof acceptInvitationSchema>,
  ) {
    return this.onboarding.acceptInvitation(ctx.user, body.token);
  }
}
