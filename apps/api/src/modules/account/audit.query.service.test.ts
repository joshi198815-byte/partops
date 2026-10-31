import { randomUUID } from 'node:crypto';
import type { Permission } from '@partops/contracts';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../../common/audit.js';
import type { Ctx } from '../../common/context.js';
import type { DatabaseService } from '../../infra/database.module.js';
import { AuditQueryService } from './audit.query.service.js';

/**
 * Bitácora contra Postgres real.
 *
 * Dos cosas se prueban y ninguna es el listado feliz:
 *
 *  - **La bitácora vive o muere con su transacción.** Si se escribiera fuera del `tx` del cambio,
 *    quedaría el registro de una operación que se revirtió y la auditoría acusaría a alguien de algo
 *    que no pasó.
 *  - **El filtro de fechas es local.** Un cambio de las 19:00 en Guatemala pertenece a hoy; contado
 *    en UTC caería mañana y el dueño buscaría el precio movido en el día equivocado.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

const PERMS = new Set<Permission>(['audit.view']);

describe.skipIf(skip)('AuditQueryService: transacción, filtros y zona', () => {
  let base: BaseClient;
  let service: AuditQueryService;

  const tenantId = randomUUID();
  const slug = `aud-${tenantId.slice(0, 8)}`;
  let userId = '';

  function ctx(): Ctx {
    return {
      user: {
        id: userId,
        email: 'auditoria@partops.test',
        name: 'Contador',
        emailVerified: true,
        mustChangePassword: false,
      },
      sessionId: 'session-audit',
      tenant: {
        tenantId,
        tenantName: 'Bodega Auditada',
        tenantSlug: slug,
        role: 'gerente',
        permissions: PERMS,
        warehouseIds: [],
      },
    } as Ctx;
  }

  beforeAll(async () => {
    base = createBaseClient({ connectionString: DATABASE_URL, maxConnections: 8 });
    const db = {
      client: base,
      tx: (t: string, fn: never, options?: never) => tenantTx(base, t, fn, options),
      system: (fn: never, options?: never) => systemTx(base, fn, options),
    } as unknown as DatabaseService;

    service = new AuditQueryService(db);

    await systemTx(base, async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug, name: 'Bodega Auditada', timezone: 'America/Guatemala' },
      });
      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          name: 'Dueña',
          email: `aud-${tenantId.slice(0, 8)}@partops.test`,
          emailVerified: true,
        },
      });
      userId = user.id;
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
      await client.query('DELETE FROM "tenant" WHERE "id" = $1', [tenantId]);
      await client.query('DELETE FROM "user" WHERE "id" = $1', [userId]);
    } finally {
      await client.end();
    }
  });

  it('un cambio revertido no deja bitácora', async () => {
    await expect(
      tenantTx(base, tenantId, async (tx) => {
        await audit(tx, {
          tenantId,
          userId,
          action: 'prueba.revertida',
          entity: 'part',
          after: { name: 'no debería quedar' },
        });
        throw new Error('falla a propósito');
      }),
    ).rejects.toThrow('falla a propósito');

    const res = await service.list(ctx(), { limit: 50, offset: 0 });
    expect(res.items.some((row) => row.action === 'prueba.revertida')).toBe(false);
  });

  it('un cambio confirmado queda con actor, entidad y diferencia', async () => {
    await tenantTx(base, tenantId, (tx) =>
      audit(tx, {
        tenantId,
        userId,
        action: 'catalog.part_updated',
        entity: 'part',
        entityId: 'pieza-1',
        before: { priceCents: 100_000 },
        after: { priceCents: 120_000 },
      }),
    );

    const res = await service.list(ctx(), { limit: 50, offset: 0 });
    const row = res.items.find((item) => item.action === 'catalog.part_updated');
    expect(row?.actorName).toBe('Dueña');
    expect(row?.entity).toBe('part');
    expect(row?.after).toEqual({ priceCents: 120_000 });
    expect(res.entities).toContain('part');
    expect(res.actions).toContain('catalog.part_updated');
  });

  it('filtra por entidad y por acción', async () => {
    await tenantTx(base, tenantId, (tx) =>
      audit(tx, { tenantId, userId, action: 'finance.expense_created', entity: 'expense' }),
    );

    const soloGastos = await service.list(ctx(), { entity: 'expense', limit: 50, offset: 0 });
    expect(soloGastos.items.length).toBeGreaterThan(0);
    expect(soloGastos.items.every((row) => row.entity === 'expense')).toBe(true);

    const porAccion = await service.list(ctx(), {
      action: 'catalog.part_updated',
      limit: 50,
      offset: 0,
    });
    expect(porAccion.items.every((row) => row.action === 'catalog.part_updated')).toBe(true);
  });

  it('el rango de fechas usa el día del negocio, no el de UTC', async () => {
    // 19:00 en Guatemala del 30 de octubre = 01:00 UTC del 31.
    const instante = new Date('2026-10-31T01:00:00.000Z');
    await tenantTx(base, tenantId, async (tx) => {
      await audit(tx, { tenantId, userId, action: 'prueba.nocturna', entity: 'part' });
      // La columna nace con `now()`; se mueve para fijar el caso sin depender de la hora de la prueba.
      await tx.$executeRaw`UPDATE "audit_log" SET "createdAt" = ${instante} WHERE "tenantId" = ${tenantId} AND "action" = 'prueba.nocturna'`;
    });

    const delDia = await service.list(ctx(), {
      from: '2026-10-30',
      to: '2026-10-30',
      limit: 100,
      offset: 0,
    });
    expect(delDia.items.some((row) => row.action === 'prueba.nocturna')).toBe(true);

    const delDiaSiguiente = await service.list(ctx(), {
      from: '2026-10-31',
      to: '2026-10-31',
      limit: 100,
      offset: 0,
    });
    expect(delDiaSiguiente.items.some((row) => row.action === 'prueba.nocturna')).toBe(false);
  });
});
