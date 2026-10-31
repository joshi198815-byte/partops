import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/context.js';
import { env } from '../../config/env.js';
import { MaintenanceService } from '../../infra/maintenance.service.js';

/**
 * Disparo externo del mantenimiento.
 *
 * Existe porque el `setInterval` de `MaintenanceService` vive dentro del proceso: si el proveedor
 * duerme el servicio por inactividad, el temporizador se congela con él y el rollup del día no
 * corre. Un cron externo que despierta la API resuelve las dos cosas de una vez.
 *
 * Tres decisiones de seguridad:
 *
 *  1. **Sin `CRON_SECRET`, la ruta responde 404**, no 401 ni 500. Una ruta que existe y pide clave
 *     confirma que hay algo que atacar; un 404 la deja indistinguible de un endpoint inventado.
 *     Además, un servicio mal configurado en producción falla visiblemente en el primer intento del
 *     cron en vez de quedar abierto con una comparación contra `undefined`.
 *  2. **`timingSafeEqual`** y no `===`: comparar cadenas termina en el primer byte distinto, y el
 *     tiempo que tarda en fallar filtra cuántos caracteres del secreto acertó. Con un secreto de 32
 *     bytes y un atacante con paciencia, eso es un secreto adivinable.
 *  3. **`202` y no `200`**: el trabajo puede tardar minutos y el cron no debe esperar. Se acepta la
 *     petición y el resultado queda en `background_job`, que es donde se consulta después.
 *
 * La ruta es `@Public()` porque el cron no tiene sesión. La autorización es el secreto compartido, y
 * por eso no hay ningún otro endpoint detrás de este controlador.
 */
@Controller('maintenance')
export class MaintenanceController {
  constructor(@Inject(MaintenanceService) private readonly maintenance: MaintenanceService) {}

  @Post('run')
  @Public()
  @HttpCode(202)
  async run(@Req() req: Request) {
    const expected = env.CRON_SECRET?.trim();
    if (!expected) throw new NotFoundException('No encontrado');

    const provided = req.headers['x-cron-secret'];
    const token = Array.isArray(provided) ? provided[0] : provided;
    if (!token || !safeEqual(token, expected)) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'No autorizado' });
    }

    // No se espera: el cron tiene timeout y el trabajo puede tardar. El cerrojo en
    // `background_job` hace que dos disparos simultáneos no dupliquen nada.
    void this.maintenance.tick().catch(() => undefined);
    return { accepted: true };
  }
}

/**
 * Comparación en tiempo constante.
 *
 * `timingSafeEqual` exige buffers del mismo largo y lanza si difieren —y una excepción tarda
 * distinto que un `false`, que es justo la señal que se quiere evitar. Se comparan los SHA-256, que
 * siempre miden 32 bytes: el tiempo depende solo del contenido, nunca de la longitud.
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
