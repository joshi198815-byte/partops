import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Herramienta de desarrollo: carga piezas de ejemplo en un negocio local.
 *
 * No es parte de la aplicación y no se ejecuta en producción. Existe porque el alta de piezas
 * llega en T6 y sin catálogo no hay forma de revisar la búsqueda, el inventario ni el despacho
 * de punta a punta. Sirve para revisar UNA bodega de desarrollo concreta, por slug.
 *
 *   pnpm --filter @partops/db exec tsx prisma/dev-parts.ts <slug-del-negocio>
 */

const slug = process.argv[2];
if (!slug) throw new Error('Uso: tsx prisma/dev-parts.ts <slug>');

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Falta DIRECT_DATABASE_URL o DATABASE_URL');

const pool = new Pool({ connectionString: url, max: 1 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });

interface Sample {
  name: string;
  category: string;
  sku: string;
  oem: string[];
  price: number;
  cost: number;
  stock: number;
  brand: string;
  model: string;
  start: number;
  end: number;
  engine?: string;
}

const SAMPLES: Sample[] = [
  {
    name: 'Capó delantero',
    category: 'Capo',
    sku: 'CAP-COR-0913',
    oem: ['53301-02330'],
    price: 185000,
    cost: 120000,
    stock: 2,
    brand: 'Toyota',
    model: 'Corolla',
    start: 2009,
    end: 2013,
  },
  {
    name: 'Capó delantero',
    category: 'Capo',
    sku: 'CAP-COR-0308',
    oem: ['53301-02040'],
    price: 165000,
    cost: 105000,
    stock: 1,
    brand: 'Toyota',
    model: 'Corolla',
    start: 2003,
    end: 2008,
  },
  {
    name: 'Faro delantero derecho',
    category: 'Faro',
    sku: 'FAR-SEN-0712',
    oem: ['26010-ET000'],
    price: 97500,
    cost: 62000,
    stock: 4,
    brand: 'Nissan',
    model: 'Sentra',
    start: 2007,
    end: 2012,
  },
  {
    name: 'Faro delantero izquierdo',
    category: 'Faro',
    sku: 'FAR-SEN-0712-I',
    oem: ['26060-ET000'],
    price: 97500,
    cost: 62000,
    stock: 3,
    brand: 'Nissan',
    model: 'Sentra',
    start: 2007,
    end: 2012,
  },
  {
    name: 'Pastillas de freno delanteras',
    category: 'Pastillas',
    sku: 'PAS-HIL-0515',
    oem: ['04465-0K290'],
    price: 42500,
    cost: 27000,
    stock: 12,
    brand: 'Toyota',
    model: 'Hilux',
    start: 2005,
    end: 2015,
    engine: '2.5D',
  },
  {
    name: 'Amortiguador delantero',
    category: 'Amortiguador',
    sku: 'AMO-SPO-1116',
    oem: ['54651-3U000'],
    price: 78500,
    cost: 49000,
    stock: 6,
    brand: 'Kia',
    model: 'Sportage',
    start: 2011,
    end: 2016,
  },
  {
    name: 'Radiador',
    category: 'Radiador',
    sku: 'RAD-CIV-0611',
    oem: ['19010-RNA-A01'],
    price: 132000,
    cost: 88000,
    stock: 2,
    brand: 'Honda',
    model: 'Civic',
    start: 2006,
    end: 2011,
  },
  {
    name: 'Bomba de agua',
    category: 'Bomba',
    sku: 'BOM-ACC-1217',
    oem: ['25100-2B000'],
    price: 56000,
    cost: 34000,
    stock: 5,
    brand: 'Hyundai',
    model: 'Accent',
    start: 2012,
    end: 2017,
  },
  {
    name: 'Espejo retrovisor derecho',
    category: 'Retrovisor',
    sku: 'RET-MAZ3-1419',
    oem: ['B45A-69-121'],
    price: 68000,
    cost: 41000,
    stock: 3,
    brand: 'Mazda',
    model: 'Mazda 3',
    start: 2014,
    end: 2019,
  },
  {
    name: 'Filtro de aceite',
    category: 'Filtro',
    sku: 'FIL-UNI-0001',
    oem: ['90915-YZZD3'],
    price: 6500,
    cost: 3200,
    stock: 40,
    brand: 'Toyota',
    model: 'Yaris',
    start: 2006,
    end: 2024,
  },
];

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`No existe el negocio con slug "${slug}"`);

  const warehouse = await prisma.warehouse.findFirst({
    where: { tenantId: tenant.id },
    orderBy: { isDefault: 'desc' },
    select: { id: true, code: true },
  });
  if (!warehouse) throw new Error('El negocio no tiene bodega: termina el onboarding primero');

  let created = 0;
  for (const s of SAMPLES) {
    const existing = await prisma.partVariant.findUnique({
      where: { tenantId_sku: { tenantId: tenant.id, sku: s.sku } },
      select: { id: true },
    });
    if (existing) continue;

    const category = await prisma.partCategory.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: s.category.toLowerCase() } },
      update: {},
      create: { tenantId: tenant.id, name: s.category, slug: s.category.toLowerCase() },
    });

    const part = await prisma.part.create({
      data: {
        tenantId: tenant.id,
        name: s.name,
        slug: `${s.sku.toLowerCase()}-${s.start}`,
        categoryId: category.id,
        brand: 'Genérico',
        warrantyDays: 90,
      },
    });

    const variant = await prisma.partVariant.create({
      data: {
        tenantId: tenant.id,
        partId: part.id,
        sku: s.sku,
        title: s.name,
        partNumber: s.oem[0] ?? null,
        oemNumbers: s.oem,
        priceCents: s.price,
        costCents: s.cost,
        barcode: `750${String(s.sku.length).padStart(4, '0')}${created}`,
      },
    });

    const brandRow = await prisma.vehicleBrand.upsert({
      where: { name: s.brand },
      update: {},
      create: { name: s.brand },
    });
    const modelRow = await prisma.vehicleModel.upsert({
      where: { brandId_name: { brandId: brandRow.id, name: s.model } },
      update: {},
      create: { brandId: brandRow.id, name: s.model },
    });
    const vehicle = await prisma.vehicle.findFirst({
      where: { modelId: modelRow.id, yearStart: s.start, yearEnd: s.end, engine: s.engine ?? null },
      select: { id: true },
    });
    const vehicleId =
      vehicle?.id ??
      (
        await prisma.vehicle.create({
          data: { modelId: modelRow.id, yearStart: s.start, yearEnd: s.end, engine: s.engine ?? null },
        })
      ).id;

    await prisma.partCompatibility.create({ data: { tenantId: tenant.id, partId: part.id, vehicleId } });
    await prisma.inventoryLevel.create({
      data: {
        tenantId: tenant.id,
        variantId: variant.id,
        warehouseId: warehouse.id,
        onHand: s.stock,
        reserved: 0,
        reorderPoint: 3,
        binLocation: `A-${String(created + 1).padStart(2, '0')}`,
      },
    });
    created += 1;
  }

  console.log(`Piezas de desarrollo en "${tenant.name}" (${warehouse.code}): ${created} nuevas.`);
}

main()
  .catch((err: unknown) => {
    console.error('Fallo al cargar piezas de desarrollo:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
