import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/context.js';
import { DatabaseService } from '../infra/database.module.js';
import { InventoryService } from './inventory/inventory.service.js';

@Controller('health')
@Public()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

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
   *
   * `commit` es el SHA que el proveedor inyecta al construir. Sirve para dos cosas: el pipeline
   * espera a ver el suyo antes de dar el despliegue por bueno, y un humano puede confirmar de un
   * vistazo qué código está sirviendo sin abrir el panel del proveedor. `null` cuando se corre
   * fuera de un despliegue (local, tests), que es distinto de "commit desconocido".
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.db.ping();
    const healthy = result.ok && result.rls;
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      ok: healthy,
      commit: deployedCommit(),
      database: result.ok,
      rlsEnforced: result.rls,
      latencyMs: result.latencyMs,
      uptimeMs: Date.now() - this.startedAt,
    };
  }
}

/**
 * SHA del despliegue.
 *
 * Se leen tres variables porque cada proveedor usa la suya (Render, Fly y Actions respectivamente)
 * y leerlas todas cuesta una línea. Se prefiere la que inyecta el proveedor antes que un
 * `git rev-parse` en tiempo de ejecución: en la imagen final no hay `.git`, y un `execSync` ahí
 * tumbaría el arranque del contenedor.
 */
function deployedCommit(): string | null {
  for (const name of ['RENDER_GIT_COMMIT', 'GIT_COMMIT', 'GITHUB_SHA']) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export const API_CONTROLLERS = [HealthController];
export const API_PROVIDERS = [InventoryService];
