import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../infra/database.module.js';
import { API_CONTROLLERS } from './health.module.js';

/**
 * Readiness con el SHA del despliegue.
 *
 * Lo que se prueba es el contrato del pipeline: `commit` tiene que reflejar lo que el proveedor
 * inyectó, y el estado tiene que seguir siendo 503 cuando la base está bien pero la RLS no está
 * forzada. Un `/ready` que devuelve 200 con `rlsEnforced: false` deja pasar el despliegue que más
 * caro sale: el que sirve datos de un negocio a otro.
 */
describe('GET /health/ready', () => {
  let app: INestApplication;
  let origin: string;
  const ping = { ok: true, rls: true, latencyMs: 1 };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: API_CONTROLLERS,
      providers: [{ provide: DatabaseService, useValue: { ping: async () => ping } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    delete process.env.RENDER_GIT_COMMIT;
    delete process.env.GIT_COMMIT;
    delete process.env.GITHUB_SHA;
    await app.close();
  });

  it('devuelve el commit que inyecta el proveedor', async () => {
    process.env.RENDER_GIT_COMMIT = 'abc1234';
    const res = await fetch(`${origin}/api/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, commit: 'abc1234', database: true, rlsEnforced: true });
  });

  it('commit es null cuando no hay despliegue detrás', async () => {
    const body = (await (await fetch(`${origin}/api/health/ready`)).json()) as Record<string, unknown>;
    expect(body.commit).toBeNull();
  });

  it('sigue devolviendo 503 si la RLS no está forzada', async () => {
    ping.rls = false;
    const res = await fetch(`${origin}/api/health/ready`);
    ping.rls = true;
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).rlsEnforced).toBe(false);
  });

  it('devuelve 503 y no miente sobre la base cuando la consulta falla', async () => {
    const original = ping.ok;
    ping.ok = false;
    const res = await fetch(`${origin}/api/health/ready`);
    ping.ok = original;
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).database).toBe(false);
  });
});
