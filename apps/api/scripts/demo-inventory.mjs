/**
 * Siembra una sucursal y devuelve ids de bodega y variante para probar traslados y despacho a mano.
 *
 * Uso: `pnpm --filter @partops/api exec node scripts/demo-inventory.mjs` con `DATABASE_URL` en el
 * entorno (o `node --env-file=../../.env scripts/demo-inventory.mjs`). Idempotente: si la sucursal
 * ya existe no la duplica.
 */
import { createBaseClient, systemTx } from '@partops/db';

const tenantSlug = 'bodega-ana-repuestos';
const base = createBaseClient({ connectionString: process.env.DATABASE_URL });

const out = await systemTx(base, async (tx) => {
  const tenant = await tx.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
  if (!tenant) throw new Error('tenant no existe');

  const existing = await tx.warehouse.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, code: true },
  });

  if (!existing.some((w) => w.code === 'SUC')) {
    await tx.warehouse.create({
      data: { tenantId: tenant.id, code: 'SUC', name: 'Sucursal Zona 10', address: 'Zona 10' },
    });
  }

  const warehouses = await tx.warehouse.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  });

  const variant = await tx.partVariant.findFirst({
    where: { tenantId: tenant.id, sku: 'PST-BOS-001' },
    select: { id: true },
  });

  return { tenantId: tenant.id, warehouses, variantId: variant?.id ?? null };
});

console.log(JSON.stringify(out));
await base.$disconnect();
