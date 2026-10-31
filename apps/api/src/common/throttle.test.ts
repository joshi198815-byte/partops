import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiThrottlerGuard, AUTH_LIMIT, DISPATCH_LIMIT, throttlingEnabled, WINDOW_MS } from './throttle.js';

/**
 * El contador, a través del cable.
 *
 * Se prueba con controladores de mentira en vez de la app completa: montar Better Auth para contar
 * peticiones esconde justo lo que hay que ver —que la clave separa ruta, IP y negocio— detrás de
 * doscientas líneas de sesión y cookies.
 */
@Controller('auth')
@Throttle({ default: { limit: AUTH_LIMIT, ttl: WINDOW_MS } })
class FakeAuthController {
  @Post('sign-in/email')
  signIn() {
    return { ok: true };
  }

  @Post('sign-out')
  signOut() {
    return { ok: true };
  }
}

@Controller('dispatch')
@Throttle({ default: { limit: DISPATCH_LIMIT, ttl: WINDOW_MS } })
class FakeDispatchController {
  @Get('queue')
  queue() {
    return { ok: true };
  }
}

describe('límites por ruta', () => {
  let app: INestApplication;
  let origin: string;

  beforeAll(async () => {
    // `NODE_ENV` es `test` en vitest, así que sin esto el contador estaría apagado por diseño.
    process.env.THROTTLE_ENFORCE = '1';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: WINDOW_MS, limit: 120 }],
          skipIf: () => !throttlingEnabled(),
        }),
      ],
      controllers: [FakeAuthController, FakeDispatchController],
      providers: [{ provide: APP_GUARD, useClass: ApiThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // `req.ctx` lo pone `AuthGuard` en la app real; aquí se simula para probar la partición por
    // negocio sin arrastrar toda la autenticación.
    app.use((req: Request & { ctx?: unknown }, _res: Response, next: NextFunction) => {
      const tenant = req.headers['x-tenant-id'];
      if (typeof tenant === 'string') req.ctx = { tenant: { tenantId: tenant } };
      next();
    });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    delete process.env.THROTTLE_ENFORCE;
    await app.close();
  });

  const hit = (path: string, headers: Record<string, string> = {}, method = 'POST') =>
    fetch(`${origin}${path}`, { method, headers });

  it('el intento 11 de login desde la misma IP recibe 429', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i += 1) {
      statuses.push((await hit('/auth/sign-in/email')).status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
  });

  it('otra ruta del mismo controlador no hereda el castigo del login', async () => {
    // Si la clave fuera solo «controlador + IP», este request ya estaría bloqueado por el test
    // anterior.
    expect((await hit('/auth/sign-out')).status).toBe(201);
  });

  it('50 sincronizaciones de despacho no se acercan al límite', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      statuses.push((await hit('/dispatch/queue', {}, 'GET')).status);
    }
    expect(statuses).not.toContain(429);
  });

  it('dos negocios desde la misma IP no comparten presupuesto', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT; i += 1) {
      statuses.push((await hit('/auth/sign-in/email', { 'x-tenant-id': 'negocio-a' })).status);
    }
    // Un negocio distinto detrás de la misma IP arranca con el contador a cero.
    expect(statuses).not.toContain(429);
    expect((await hit('/auth/sign-in/email', { 'x-tenant-id': 'negocio-b' })).status).toBe(201);
  });
});
