import { randomUUID } from 'node:crypto';
import type { Permission } from '@partops/contracts';
import { type BaseClient, createBaseClient, systemTx, tenantTx } from '@partops/db';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../../common/context.js';
import type { DatabaseService } from '../../infra/database.module.js';
import { CommandService } from './command.service.js';
import { SearchService } from './search.service.js';

/**
 * Paleta de comandos contra Postgres real.
 *
 * Lo que se prueba es el aislamiento, no la relevancia: el orden lo cubre el test del contrato y la
 * relevancia de piezas la cubre `search`. Aquí la pregunta es una sola —¿puede esta pantalla
 * enseñar el teléfono de un cliente ajeno?— y se responde con dos negocios de verdad.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const skip = !DATABASE_URL;

const PERMS = new Set<Permission>(['dashboard.view', 'catalog.view', 'orders.view', 'orders.create']);

describe.skipIf(skip)('CommandService: aislamiento por negocio', () => {
  let base: BaseClient;
  let command: CommandService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let customerB = '';
  let orderB = '';
  let userId = '';

  function ctx(tenantId: string, slug: string): Ctx {
    return {
      user: {
        id: userId,
        email: 'paleta@partops.test',
        name: 'Vendedor',
        emailVerified: true,
        mustChangePassword: false,
      },
      sessionId: 'session-command',
      tenant: {
        tenantId,
        tenantName: `Bodega ${slug}`,
        tenantSlug: slug,
        role: 'vendedor',
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

    command = new CommandService(db, new SearchService(db));

    await systemTx(base, async (tx) => {
      const user = await tx.user.create({
        data: {
          id: randomUUID(),
          name: 'Vendedor',
          email: `cmd-${tenantA.slice(0, 8)}@partops.test`,
          emailVerified: true,
        },
      });
      userId = user.id;

      for (const [id, slug] of [
        [tenantA, `cmd-a-${tenantA.slice(0, 6)}`],
        [tenantB, `cmd-b-${tenantB.slice(0, 6)}`],
      ] as const) {
        await tx.tenant.create({ data: { id, slug, name: `Bodega ${slug}` } });
        await tx.warehouse.create({ data: { tenantId: id, code: 'P', name: 'Principal', isDefault: true } });
      }

      // Cliente y pedido que SOLO existen en el negocio B.
      const c = await tx.customer.create({
        data: { tenantId: tenantB, name: 'María Ajpacajá', phone: '5555-9999' },
      });
      customerB = c.id;

      const o = await tx.salesOrder.create({
        data: {
          tenantId: tenantB,
          number: 77,
          customerId: c.id,
          customerName: 'María Ajpacajá',
          warehouseId: (await tx.warehouse.findFirstOrThrow({ where: { tenantId: tenantB } })).id,
          totalCents: 0,
        },
      });
      orderB = o.id;
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
      for (const id of [tenantA, tenantB]) {
        await client.query('DELETE FROM "sales_order" WHERE "tenantId" = $1', [id]);
        await client.query('DELETE FROM "customer" WHERE "tenantId" = $1', [id]);
        await client.query('DELETE FROM "warehouse" WHERE "tenantId" = $1', [id]);
        await client.query('DELETE FROM "tenant" WHERE "id" = $1', [id]);
      }
      await client.query('DELETE FROM "user" WHERE "id" = $1', [userId]);
    } finally {
      await client.end();
    }
  });

  it('la paleta del negocio A no ve clientes ni pedidos del negocio B', async () => {
    const res = await command.find(ctx(tenantA, 'cmd-a'), 'María');
    const hits = res.groups.flatMap((g) => g.hits);
    expect(hits.some((h) => h.id === customerB)).toBe(false);
    expect(hits.some((h) => h.id === orderB)).toBe(false);
    expect(hits.every((h) => h.href.startsWith('/app'))).toBe(true);
  });

  it('el negocio B sí los encuentra', async () => {
    const res = await command.find(ctx(tenantB, 'cmd-b'), 'María');
    const hits = res.groups.flatMap((g) => g.hits);
    expect(hits.some((h) => h.id === customerB)).toBe(true);
    expect(hits.some((h) => h.id === orderB)).toBe(true);
  });

  it('sin texto ofrece solo acciones permitidas', async () => {
    const res = await command.find(ctx(tenantA, 'cmd-a'), '');
    const hits = res.groups.flatMap((g) => g.hits);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.kind === 'action')).toBe(true);
    // `inventory.view` y `finance.view` no están en PERMS: esas acciones no se ofrecen.
    expect(hits.some((h) => h.id === 'finance')).toBe(false);
    expect(hits.some((h) => h.id === 'new-sale')).toBe(true);
  });
});
