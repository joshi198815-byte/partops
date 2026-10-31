import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import {
  onboardingBusinessSchema,
  onboardingCompleteSchema,
  onboardingTaxSchema,
  onboardingWarehouseSchema,
} from '@partops/contracts';
import type { z } from 'zod';
import { type Ctx, CurrentCtx, NoTenant, RequirePermissions } from '../../common/context.js';
import { ZodBody } from '../../common/zod.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * Alta en cuatro pasos.
 *
 * `@NoTenant()` en los pasos 1 y 2: en ese momento todavía no hay negocio al que fijar RLS, y el
 * guard no debe rechazar la petición por eso. Del paso 2 en adelante ya existe negocio y las rutas
 * exigen `settings.manage`, que el propietario tiene por definición.
 *
 * Los pasos son idempotentes: repetir el 2 cuando la bodega ya existe devuelve 409 con un mensaje
 * accionable en vez de crear una segunda bodega predeterminada.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  /** Progreso: qué falta y a dónde ir. La web lo usa para decidir si muestra el asistente. */
  @Get('state')
  @NoTenant()
  state(@CurrentCtx() ctx: Ctx) {
    return this.onboarding.state(ctx.user);
  }

  @Post('negocio')
  @NoTenant()
  @HttpCode(201)
  async business(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(onboardingBusinessSchema) body: z.output<typeof onboardingBusinessSchema>,
  ) {
    return this.onboarding.createBusiness(ctx.user, body);
  }

  @Post('bodega')
  @RequirePermissions('settings.manage')
  @HttpCode(201)
  bodega(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(onboardingWarehouseSchema) body: z.output<typeof onboardingWarehouseSchema>,
  ) {
    return this.onboarding.createFirstWarehouse(ctx.tenant, ctx.user, body);
  }

  @Post('impuestos')
  @RequirePermissions('settings.manage')
  impuestos(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(onboardingTaxSchema) body: z.output<typeof onboardingTaxSchema>,
  ) {
    return this.onboarding.setTaxes(ctx.tenant, ctx.user, body);
  }

  @Post('equipo')
  @RequirePermissions('team.manage')
  equipo(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(onboardingCompleteSchema) body: z.output<typeof onboardingCompleteSchema>,
  ) {
    return this.onboarding.finish(ctx.tenant, ctx.user, body);
  }
}
