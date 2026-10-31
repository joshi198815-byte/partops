import { createHash } from 'node:crypto';
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { env } from '../config/env.js';
import type { AuthedRequest } from './context.js';

/**
 * Límites por ruta.
 *
 * Tres decisiones que importan:
 *
 *  1. La clave lleva la **ruta**, no solo el controlador. `AuthController` es un comodín que atiende
 *     todo Better Auth; sin la ruta, los 10 intentos de `/sign-in/email` se gastarían también en
 *     `/sign-out` y en `/change-password`, y un usuario legítimo quedaría bloqueado por navegar.
 *  2. La clave lleva el **negocio activo** además de la IP. Una bodega con cinco teléfonos sale por
 *     una sola IP de oficina; sin el tenant, el teléfono del bodeguero competiría con el del
 *     vendedor y el guardado offline empezaría a recibir 429 sin que nadie haya abusado. El negocio
 *     se lee de `req.ctx` —ya validado por `AuthGuard`— y no del header: el header sin sesión es
 *     texto libre con el que cualquiera podría gastar el presupuesto de un negocio ajeno.
 *  3. En `test` se apaga salvo que `THROTTLE_ENFORCE=1`. Las pruebas HTTP crean decenas de cuentas
 *     desde la misma IP en segundos: con los límites puestos, la suite se rompería por diseño y no
 *     por un defecto.
 */
export const DEFAULT_LIMIT = 120;
export const AUTH_LIMIT = 10;
export const CATALOG_LIMIT = 60;
export const SEARCH_LIMIT = 90;
export const DISPATCH_LIMIT = 600;
export const WINDOW_MS = 60_000;

/** ¿Este proceso debe contar peticiones? Ver nota 3 arriba. */
export function throttlingEnabled(): boolean {
  return env.NODE_ENV !== 'test' || process.env.THROTTLE_ENFORCE === '1';
}

@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = await super.getTracker(req);
    const ctx = (req as unknown as AuthedRequest).ctx;
    return ctx?.tenant?.tenantId ? `${ip}:${ctx.tenant.tenantId}` : ip;
  }

  /**
   * `método + ruta + límite` en vez del nombre del handler.
   *
   * Se hashea para no guardar el id del negocio en claro en la tabla de contadores; el guard base
   * usa la cadena tal cual como clave.
   */
  protected override generateKey(context: ExecutionContext, tracker: string, name: string): string {
    const req = context.switchToHttp().getRequest<Request>();
    const route = `${req.method}:${req.baseUrl}${req.path}`;
    return createHash('sha256').update(`${name}:${route}:${tracker}`).digest('hex');
  }
}
