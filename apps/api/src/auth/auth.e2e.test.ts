import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { DatabaseService } from '../infra/database.module.js';
import { AuthService } from './auth.service.js';

/**
 * Recorrido HTTP completo: registro, onboarding de cuatro pasos, equipo y RBAC.
 *
 * Se prueba contra la app de verdad —guards, pipes, cookies y su serialización— y no contra los
 * servicios. Varias de las fallas que esto atrapa solo existen en el cableado: un guard global que
 * no ve la sesión, un `Set-Cookie` que se pierde al pasar por el puente de Better Auth, un
 * decorador que no llega a metadata. Ninguna aparece en una prueba de servicio.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

describe.skipIf(skip)('HTTP: sesión, onboarding, equipo y RBAC', () => {
  let app: INestApplication;
  let origin: string;
  let db: DatabaseService;
  let owner: Client;
  const createdTenants: string[] = [];

  /** Cliente con su propio tarro de cookies: cada usuario es una sesión independiente. */
  class Session {
    private cookie = '';

    constructor(private readonly base: string) {}

    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(`${this.base}/api${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          // Better Auth rechaza con 403 las peticiones sin `Origin`: es su defensa CSRF. El navegador
          // lo manda solo, y la app Android lo manda como `capacitor://localhost`; aquí se simula.
          origin: this.base,
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.getSetCookie();
      if (setCookie.length) {
        // Se acumula cada cookie nueva; el tarro ignora expiraciones porque el test no las provoca.
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
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    app.setGlobalPrefix('api');
    // El controlador de auth arma la URL con `API_PUBLIC_URL`; en la prueba se sobreescribe para
    // que apunte al puerto efímero, y así no depende de que 4000 esté libre.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    origin = `http://127.0.0.1:${address.port}`;
    process.env.API_PUBLIC_URL = origin;
    process.env.BETTER_AUTH_URL = origin;

    db = app.get(DatabaseService);
    owner = new Client({ connectionString: process.env.DIRECT_DATABASE_URL ?? DATABASE_URL });
    await owner.connect();
  });

  afterAll(async () => {
    if (createdTenants.length) {
      for (const table of ['push_token', 'audit_log', 'invitation', 'member', 'role', 'warehouse']) {
        await owner.query(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1)`, [createdTenants]);
      }
      await owner.query('DELETE FROM "tenant" WHERE "id" = ANY($1)', [createdTenants]);
    }
    await owner.end();
    await app.close();
    void db;
  });

  /** Crea una cuenta nueva y devuelve sesión + correo, listos para operar. */
  async function signUp(name = 'Dueño Prueba') {
    const session = new Session(origin);
    const email = `e2e-${randomUUID().slice(0, 8)}@partops.test`;
    const res = await session.call('POST', '/auth/sign-up/email', {
      name,
      email,
      password: 'TanqueFuerte2026',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { session, email, userId: res.body.user.id as string };
  }

  async function onboarded(name = 'Repuestos La Tuerca') {
    const base = await signUp();
    const tenant = await base.session.call('POST', '/onboarding/negocio', { name });
    createdTenants.push(tenant.body.id);
    await base.session.call('POST', '/onboarding/bodega', { name: 'Bodega Central' });
    await base.session.call('POST', '/onboarding/impuestos', { pricesIncludeTax: true, taxRateBps: 1200 });
    await base.session.call('POST', '/onboarding/equipo', { invites: [] });
    return { ...base, tenantId: tenant.body.id as string };
  }

  it('sin sesión, todo lo privado responde 401 y la salud queda abierta', async () => {
    const anon = new Session(origin);
    expect((await anon.call('GET', '/me')).status).toBe(401);
    expect((await anon.call('GET', '/team')).status).toBe(401);
    // La salud no pide sesión: el balanceador no tiene cookies.
    expect((await anon.call('GET', '/health/live')).status).toBe(200);
  });

  it('el registro deja sesión utilizable y /me sin negocio', async () => {
    const { session, email } = await signUp('Ana López');
    const me = await session.call('GET', '/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.tenant).toBeNull();
    expect(me.body.onboarding.nextPath).toBe('/onboarding/negocio');
    expect(me.body.homePath).toBe('/onboarding/negocio');
  });

  it('recorre los cuatro pasos y termina con negocio activo', async () => {
    const { session } = await signUp();
    const created = await session.call('POST', '/onboarding/negocio', {
      name: 'Repuestos La Tuerca',
      phone: '5555-1234',
      taxId: '1234-5678',
    });
    createdTenants.push(created.body.id);
    expect(created.status).toBe(201);
    // El teléfono se guarda en E.164 y el NIT sin guiones: es lo que usan WhatsApp y la SAT.
    const tenant = await owner.query('SELECT "phone", "taxId", "slug" FROM "tenant" WHERE "id" = $1', [
      created.body.id,
    ]);
    expect(tenant.rows[0].phone).toBe('+50255551234');
    expect(tenant.rows[0].taxId).toBe('12345678');

    const afterBusiness = await session.call('GET', '/onboarding/state');
    expect(afterBusiness.body.nextPath).toBe('/onboarding/bodega');

    expect((await session.call('POST', '/onboarding/bodega', { name: 'Central' })).status).toBe(201);
    expect(
      (await session.call('POST', '/onboarding/impuestos', { pricesIncludeTax: true, taxRateBps: 1200 }))
        .status,
    ).toBe(201);

    const done = await session.call('POST', '/onboarding/equipo', {
      invites: [{ email: `inv-${randomUUID().slice(0, 8)}@partops.test`, roleKey: 'vendedor' }],
    });
    expect(done.body.invited).toHaveLength(1);
    expect(done.body.skipped).toHaveLength(0);

    const state = await session.call('GET', '/onboarding/state');
    expect(state.body.nextStep).toBeNull();
    expect(state.body.nextPath).toBe('/app');

    const me = await session.call('GET', '/me');
    expect(me.body.tenant.name).toBe('Repuestos La Tuerca');
    expect(me.body.tenant.role).toBe('propietario');
    expect(me.body.tenant.permissions).toContain('billing.manage');
    // El propietario tiene un solo negocio: el home es el tablero, no el selector.
    expect(me.body.homePath).toBe('/app');
  });

  it('el NIT inválido y el teléfono corto se rechazan con detalle por campo', async () => {
    const { session } = await signUp();
    const bad = await session.call('POST', '/onboarding/negocio', { name: 'X', phone: '123' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(bad.body.issues)).toContain('teléfono');
  });

  it('repetir el paso de bodega responde 409 en vez de crear una segunda', async () => {
    const { session, tenantId } = await onboarded();
    void tenantId;
    const again = await session.call('POST', '/onboarding/bodega', { name: 'Otra' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('WAREHOUSE_EXISTS');
  });

  it('un vendedor no entra a equipo; un propietario sí', async () => {
    const ownerSession = await onboarded('Bodega con Equipo');
    const guest = await signUp('Vendedor Nuevo');

    const invite = await ownerSession.session.call('POST', '/team/invitations', {
      email: guest.email,
      roleKey: 'vendedor',
      warehouseIds: [],
    });
    expect(invite.status).toBe(201);

    const { rows } = await owner.query('SELECT "token" FROM "invitation" WHERE "email" = $1', [guest.email]);
    const accepted = await guest.session.call('POST', '/invitations/accept', { token: rows[0].token });
    expect(accepted.status).toBe(200);

    // El vendedor ve su negocio y puede vender, pero no administra.
    const me = await guest.session.call('GET', '/me');
    expect(me.body.tenant.role).toBe('vendedor');
    expect(me.body.tenant.permissions).toContain('orders.create');
    expect(me.body.tenant.permissions).not.toContain('finance.cost.view');

    const forbidden = await guest.session.call('GET', '/team');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');
    expect(forbidden.body.missing).toEqual(['team.manage']);

    // Y el propietario sí lo ve, con la persona dentro.
    const team = await ownerSession.session.call('GET', '/team');
    expect(team.body.members.map((m: { email: string }) => m.email)).toContain(guest.email);
  });

  it('la vista previa de la invitación es pública y no filtra el rol', async () => {
    const ownerSession = await onboarded('Bodega Invitaciones');
    const guestEmail = `preview-${randomUUID().slice(0, 8)}@partops.test`;
    await ownerSession.session.call('POST', '/team/invitations', {
      email: guestEmail,
      roleKey: 'gerente',
      warehouseIds: [],
    });
    const { rows } = await owner.query('SELECT "token" FROM "invitation" WHERE "email" = $1', [guestEmail]);

    const anon = new Session(origin);
    const preview = await anon.call('GET', `/invitations/${rows[0].token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.email).toBe(guestEmail);
    expect(preview.body.state).toBe('VALIDA');
    expect(preview.body.tenant.name).toBe('Bodega Invitaciones');
    expect(JSON.stringify(preview.body)).not.toContain('gerente');
  });

  it('un token de invitación inexistente no revela nada', async () => {
    const anon = new Session(origin);
    const res = await anon.call('GET', '/invitations/aaaa-bbbb-cccc');
    expect(res.status).toBe(404);
  });

  it('configuración: el propietario cambia impuestos y nombre; el vendedor no la lee', async () => {
    const ownerSession = await onboarded('Bodega Config');
    const before = await ownerSession.session.call('GET', '/settings');
    expect(before.status).toBe(200);
    expect(before.body.taxRateBps).toBe(1200);

    const patched = await ownerSession.session.call('PATCH', '/settings', {
      taxRateBps: 500,
      name: 'Bodega Config Renombrada',
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.taxRateBps).toBe(500);
    expect(patched.body.name).toBe('Bodega Config Renombrada');

    // El slug no se puede tocar: es la dirección del catálogo y ya se compartió.
    const slugAttempt = await ownerSession.session.call('PATCH', '/settings', { slug: 'otra-cosa' });
    expect(slugAttempt.status).toBe(400);

    // Queda en la bitácora con solo los campos que cambiaron.
    const { rows } = await owner.query(
      `SELECT "action", "after" FROM "audit_log" WHERE "tenantId" = $1 AND "action" = 'tenant.settings_updated' ORDER BY "createdAt" DESC LIMIT 1`,
      [ownerSession.tenantId],
    );
    expect(rows[0].action).toBe('tenant.settings_updated');
    expect(rows[0].after).not.toHaveProperty('slug');

    const guest = await signUp('Vendedor Config');
    const invite = await ownerSession.session.call('POST', '/team/invitations', {
      email: guest.email,
      roleKey: 'vendedor',
      warehouseIds: [],
    });
    expect(invite.status).toBe(201);
    const token = await owner.query('SELECT "token" FROM "invitation" WHERE "email" = $1', [guest.email]);
    await guest.session.call('POST', '/invitations/accept', { token: token.rows[0].token });

    const forbidden = await guest.session.call('GET', '/settings');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.missing).toEqual(['settings.manage']);
  });

  it('el último propietario no puede degradarse y el negocio conserva dueño', async () => {
    const { session } = await onboarded('Bodega Única');
    const team = await session.call('GET', '/team');
    const me = team.body.members.find((m: { roleKey: string }) => m.roleKey === 'propietario');

    const res = await session.call('PATCH', `/team/members/${me.id}`, { roleKey: 'administrador' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  it('un miembro de otro negocio no puede leer con un x-tenant-id ajeno', async () => {
    const a = await onboarded('Bodega A');
    const b = await onboarded('Bodega B');

    const intruder = await b.session.call('GET', '/team', undefined, { 'x-tenant-id': a.tenantId });
    expect(intruder.status).toBe(403);
  });

  it('el cambio de negocio activo persiste en la sesión', async () => {
    // Mismo dueño en dos negocios: se une al segundo por invitación.
    const first = await onboarded('Bodega Original');
    const second = await onboarded('Bodega Segunda');

    const invite = await second.session.call('POST', '/team/invitations', {
      email: first.email,
      roleKey: 'administrador',
      warehouseIds: [],
    });
    expect(invite.status).toBe(201);
    const { rows } = await owner.query('SELECT "token" FROM "invitation" WHERE "email" = $1', [first.email]);
    await first.session.call('POST', '/invitations/accept', { token: rows[0].token });

    const me = await first.session.call('GET', '/me');
    expect(me.body.memberships).toHaveLength(2);

    const switched = await first.session.call('POST', '/me/tenant', { tenantId: second.tenantId });
    expect(switched.status).toBe(200);

    const after = await first.session.call('GET', '/me');
    expect(after.body.tenant.id).toBe(second.tenantId);
    expect(after.body.tenant.role).toBe('administrador');
  });

  it('el guard bloquea las rutas de administración de Better Auth con 404', async () => {
    const { session } = await onboarded();
    for (const path of ['/auth/admin/list-users', '/auth/delete-user']) {
      const res = await session.call('POST', path, {});
      expect(res.status, path).toBe(404);
    }
  });

  it('los roles base no se editan; los propios sí', async () => {
    const { session } = await onboarded();
    const team = await session.call('GET', '/team');
    const admin = team.body.roles.find((r: { key: string }) => r.key === 'administrador');

    const rejected = await session.call('PATCH', `/team/roles/${admin.id}`, {
      permissions: ['dashboard.view'],
    });
    expect(rejected.status).toBe(403);
    expect(rejected.body.code).toBe('SYSTEM_ROLE');

    const created = await session.call('POST', '/team/roles', {
      name: 'Auditor',
      permissions: ['finance.view', 'audit.view'],
    });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe('auditor');

    const renamed = await session.call('PATCH', `/team/roles/${created.body.id}`, {
      name: 'Auditor externo',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Auditor externo');
  });

  it('con contraseña temporal, todo queda bloqueado salvo las rutas marcadas', async () => {
    const { session, userId } = await signUp('Bodeguero Nuevo');
    await owner.query('UPDATE "user" SET "mustChangePassword" = true WHERE "id" = $1', [userId]);

    // `/me` sí responde: la web necesita saber que debe mandarlo a cambiar la clave.
    const me = await session.call('GET', '/me');
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(true);

    // Cualquier cosa de negocio, no.
    const blocked = await session.call('GET', '/onboarding/state');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // Al cambiarla, el flag se apaga solo y el acceso se abre.
    const changed = await session.call('POST', '/auth/change-password', {
      currentPassword: 'TanqueFuerte2026',
      newPassword: 'OtraClaveDistinta2026',
      revokeOtherSessions: false,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    const after = await session.call('GET', '/me');
    expect(after.body.user.mustChangePassword).toBe(false);
    expect((await session.call('GET', '/onboarding/state')).status).toBe(200);
  });

  it('un segundo negocio con el mismo nombre recibe slug distinto', async () => {
    const first = await onboarded('Repuestos El Tornillo');
    const second = await onboarded('Repuestos El Tornillo');
    expect(first.tenantId).not.toBe(second.tenantId);

    const slugs = await owner.query('SELECT "slug" FROM "tenant" WHERE "id" = ANY($1) ORDER BY "slug"', [
      [first.tenantId, second.tenantId],
    ]);
    expect(slugs.rows.map((r: { slug: string }) => r.slug)).toEqual([
      'repuestos-el-tornillo',
      'repuestos-el-tornillo-2',
    ]);
  });

  it('la búsqueda registra demanda y respeta el permiso de demanda', async () => {
    const { session, tenantId } = await onboarded('Bodega de Búsqueda');

    // Una búsqueda sin catálogo: cero resultados y queda registrada como demanda.
    const empty = await session.call('GET', '/search?q=capo%20corolla%202009');
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.hits).toEqual([]);
    expect(empty.body.parsed).toMatchObject({ brand: 'Toyota', model: 'Corolla', year: 2009 });

    const demand = await session.call('GET', '/search/demand');
    expect(demand.status).toBe(200);
    expect(demand.body).toHaveLength(1);
    expect(demand.body[0]).toMatchObject({ term: 'capo', missedCount: 1, brand: 'Toyota' });

    // El registro vive en la base, con el negocio correcto y no en otro.
    const stored = await owner.query(
      'SELECT "tenantId", "resultCount", "source" FROM "search_event" WHERE "tenantId" = $1',
      [tenantId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].resultCount).toBe(0);
    expect(stored.rows[0].source).toBe('MOSTRADOR');
  });

  it('sin permiso de demanda, la lista de faltantes queda cerrada pero la búsqueda no', async () => {
    const { session } = await onboarded('Bodega con Vendedor');
    const role = await session.call('POST', '/team/roles', {
      name: 'Solo mostrador',
      permissions: ['catalog.view'],
    });
    expect(role.status).toBe(201);

    /**
     * Se cambia el rol del propio propietario en la base para probar el guard con un permiso
     * recortado. No se puede invitar y aceptar una sesión nueva aquí sin correo real; lo que se
     * quiere verificar es la compuerta, no el flujo de invitación (que ya tiene su prueba).
     *
     * El contexto de permisos se cachea 30 s por usuario y negocio, así que hay que invalidarlo:
     * sin esto la prueba pasaría o fallaría según el orden de los casos, que es la peor clase de
     * test.
     */
    const tenantId = (await session.call('GET', '/me')).body.tenant.id as string;
    await owner.query('UPDATE "member" SET "roleId" = $1 WHERE "tenantId" = $2', [role.body.id, tenantId]);
    app.get(AuthService).invalidateTenant(tenantId);

    // `catalog.view` basta para buscar.
    expect((await session.call('GET', '/search?q=faro')).status).toBe(200);
    // Y no basta para ver la demanda incumplida.
    const denied = await session.call('GET', '/search/demand');
    expect(denied.status).toBe(403);
  });
});
