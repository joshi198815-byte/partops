import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { type AdminOverview, type PlanGrant, planGrantSchema } from '@partops/contracts';
import { CurrentCtx, PlatformAdmin, type RequestContext } from '../../common/context.js';
import { ZodBody } from '../../common/zod.js';
import { PlatformService } from './platform.service.js';

/**
 * Panel de plataforma.
 *
 * `@PlatformAdmin()` en la clase, y el guard lo resuelve **antes** de pedir negocio: el dueño de
 * PartOps puede no ser miembro de ningún negocio y aun así debe entrar. A un cliente se le responde
 * 404, no 403, para no confirmarle que este panel existe.
 */
@Controller('platform')
@PlatformAdmin()
export class PlatformController {
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  @Get('overview')
  overview(): Promise<AdminOverview> {
    return this.platform.overview();
  }

  @Post('tenants/:id/plan')
  @HttpCode(200)
  grantPlan(
    @CurrentCtx() ctx: RequestContext,
    @Param('id') tenantId: string,
    @ZodBody(planGrantSchema) input: PlanGrant,
  ): Promise<{ ok: true }> {
    return this.platform.grantPlan(ctx, tenantId, input);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(200)
  suspend(@CurrentCtx() ctx: RequestContext, @Param('id') tenantId: string): Promise<{ ok: true }> {
    return this.platform.setSuspended(ctx, tenantId, true);
  }

  @Post('tenants/:id/resume')
  @HttpCode(200)
  resume(@CurrentCtx() ctx: RequestContext, @Param('id') tenantId: string): Promise<{ ok: true }> {
    return this.platform.setSuspended(ctx, tenantId, false);
  }
}
