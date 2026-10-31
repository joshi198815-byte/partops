import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';

/**
 * El panel de plataforma en el cable, no en el servicio.
 *
 * Tres cosas solo se rompen aquí: el guard global tiene que resolver `@PlatformAdmin()` **antes** de
 * pedir negocio, `ctx.user` tiene que llevar el rol de plataforma (si no, nadie pasaría nunca), y un
 * cliente tiene que recibir 404 y no 403.
 *
 * El último caso es el que importa de verdad: un 403 confirma que la ruta existe y que hay algo
 * detrás. Un 404 deja al que prueba rutas sin saber si acertó.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

describe.skipIf(skip)('HTTP: panel de plataforma', () => {
  let app: INestApplication;
  let origin: string;
  let owner: Client;
  const createdTenants: string[] = [];
  const createdUsers: string[] = [];

  class Session {
    private cookie = '';

    constructor(private readonly base: string) {}

    async call(method: string, path: string, body?: unknown) {
      const res = await fetch(`${this.base}/api${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          origin: this.base,
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.getSetCookie();
      if (setCookie.length) {
        const jar = new Map<string, string>();
        for (const raw of this.cookie.split('; ').filter(Boolean)) {
          const [name, ...rest] = raw.split('=');
          jar.set(name!, rest.join('='));
        }
        for (const raw of setCookie) {
          const [pair] = raw.split(';');
          const [name, ...rest] = pair!.split('=');
          jar.set(name!, rest.join('='));
        }
        this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    origin = `http://127.0.0.1:${address.port}`;
    process.env.API_PUBLIC_URL = origin;
    process.env.BETTER_AUTH_URL = origin;

    owner = new Client({ connectionString: process.env.DIRECT_DATABASE_URL ?? DATABASE_URL });
    await owner.connect();
  });

  afterAll(async () => {
    if (createdTenants.length) {
      for (const table of ['push_token', 'audit_log', 'plan_grant', 'member', 'role', 'warehouse']) {
        await owner.query(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1)`, [createdTenants]);
      }
      await owner.query('DELETE FROM "tenant" WHERE "id" = ANY($1)', [createdTenants]);
    }
    if (createdUsers.length) {
      await owner.query('DELETE FROM "user" WHERE "id" = ANY($1)', [createdUsers]);
    }
    await owner.end();
    await app.close();
  });

  async function signUp() {
    const session = new Session(origin);
    const email = `plat-e2e-${randomUUID().slice(0, 8)}@partops.test`;
    const res = await session.call('POST', '/auth/sign-up/email', {
      name: 'Prueba Plataforma',
      email,
      password: 'TanqueFuerte2026',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    createdUsers.push(res.body.user.id);
    return { session, userId: res.body.user.id as string, email };
  }

  /** Negocio completo: sin membresía el guard no tendría cómo resolver el tenant. */
  async function withBusiness() {
    const base = await signUp();
    const tenant = await base.session.call('POST', '/onboarding/negocio', { name: 'Bodega Plataforma' });
    createdTenants.push(tenant.body.id);
    await base.session.call('POST', '/onboarding/bodega', { name: 'Central' });
    await base.session.call('POST', '/onboarding/impuestos', {
      pricesIncludeTax: true,
      taxRateBps: 1200,
    });
    await base.session.call('POST', '/onboarding/equipo', { invites: [] });
    return { ...base, tenantId: tenant.body.id as string };
  }

  it('un negocio normal recibe 404, no 403', async () => {
    const { session } = await withBusiness();
    const res = await session.call('GET', '/platform/overview');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('No encontrado');
  });

  it('sin sesión responde 401', async () => {
    expect((await new Session(origin).call('GET', '/platform/overview')).status).toBe(401);
  });

  it('el dueño de PartOps entra aunque no tenga negocio', async () => {
    // El caso que se rompía: el guard pedía negocio antes de mirar el rol, así que un admin sin
    // membresía recibía «termina de configurar tu negocio» en vez del panel.
    const { session, userId } = await signUp();
    await owner.query(`UPDATE "user" SET "role" = 'admin' WHERE "id" = $1`, [userId]);

    const res = await session.call('GET', '/platform/overview');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.tenants)).toBe(true);
    expect(res.body.demand).toBeDefined();
  });

  it('suspender desde el panel corta el acceso del negocio en la siguiente petición', async () => {
    const business = await withBusiness();
    const { session, userId } = await signUp();
    await owner.query(`UPDATE "user" SET "role" = 'admin' WHERE "id" = $1`, [userId]);

    expect((await session.call('POST', `/platform/tenants/${business.tenantId}/suspend`)).status).toBe(200);

    // El dueño suspendido ya no puede operar: la caché de permisos se invalidó al suspender.
    const after = await business.session.call('GET', '/catalog/overview');
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('TENANT_SUSPENDED');

    await session.call('POST', `/platform/tenants/${business.tenantId}/resume`);
    expect((await business.session.call('GET', '/catalog/overview')).status).toBe(200);
  });

  it('conceder un plan deja al negocio con su nivel en el resumen', async () => {
    const business = await withBusiness();
    const { session, userId } = await signUp();
    await owner.query(`UPDATE "user" SET "role" = 'admin' WHERE "id" = $1`, [userId]);

    const granted = await session.call('POST', `/platform/tenants/${business.tenantId}/plan`, {
      tier: 'TALLER',
      expiresAt: null,
      note: 'Cortesía de lanzamiento',
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);

    const overview = await session.call('GET', '/platform/overview');
    const row = overview.body.tenants.find((t: { id: string }) => t.id === business.tenantId);
    expect(row.planTier).toBe('TALLER');
    expect(row.planExpiresAt).toBeNull();
  });
});
