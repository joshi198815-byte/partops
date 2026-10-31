import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/context.js';
import { env } from '../config/env.js';
import { AuthService } from './auth.service.js';

/**
 * Puente entre Express y el handler de Better Auth.
 *
 * Por qué no `app.use(toNodeHandler(auth))`: Nest registra el parser de body antes de montar
 * middleware manual, así que el stream ya llegó consumido y Better Auth recibiría cuerpos vacíos
 * (login roto de forma intermitente y difícil de diagnosticar). Aquí el body ya está parseado, se
 * vuelve a serializar y se entrega como `Request` de Fetch, que es lo que el handler espera. Las
 * rutas de Better Auth son todas JSON, así que no se pierde ningún formato.
 *
 * Los `Set-Cookie` se copian uno por uno: `res.setHeader` con el arreglo completo funciona, pero
 * `append` deja la semántica explícita y evita que un header de sesión se coma al de CSRF.
 */
@Controller('auth')
@Public()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @All('*path')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const url = new URL(req.originalUrl, env.API_PUBLIC_URL);
    const method = req.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD' && req.body && Object.keys(req.body).length > 0;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      // `host` y `content-length` los recalcula Fetch; copiarlos genera cabeceras incoherentes.
      if (key === 'host' || key === 'content-length') continue;
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else headers.set(key, value);
    }
    // El cliente real, no el proxy: Better Auth lo usa para rate limit y para la bitácora de sesión.
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ?? req.ip;
    if (ip) headers.set('x-forwarded-for', ip);
    if (hasBody) headers.set('content-type', 'application/json');

    const response = await this.auth.auth.handler(
      new Request(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(req.body) : undefined,
      }),
    );

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key === 'set-cookie') return;
      res.setHeader(key, value);
    });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) res.setHeader('set-cookie', cookies);

    // 204 y 304 no llevan cuerpo: escribirlo produce un error de Express en producción.
    if (response.status === 204 || response.status === 304) {
      res.end();
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  }
}
