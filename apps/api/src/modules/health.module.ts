import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../infra/database.module.js';
import { InventoryService } from './inventory/inventory.service.js';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly db: DatabaseService) {}

  /** Liveness: Render lo usa para saber que el proceso responde. No toca la base. */
  @Get('live')
  live() {
    return { ok: true, uptimeMs: Date.now() - this.startedAt };
  }

  /**
   * Readiness: confirma base accesible Y que RLS está forzado en el esquema.
   *
   * Si `rls` viniera en false, el despliegue está mal (migración sin aplicar o conexión como
   * dueño) y es mejor que el balanceador saque la instancia de rotación a que sirva datos
   * de un negocio a otro.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.db.ping();
    const healthy = result.ok && result.rls;
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      ok: healthy,
      database: result.ok,
      rlsEnforced: result.rls,
      latencyMs: result.latencyMs,
      uptimeMs: Date.now() - this.startedAt,
    };
  }
}

export const API_CONTROLLERS = [HealthController];
export const API_PROVIDERS = [InventoryService];
