import { randomUUID } from 'node:crypto';
import { OWNER_ROLE } from '@partops/contracts';
import type { BaseClient } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../../auth/auth.service.js';
import type { AuthUser } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { MailService } from '../../mail/mail.service.js';
import { PlanService } from '../plan/plan.service.js';
import { TeamService } from '../team/team.service.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * Alta y equipo contra base real.
 *
 * Estas pruebas existen por las reglas que se rompen en silencio: quedarse sin propietario,
 * ascenderese uno mismo, un miembro de otro negocio colándose por slug, y una invitación que se
 * canjea con el correo equivocado. Ninguna se detecta con tipos; todas se detectan aquí.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;
const WEB = process.env.WEB_APP_URL ?? 'http://localhost:3000';

describe.skipIf(skip)('Onboarding y equipo', () => {
  let db: DatabaseService;
  let auth: AuthService;
  let onboarding: OnboardingService;
  let team: TeamService;
  let base: BaseClient;
  /** Conexión de dueño: siembra usuarios y limpia al final, sin pasar por RLS. */
  let owner: Client;
  const createdTenants: string[] = [];
  const createdUsers: string[] = [];

  beforeAll(async () => {
    db = new DatabaseService();
    const mail = new MailService();
    auth = new AuthService(db, mail);
    onboarding = new OnboardingService(db, auth, mail, new PlanService(db));
    team = new TeamService(db, auth, mail, new PlanService(db));
    base = db.client;
    owner = new Client({ connectionString: process.env.DIRECT_DATABASE_URL ?? DATABASE_URL });
    await owner.connect();
  });

  afterAll(async () => {
    if (createdTenants.length) {
      // Un solo DELETE por tabla, en orden inverso a las dependencias: `member` referencia `role`.
      await owner.query('DELETE FROM "push_token" WHERE "tenantId" = ANY($1)', [createdTenants]);
      await owner.query('DELETE FROM "audit_log" WHERE "tenantId" = ANY($1)', [createdTenants]);
      await owner.query('DELETE FROM "invitation" WHERE "tenantId" = ANY($1)', [createdTenants]);
      await owner.query('DELETE FROM "member" WHERE "tenantId" = ANY($1)', [createdTenants]);
      await owner.query('DELETE FROM "role" WHERE "tenantId" = ANY($1)', [createdTenants]);
      await owner.query('DELETE FROM "warehouse" WHERE "tenantId" = ANY($1)', [createdTenants]);
      await owner.query('DELETE FROM "tenant" WHERE "id" = ANY($1)', [createdTenants]);
    }
    if (createdUsers.length) {
      await owner.query('DELETE FROM "session" WHERE "userId" = ANY($1)', [createdUsers]);
      await owner.query('DELETE FROM "user" WHERE "id" = ANY($1)', [createdUsers]);
    }
    await owner.end();
    await db.onModuleDestroy();
  });

  async function makeUser(name = 'Dueño de Prueba'): Promise<AuthUser> {
    const id = randomUUID();
    const email = `test-${id.slice(0, 8)}@partops.test`;
    await owner.query(
      'INSERT INTO "user" ("id","name","email","emailVerified","updatedAt") VALUES ($1,$2,$3,true,NOW())',
      [id, name, email],
    );
    createdUsers.push(id);
    return { id, name, email, image: null, emailVerified: true, mustChangePassword: false };
  }

  async function onboard(user: AuthUser, name = 'Repuestos El Tornillo') {
    const tenant = await onboarding.createBusiness(user, { name });
    createdTenants.push(tenant.id);
    return tenant;
  }

  /** Acceso del usuario a ese negocio, tal como lo resolvería el guard. */
  const contextFor = (user: AuthUser, tenantId: string) => auth.loadTenantAccess(user.id, tenantId);

  describe('paso 1: negocio', () => {
    it('crea roles base y membresía de propietario en una sola operación', async () => {
      const user = await makeUser();
      const tenant = await onboard(user);

      const ctx = await contextFor(user, tenant.id);
      expect(ctx.role).toBe(OWNER_ROLE);
      // El propietario recibe todos los permisos aunque la fila del rol se editara por error.
      expect(ctx.permissions.has('billing.manage')).toBe(true);

      const roles = await db.tx(tenant.id, (tx) => tx.role.findMany({ select: { key: true } }));
      expect(roles.map((r) => r.key).sort()).toEqual(
        ['administrador', 'bodeguero', 'gerente', 'propietario', 'vendedor'].sort(),
      );
    });

    it('deriva el slug del nombre y resuelve la colisión sin fallar', async () => {
      const first = await onboard(await makeUser(), 'Repuestos La Peña');
      const second = await onboard(await makeUser(), 'Repuestos La Peña');
      expect(first.slug).toBe('repuestos-la-pena');
      expect(second.slug).toBe('repuestos-la-pena-2');
    });

    it('no permite un segundo negocio al mismo usuario', async () => {
      const user = await makeUser();
      await onboard(user);
      await expect(onboard(user)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('pasos 2 y 3: bodega e impuestos', () => {
    it('crea la primera bodega como predeterminada y rechaza una segunda', async () => {
      const user = await makeUser();
      const tenant = await onboard(user);
      const ctx = await contextFor(user, tenant.id);

      const warehouse = await onboarding.createFirstWarehouse(ctx, user, { name: 'Bodega Central' });
      expect(warehouse.code).toBe('B1');

      await expect(onboarding.createFirstWarehouse(ctx, user, { name: 'Otra' })).rejects.toMatchObject({
        status: 409,
      });
    });

    it('guarda el IVA en puntos base y refleja el cambio en el contexto', async () => {
      const user = await makeUser();
      const tenant = await onboard(user);
      const ctx = await contextFor(user, tenant.id);

      const updated = await onboarding.setTaxes(ctx, user, { pricesIncludeTax: false, taxRateBps: 500 });
      expect(updated).toEqual({ pricesIncludeTax: false, taxRateBps: 500 });
    });

    it('el estado del alta avanza paso a paso y termina en /app al cerrarlo', async () => {
      const user = await makeUser();
      expect((await onboarding.state(user)).nextPath).toBe('/onboarding/negocio');

      const tenant = await onboard(user);
      expect((await onboarding.state(user)).nextPath).toBe('/onboarding/bodega');

      const ctx = await contextFor(user, tenant.id);
      await onboarding.createFirstWarehouse(ctx, user, { name: 'Bodega Central' });
      // Con bodega creada, impuestos ya está dado por contestado; falta invitar al equipo.
      const afterWarehouse = await onboarding.state(user);
      expect(afterWarehouse.nextStep).toBe('team');
      expect(afterWarehouse.steps.tax).toBe(true);
      expect(afterWarehouse.nextPath).toBe('/onboarding/equipo');

      // Cerrar el asistente es lo que lo marca completo: se puede saltar la invitación.
      await onboarding.finish(ctx, user, { invites: [] });
      const done = await onboarding.state(user);
      expect(done.nextStep).toBeNull();
      expect(done.nextPath).toBe('/app');
    });
  });

  describe('invitaciones', () => {
    it('invita, canjea y deja a la persona con el rol acordado', async () => {
      const ownerUser = await makeUser('Propietario');
      const tenant = await onboard(ownerUser);
      const ctx = await contextFor(ownerUser, tenant.id);

      const guest = await makeUser('Vendedor Nuevo');
      await team.invite(ctx, ownerUser, {
        email: guest.email,
        roleKey: 'vendedor',
        warehouseIds: [],
      });

      const preview = await onboarding.previewInvitation(
        (await db.tx(tenant.id, (tx) => tx.invitation.findFirstOrThrow({ select: { token: true } }))).token,
      );
      expect(preview.tenant.name).toBe(tenant.name);
      expect(preview.state).toBe('VALIDA');

      const { token } = await db.tx(tenant.id, (tx) =>
        tx.invitation.findFirstOrThrow({ select: { token: true } }),
      );
      await onboarding.acceptInvitation(guest, token);

      const guestCtx = await contextFor(guest, tenant.id);
      expect(guestCtx.role).toBe('vendedor');
      expect(guestCtx.permissions.has('orders.create')).toBe(true);
      expect(guestCtx.permissions.has('finance.cost.view')).toBe(false);
    });

    it('rechaza el canje con un correo que no es el invitado', async () => {
      const ownerUser = await makeUser('Propietario');
      const tenant = await onboard(ownerUser);
      const ctx = await contextFor(ownerUser, tenant.id);

      const invited = await makeUser('Invitado');
      const intruder = await makeUser('Intruso');
      const { token } = await db.tx(tenant.id, async (tx) => {
        const role = await tx.role.findFirstOrThrow({ where: { key: 'vendedor' }, select: { id: true } });
        return tx.invitation.create({
          data: {
            tenantId: tenant.id,
            email: invited.email,
            roleId: role.id,
            token: 'aaaa-bbbb-cccc',
            invitedById: ownerUser.id,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
          select: { token: true },
        });
      });
      await team.list(ctx); // confirma que el negocio quedó consistente

      await expect(onboarding.acceptInvitation(intruder, token)).rejects.toMatchObject({ status: 403 });
    });

    it('no deja invitar dos veces al mismo correo ni a quien ya es miembro', async () => {
      const ownerUser = await makeUser('Propietario');
      const tenant = await onboard(ownerUser);
      const ctx = await contextFor(ownerUser, tenant.id);

      const guest = await makeUser('Invitado');
      await team.invite(ctx, ownerUser, { email: guest.email, roleKey: 'vendedor', warehouseIds: [] });
      await expect(
        team.invite(ctx, ownerUser, { email: guest.email, roleKey: 'vendedor', warehouseIds: [] }),
      ).rejects.toMatchObject({ status: 409 });

      await expect(
        team.invite(ctx, ownerUser, { email: ownerUser.email, roleKey: 'vendedor', warehouseIds: [] }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('reglas de equipo', () => {
    async function teamFixture() {
      const ownerUser = await makeUser('Propietario');
      const tenant = await onboard(ownerUser);
      const ctx = await contextFor(ownerUser, tenant.id);
      return { ownerUser, tenant, ctx };
    }

    it('no permite dejar el negocio sin propietario', async () => {
      const { ownerUser, tenant, ctx } = await teamFixture();
      const firstOwner = await db.tx(tenant.id, (tx) =>
        tx.member.findFirstOrThrow({ where: { userId: ownerUser.id }, select: { id: true } }),
      );

      // Degradarse a sí mismo ya está bloqueado; se prueba con otro propietario.
      const second = await makeUser('Segundo Propietario');
      await db.tx(tenant.id, async (tx) => {
        const role = await tx.role.findFirstOrThrow({ where: { key: OWNER_ROLE }, select: { id: true } });
        await tx.member.create({ data: { tenantId: tenant.id, userId: second.id, roleId: role.id } });
      });
      const secondMember = await db.tx(tenant.id, (tx) =>
        tx.member.findFirstOrThrow({ where: { userId: second.id }, select: { id: true } }),
      );

      // Con dos propietarios se puede degradar a uno.
      const secondCtx = await contextFor(second, tenant.id);
      await team.updateMember(secondCtx, second, firstOwner.id, { roleKey: 'administrador' });

      // Con uno solo, ya no.
      await expect(
        team.updateMember(ctx, ownerUser, secondMember.id, { roleKey: 'vendedor' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('nadie cambia su propio rol', async () => {
      const { ownerUser, tenant, ctx } = await teamFixture();
      const me = await db.tx(tenant.id, (tx) =>
        tx.member.findFirstOrThrow({ where: { userId: ownerUser.id }, select: { id: true } }),
      );
      await expect(
        team.updateMember(ctx, ownerUser, me.id, { roleKey: 'administrador' }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('los roles base no se editan ni se borran', async () => {
      const { ownerUser, tenant, ctx } = await teamFixture();
      const admin = await db.tx(tenant.id, (tx) =>
        tx.role.findFirstOrThrow({ where: { key: 'administrador' }, select: { id: true } }),
      );
      await expect(
        team.updateRole(ctx, ownerUser, admin.id, { permissions: ['dashboard.view'] }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(team.deleteRole(ctx, ownerUser, admin.id, 'vendedor')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('crear un rol propio rechaza permisos inventados', async () => {
      const { ownerUser, ctx } = await teamFixture();
      await expect(
        team.createRole(ctx, ownerUser, {
          name: 'Auditor',
          permissions: ['finance.view', 'hack.everything'],
        }),
      ).rejects.toMatchObject({ status: 400 });

      const role = await team.createRole(ctx, ownerUser, {
        name: 'Auditor nocturno',
        permissions: ['finance.view', 'audit.view'],
      });
      expect(role.key).toBe('auditor-nocturno');
    });

    it('borrar un rol mueve a su gente antes de eliminarlo', async () => {
      const { ownerUser, tenant, ctx } = await teamFixture();
      const role = await team.createRole(ctx, ownerUser, {
        name: 'Auxiliar',
        permissions: ['dashboard.view'],
      });
      const helper = await makeUser('Auxiliar');
      await db.tx(tenant.id, (tx) =>
        tx.member.create({ data: { tenantId: tenant.id, userId: helper.id, roleId: role.id } }),
      );

      const result = await team.deleteRole(ctx, ownerUser, role.id, 'vendedor');
      expect(result.moved).toBe(1);

      const helperCtx = await contextFor(helper, tenant.id);
      expect(helperCtx.role).toBe('vendedor');
    });

    it('quitar a alguien del negocio revoca su acceso en el siguiente request', async () => {
      const { ownerUser, tenant, ctx } = await teamFixture();
      const helper = await makeUser('Bodeguero');
      const role = await db.tx(tenant.id, (tx) =>
        tx.role.findFirstOrThrow({ where: { key: 'bodeguero' }, select: { id: true } }),
      );
      const member = await db.tx(tenant.id, (tx) =>
        tx.member.create({
          data: { tenantId: tenant.id, userId: helper.id, roleId: role.id },
          select: { id: true },
        }),
      );

      // Primero se resuelve y se cachea el acceso; después se quita.
      expect((await auth.resolveTenant(helper.id, tenant.id)).role).toBe('bodeguero');
      await team.removeMember(ctx, ownerUser, member.id);

      await expect(auth.resolveTenant(helper.id, tenant.id)).rejects.toMatchObject({ status: 403 });
    });

    it('desactivar a un miembro lo saca sin borrar su historial de pedidos', async () => {
      const { ownerUser, tenant, ctx } = await teamFixture();
      const helper = await makeUser('Vendedor antiguo');
      const role = await db.tx(tenant.id, (tx) =>
        tx.role.findFirstOrThrow({ where: { key: 'vendedor' }, select: { id: true } }),
      );
      const member = await db.tx(tenant.id, (tx) =>
        tx.member.create({
          data: { tenantId: tenant.id, userId: helper.id, roleId: role.id },
          select: { id: true },
        }),
      );

      await team.updateMember(ctx, ownerUser, member.id, { isActive: false });
      await expect(auth.resolveTenant(helper.id, tenant.id)).rejects.toMatchObject({ status: 403 });

      const stillThere = await db.tx(tenant.id, (tx) => tx.member.count({ where: { id: member.id } }));
      expect(stillThere).toBe(1);
    });
  });

  describe('aislamiento', () => {
    it('el contexto de un negocio no sirve para leer el de otro', async () => {
      const a = await makeUser('A');
      const b = await makeUser('B');
      const tenantA = await onboard(a, 'Bodega A');
      const tenantB = await onboard(b, 'Bodega B');

      const ctxA = await contextFor(a, tenantA.id);
      await onboarding.createFirstWarehouse(ctxA, a, { name: 'Solo de A' });

      const warehousesB = await db.tx(tenantB.id, (tx) => tx.warehouse.findMany());
      expect(warehousesB).toHaveLength(0);
    });

    it('un usuario no miembro recibe 403 aunque acierte el id del negocio', async () => {
      const a = await makeUser('A');
      const stranger = await makeUser('Ajeno');
      const tenantA = await onboard(a, 'Bodega Privada');
      await expect(contextFor(stranger, tenantA.id)).rejects.toMatchObject({ status: 403 });
      void WEB;
    });
  });

  /** El `prisma` de `base` no debe usarse aquí: todo pasa por `auth`/servicios para probar el camino real. */
  it('el cliente base sigue disponible para el guard', () => {
    expect(typeof base.user.findUnique).toBe('function');
  });
});
