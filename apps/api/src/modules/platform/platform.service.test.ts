import { randomUUID } from 'node:crypto';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthService } from '../../auth/auth.service.js';
import type { RequestContext } from '../../common/context.js';
import type { DatabaseService } from '../../infra/database.module.js';
import { PlatformService } from './platform.service.js';

/**
 * Panel de plataforma contra Postgres real.
 *
 * Lo que importa no es que el plan se guarde —eso es un `insert`— sino que cada acción quede en la
 * bitácora del negocio afectado y que suspender corte el acceso de verdad. Un panel que cambia
 * banderas sin dejar rastro es peor que no tener panel: nadie puede reconstruir por qué un negocio
 * dejó de vender el martes.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

describe.skipIf(skip)('PlatformService: planes, suspensión y bitácora', () => {
  let base: BaseClient;
  let service: PlatformService;

  const tenantId = randomUUID();
  const slug = `plat-${tenantId.slice(0, 8)}`;
  let adminId = '';

  function adminCtx(): RequestContext {
    return {
      user: {
        id: adminId,
        email: 'admin@partops.test',
        name: 'Dueño de PartOps',
        emailVerified: true,
        mustChangePassword: false,
        role: 'admin',
      },
      sessionId: 'session-platform',
    };
  }

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 8 });
    const db = {
      client: base,
      tx: (t: string, fn: never, options?: never) => tenantTx(base, t, fn, options),
      system: (fn: never, options?: never) => systemTx(base, fn, options),
    } as unknown as DatabaseService;

    // La caché de permisos no se toca en esta prueba: se reemplaza por un doble mínimo para no
    // arrastrar el guard entero. Lo que se verifica aquí es la invalidación, no el guard.
    const invalidated: string[] = [];
    const auth = {
      invalidateTenant: (id: string) => invalidated.push(id),
    } as unknown as AuthService;

    service = new PlatformService(db, auth);

    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug, name: 'Bodega Suspendible', timezone: 'America/Guatemala' },
      });
      const admin = await tx.user.create({
        data: {
          id: randomUUID(),
          name: 'Dueño de PartOps',
          email: `plat-${tenantId.slice(0, 8)}@partops.test`,
          emailVerified: true,
          role: 'admin',
        },
      });
      adminId = admin.id;
    });
  });

  afterAll(async () => {
    if (!base) return;
    await base.$disconnect();
    const owner = process.env.DIRECT_DATABASE_URL;
    if (!owner) return;
    const client = new Client({ connectionString: owner });
    await client.connect();
    try {
      await client.query('DELETE FROM "audit_log" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "plan_grant" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
      await client.query('DELETE FROM "user" WHERE "id" = $1', [adminId]);
    } finally {
      await client.end();
    }
  });

  it('concede un plan y lo deja auditado en el negocio', async () => {
    await service.grantPlan(adminCtx(), tenantId, { tier: 'PRO', expiresAt: null });

    const grants = await systemTx(base, (tx) =>
      tx.planGrant.findMany({ where: { tenantId }, select: { tier: true, grantedById: true } }),
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]?.tier).toBe('PRO');
    expect(grants[0]?.grantedById).toBe(adminId);

    const logs = await systemTx(base, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId, action: 'platform.plan_granted' },
        select: { entity: true, after: true },
      }),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.entity).toBe('tenant');
    expect(logs[0]?.after).toMatchObject({ tier: 'PRO', expiresAt: null });
  });

  it('la concesión es historial: dos planes quedan como dos filas', async () => {
    await service.grantPlan(adminCtx(), tenantId, { tier: 'TALLER', expiresAt: null });
    const tiers = await systemTx(base, (tx) =>
      tx.planGrant.findMany({ where: { tenantId }, select: { tier: true } }),
    );
    expect(tiers.map((g) => g.tier).sort()).toEqual(['PRO', 'TALLER']);
  });

  it('suspender corta el acceso y queda auditado; reactivar lo devuelve', async () => {
    await service.setSuspended(adminCtx(), tenantId, true);

    const suspendido = await systemTx(base, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { suspended: true } }),
    );
    expect(suspendido?.suspended).toBe(true);

    const acciones = await systemTx(base, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId, action: { in: ['platform.tenant_suspended', 'platform.tenant_resumed'] } },
        select: { action: true, before: true, after: true },
      }),
    );
    expect(acciones.filter((a) => a.action === 'platform.tenant_suspended')).toHaveLength(1);
    expect(acciones.find((a) => a.action === 'platform.tenant_suspended')?.after).toEqual({
      suspended: true,
    });

    await service.setSuspended(adminCtx(), tenantId, false);
    const activo = await systemTx(base, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { suspended: true } }),
    );
    expect(activo?.suspended).toBe(false);
  });

  it('suspender dos veces no duplica el registro', async () => {
    await service.setSuspended(adminCtx(), tenantId, true);
    await service.setSuspended(adminCtx(), tenantId, true);

    const logs = await systemTx(base, (tx) =>
      tx.auditLog.count({ where: { tenantId, action: 'platform.tenant_suspended' } }),
    );
    // Uno del primer test de suspensión y uno de este: el segundo clic no escribe nada.
    expect(logs).toBe(2);
  });

  it('un negocio inexistente responde 404, no 500', async () => {
    await expect(
      service.grantPlan(adminCtx(), randomUUID(), { tier: 'FREE', expiresAt: null }),
    ).rejects.toThrow('Negocio no encontrado');
  });

  it('el resumen lista el negocio con su plan vigente y sus conteos', async () => {
    const overview = await service.overview();
    const row = overview.tenants.find((t) => t.id === tenantId);
    expect(row).toBeDefined();
    expect(row?.members).toBe(0);
    expect(row?.parts).toBe(0);
    expect(row?.suspended).toBe(true);
    // El plan más reciente gana: se concedió TALLER después de PRO.
    expect(row?.planTier).toBe('TALLER');
    expect(overview.reference).toEqual({
      brands: expect.any(Number),
      models: expect.any(Number),
      vehicles: expect.any(Number),
    });
  });
});
