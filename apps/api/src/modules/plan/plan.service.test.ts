import { randomUUID } from 'node:crypto';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../common/context.js';
import type { DatabaseService } from '../../infra/database.module.js';
import { PlanService } from './plan.service.js';

/**
 * Topes de plan contra Postgres real.
 *
 * Lo que se verifica no es la aritmética del tope —eso es `used + 1 > limit`— sino las tres cosas
 * que un candado mal puesto rompe y ninguna prueba unitaria vería:
 *
 *  - que un plan vencido **degrade** a FREE en vez de tumbar la petición;
 *  - que el tope cuente piezas vivas y no archivadas, o un negocio que limpia su catálogo se queda
 *    sin poder cargar nada;
 *  - que una invitación pendiente **ocupe lugar**, o se mandan diez enlaces con tope de cinco.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

describe.skipIf(skip)('PlanService: tier vigente y topes', () => {
  let base: BaseClient;
  let db: DatabaseService;
  let service: PlanService;

  const tenantId = randomUUID();
  const slug = `plan-${tenantId.slice(0, 8)}`;
  const userId = randomUUID();

  function ctx(): Ctx {
    return {
      user: {
        id: userId,
        email: `plan-${tenantId.slice(0, 8)}@partops.test`,
        name: 'Dueño',
        emailVerified: true,
        mustChangePassword: false,
      },
      sessionId: 'session-plan',
      tenant: {
        tenantId,
        tenantName: 'Bodega de prueba',
        tenantSlug: slug,
        role: 'propietario',
        permissions: new Set(),
        warehouseIds: [],
      },
    };
  }

  async function grant(tier: string, expiresAt: Date | null) {
    await systemTx(base, (tx) =>
      tx.planGrant.create({
        data: { tenantId, tier, expiresAt, grantedById: userId, note: 'prueba' },
      }),
    );
  }

  /** Siembra piezas mínimas: una por fila, sin variantes; alcanza para contar. */
  async function seedParts(count: number) {
    await systemTx(base, async (tx) => {
      for (let i = 0; i < count; i++) {
        await tx.part.create({
          data: { tenantId, name: `Pieza ${i}`, slug: `pieza-${i}-${randomUUID().slice(0, 8)}` },
        });
      }
    });
  }

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 8 });
    db = {
      client: base,
      tx: (t: string, fn: never, options?: never) => tenantTx(base, t, fn, options),
      system: (fn: never, options?: never) => systemTx(base, fn, options),
    } as unknown as DatabaseService;
    service = new PlanService(db);

    await systemTx(base, async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, slug, name: 'Bodega de prueba' } });
      await tx.user.create({
        data: {
          id: userId,
          name: 'Dueño',
          email: `plan-${tenantId.slice(0, 8)}@partops.test`,
          emailVerified: true,
        },
      });
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
      await client.query('DELETE FROM "part" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "invitation" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "member" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "plan_grant" WHERE "tenantId" = $1', [tenantId]);
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
      await client.query('DELETE FROM "user" WHERE "id" = $1', [userId]);
    } finally {
      await client.end();
    }
  });

  it('un negocio sin concesión es FREE y su tope de piezas es 150', async () => {
    const spec = await service.effective(ctx());
    expect(spec.tier).toBe('FREE');
    expect(spec.limits.parts).toBe(150);
  });

  it('el plan más reciente manda, y TALLER quita el tope de piezas', async () => {
    await grant('PRO', null);
    expect((await service.effective(ctx())).tier).toBe('PRO');

    await grant('TALLER', null);
    const spec = await service.effective(ctx());
    expect(spec.tier).toBe('TALLER');
    expect(spec.limits.parts).toBeNull();
  });

  it('una concesión vencida vuelve a FREE sin lanzar', async () => {
    await grant('PRO', new Date(Date.now() - 86_400_000));
    const spec = await service.effective(ctx());
    expect(spec.tier).toBe('FREE');
  });

  it('crear la pieza 151 falla con PLAN_LIMIT y el tope en el mensaje', async () => {
    await grant('FREE', null);
    await seedParts(150);

    await expect(db.tx(tenantId, (tx) => service.assertCanAddParts(ctx(), tx, 1))).rejects.toMatchObject({
      response: { code: 'PLAN_LIMIT', message: expect.stringContaining('150') },
    });
  });

  it('consultar con 0 no lanza aunque ya esté en el tope', async () => {
    await grant('FREE', null);
    await expect(db.tx(tenantId, (tx) => service.assertCanAddParts(ctx(), tx, 0))).resolves.toBeUndefined();
  });

  it('una pieza archivada no cuenta: se hace lugar archivando', async () => {
    await systemTx(base, async (tx) => {
      const one = await tx.part.findFirst({ where: { tenantId }, select: { id: true } });
      if (one) await tx.part.update({ where: { id: one.id }, data: { status: 'ARCHIVADO' } });
    });

    await expect(db.tx(tenantId, (tx) => service.assertCanAddParts(ctx(), tx, 1))).resolves.toBeUndefined();
  });

  it('TALLER no frena ninguna pieza', async () => {
    await grant('TALLER', null);
    await expect(
      db.tx(tenantId, (tx) => service.assertCanAddParts(ctx(), tx, 9999)),
    ).resolves.toBeUndefined();
  });

  it('una invitación pendiente ocupa lugar: no se mandan más enlaces que usuarios', async () => {
    await grant('FREE', null);
    // Se llena el plan hasta el tope (2 en FREE: el dueño ya es miembro y una pendiente).
    await systemTx(base, (tx) =>
      tx.invitation
        .createMany({
          data: [0, 1].map(() => ({
            tenantId,
            email: `invitado-${randomUUID().slice(0, 8)}@partops.test`,
            roleId: randomUUID(),
            token: randomUUID().replaceAll('-', ''),
            status: 'PENDIENTE',
            expiresAt: new Date(Date.now() + 86_400_000),
            invitedById: userId,
          })),
        })
        .catch(() => undefined),
    );

    await expect(db.tx(tenantId, (tx) => service.assertCanAddMember(ctx(), tx))).rejects.toMatchObject({
      response: { code: 'PLAN_LIMIT' },
    });
  });

  it('catálogo público exige PRO, con el plan que lo desbloquea en el mensaje', async () => {
    await grant('FREE', null);
    await expect(service.assertFeature(ctx(), 'publicCatalog')).rejects.toMatchObject({
      response: { code: 'PLAN_LIMIT', message: expect.stringContaining('Mostrador') },
    });

    await grant('PRO', null);
    await expect(service.assertFeature(ctx(), 'publicCatalog')).resolves.toBeUndefined();
  });

  it('el importador corta en las filas del plan', async () => {
    await grant('FREE', null);
    await expect(service.assertImportRows(ctx(), 301)).rejects.toMatchObject({
      response: { code: 'PLAN_LIMIT', message: expect.stringContaining('300') },
    });
    await expect(service.assertImportRows(ctx(), 300)).resolves.toBeUndefined();
  });

  it('el uso reporta piezas vivas y miembros activos', async () => {
    // Después de las pruebas anteriores hay piezas acumuladas y una archivada: se cuenta lo que
    // hay vivo en el momento, sin asumir un total fijo. Lo que importa es que la cifra que se pinta
    // en Configuración no incluya lo archivado.
    const [live, archived] = await Promise.all([
      db.tx(tenantId, (tx) => tx.part.count({ where: { tenantId, status: { not: 'ARCHIVADO' } } })),
      db.tx(tenantId, (tx) => tx.part.count({ where: { tenantId, status: 'ARCHIVADO' } })),
    ]);
    expect(archived).toBeGreaterThan(0);

    const usage = await service.usage(ctx());
    expect(usage.parts).toBe(live);
    expect(usage.members).toBe(0);
  });
});
