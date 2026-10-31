import { Controller, Get, Inject } from '@nestjs/common';
import type { DashboardToday } from '@partops/contracts';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { DashboardService } from './dashboard.service.js';

/**
 * Tablero del día.
 *
 * `dashboard.view` y no `finance.view`: el bodeguero sin permiso de dinero tiene derecho a ver
 * cuánto le falta por sacar del estante. Lo que no tiene es ver el importe vendido, y el servicio
 * se lo entrega en `null` en vez de esconderle la pantalla completa.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get('today')
  @RequirePermissions('dashboard.view')
  today(@CurrentCtx() ctx: Ctx): Promise<DashboardToday> {
    return this.dashboard.today(ctx);
  }
}
