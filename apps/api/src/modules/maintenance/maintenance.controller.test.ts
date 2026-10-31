import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env.js';
import { MaintenanceService } from '../../infra/maintenance.service.js';
import { MaintenanceController } from './maintenance.controller.js';

/**
 * El disparo externo del cron.
 *
 * Lo que se prueba no es que el trabajo corra —eso es `MaintenanceService`— sino la puerta: sin
 * secreto no hay ruta, con secreto equivocado hay 401, y con el correcto se acepta sin esperar.
 * Un 404 en vez de 401 cuando no hay secreto es deliberado y merece una prueba: es la diferencia
 * entre "esta instalación no tiene cron" y "esta instalación tiene un cron que cualquiera puede
 * disparar".
 */
describe('POST /maintenance/run', () => {
  let app: INestApplication;
  let origin: string;
  const tick = vi.fn(async () => ({ ran: true }));
  const original = env.CRON_SECRET;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MaintenanceController],
      providers: [{ provide: MaintenanceService, useValue: { tick } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    origin = `http://127.0.0.1:${address.port}`;
    tick.mockClear();
  });

  afterEach(async () => {
    env.CRON_SECRET = original;
    await app.close();
  });

  const call = (headers: Record<string, string> = {}) =>
    fetch(`${origin}/api/maintenance/run`, { method: 'POST', headers });

  it('sin CRON_SECRET configurado responde 404, no 401', async () => {
    env.CRON_SECRET = undefined;
    expect((await call()).status).toBe(404);
    expect(tick).not.toHaveBeenCalled();
  });

  it('un secreto vacío también responde 404 (variable presente pero sin valor)', async () => {
    env.CRON_SECRET = '   ';
    expect((await call({ 'x-cron-secret': '   ' })).status).toBe(404);
  });

  it('con secreto equivocado responde 401 y no ejecuta nada', async () => {
    env.CRON_SECRET = 'secreto-de-produccion-con-largo-suficiente';
    expect((await call({ 'x-cron-secret': 'otra-cosa' })).status).toBe(401);
    expect((await call()).status).toBe(401);
    expect(tick).not.toHaveBeenCalled();
  });

  it('con el secreto correcto responde 202 y dispara el tick una vez', async () => {
    env.CRON_SECRET = 'secreto-de-produccion-con-largo-suficiente';
    const res = await call({ 'x-cron-secret': 'secreto-de-produccion-con-largo-suficiente' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('no espera al trabajo: responde aunque el tick tarde', async () => {
    env.CRON_SECRET = 'secreto-de-produccion-con-largo-suficiente';
    let finished = false;
    tick.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            finished = true;
            resolve({ ran: true });
          }, 300);
        }) as never,
    );
    const started = Date.now();
    const res = await call({ 'x-cron-secret': 'secreto-de-produccion-con-largo-suficiente' });
    expect(res.status).toBe(202);
    // El cron no debe colgarse esperando un rollup: 202 es la promesa, no el resultado.
    expect(Date.now() - started).toBeLessThan(250);
    expect(finished).toBe(false);
  });

  it('un fallo del tick no rompe la respuesta ya enviada', async () => {
    env.CRON_SECRET = 'secreto-de-produccion-con-largo-suficiente';
    tick.mockImplementationOnce((() => Promise.reject(new Error('base caída'))) as never);
    const res = await call({ 'x-cron-secret': 'secreto-de-produccion-con-largo-suficiente' });
    expect(res.status).toBe(202);
    // Sin `catch`, el rechazo sería un `unhandledRejection` y en Node 22 eso tumba el proceso.
    await new Promise((r) => setTimeout(r, 50));
  });
});
