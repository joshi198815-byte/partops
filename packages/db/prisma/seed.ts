import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Semilla de referencia vehicular.
 *
 * Esto NO son datos de demostración: es el parque vehicular que existe en Guatemala, curado a
 * mano, y es lo que hace que "capó corolla 2009" se resuelva sin que cada bodega tenga que capturar
 * marcas y modelos. La plataforma lo escribe una vez y todos los negocios lo comparten.
 *
 * Los rangos de años son los que se vendieron aquí, no el catálogo mundial completo: un Corolla
 * 1990 no llega al taller y no ensucia las facetas.
 *
 * Se puede correr varias veces: todo es `upsert` sobre claves naturales.
 */

interface ModelSeed {
  name: string;
  bodyType?: string;
  years: [number, number][];
  engines?: string[];
}

interface BrandSeed {
  name: string;
  country: string;
  models: ModelSeed[];
}

const VEHICLES: BrandSeed[] = [
  {
    name: 'Toyota',
    country: 'Japón',
    models: [
      { name: 'Corolla', bodyType: 'Sedán', years: [[2000, 2024]], engines: ['1.8L', '2.0L'] },
      { name: 'Hilux', bodyType: 'Pick-up', years: [[2005, 2024]], engines: ['2.4D', '2.8D'] },
      { name: 'Yaris', bodyType: 'Hatchback', years: [[2006, 2024]], engines: ['1.5L'] },
      { name: 'RAV4', bodyType: 'SUV', years: [[2006, 2024]], engines: ['2.0L', '2.5L'] },
      { name: 'Land Cruiser Prado', bodyType: 'SUV', years: [[2003, 2023]], engines: ['2.7L', '3.0D'] },
      { name: 'Tacoma', bodyType: 'Pick-up', years: [[2005, 2023]], engines: ['2.7L', '3.5L'] },
      { name: 'Hiace', bodyType: 'Microbús', years: [[2005, 2023]], engines: ['2.7L', '3.0D'] },
      { name: 'Avanza', bodyType: 'Minivan', years: [[2007, 2022]], engines: ['1.3L', '1.5L'] },
    ],
  },
  {
    name: 'Nissan',
    country: 'Japón',
    models: [
      { name: 'Sentra', bodyType: 'Sedán', years: [[2000, 2024]], engines: ['1.6L', '1.8L', '2.0L'] },
      { name: 'Versa', bodyType: 'Sedán', years: [[2012, 2024]], engines: ['1.6L'] },
      { name: 'Frontier', bodyType: 'Pick-up', years: [[2005, 2024]], engines: ['2.5L', '2.5D'] },
      { name: 'X-Trail', bodyType: 'SUV', years: [[2008, 2023]], engines: ['2.0L', '2.5L'] },
      { name: 'Kicks', bodyType: 'SUV', years: [[2017, 2024]], engines: ['1.6L'] },
      { name: 'Pathfinder', bodyType: 'SUV', years: [[2005, 2020]], engines: ['4.0L'] },
    ],
  },
  {
    name: 'Mitsubishi',
    country: 'Japón',
    models: [
      { name: 'L200', bodyType: 'Pick-up', years: [[2006, 2024]], engines: ['2.4D', '2.5D'] },
      { name: 'Montero', bodyType: 'SUV', years: [[2000, 2020]], engines: ['3.0L', '3.8L'] },
      { name: 'Outlander', bodyType: 'SUV', years: [[2007, 2023]], engines: ['2.0L', '2.4L'] },
      { name: 'Lancer', bodyType: 'Sedán', years: [[2002, 2017]], engines: ['1.6L', '2.0L'] },
      { name: 'Mirage', bodyType: 'Hatchback', years: [[2014, 2024]], engines: ['1.2L'] },
    ],
  },
  {
    name: 'Hyundai',
    country: 'Corea del Sur',
    models: [
      { name: 'Accent', bodyType: 'Sedán', years: [[2006, 2024]], engines: ['1.4L', '1.6L'] },
      { name: 'Elantra', bodyType: 'Sedán', years: [[2007, 2024]], engines: ['1.8L', '2.0L'] },
      { name: 'Tucson', bodyType: 'SUV', years: [[2005, 2024]], engines: ['2.0L', '2.4L'] },
      { name: 'Santa Fe', bodyType: 'SUV', years: [[2007, 2024]], engines: ['2.4L', '3.3L'] },
      { name: 'Creta', bodyType: 'SUV', years: [[2016, 2024]], engines: ['1.6L'] },
    ],
  },
  {
    name: 'Kia',
    country: 'Corea del Sur',
    models: [
      { name: 'Sportage', bodyType: 'SUV', years: [[2005, 2024]], engines: ['2.0L', '2.4L'] },
      { name: 'Rio', bodyType: 'Sedán', years: [[2006, 2024]], engines: ['1.4L', '1.6L'] },
      { name: 'Picanto', bodyType: 'Hatchback', years: [[2010, 2024]], engines: ['1.0L', '1.2L'] },
      { name: 'Sorento', bodyType: 'SUV', years: [[2007, 2024]], engines: ['2.4L', '3.3L'] },
      { name: 'Forte', bodyType: 'Sedán', years: [[2014, 2024]], engines: ['1.6L', '2.0L'] },
    ],
  },
  {
    name: 'Honda',
    country: 'Japón',
    models: [
      { name: 'Civic', bodyType: 'Sedán', years: [[2001, 2024]], engines: ['1.8L', '2.0L'] },
      { name: 'CR-V', bodyType: 'SUV', years: [[2007, 2024]], engines: ['2.0L', '2.4L'] },
      { name: 'Fit', bodyType: 'Hatchback', years: [[2009, 2020]], engines: ['1.5L'] },
      { name: 'HR-V', bodyType: 'SUV', years: [[2016, 2024]], engines: ['1.8L'] },
    ],
  },
  {
    name: 'Chevrolet',
    country: 'Estados Unidos',
    models: [
      { name: 'Aveo', bodyType: 'Sedán', years: [[2008, 2019]], engines: ['1.6L'] },
      { name: 'Spark', bodyType: 'Hatchback', years: [[2010, 2022]], engines: ['1.2L'] },
      { name: 'Silverado', bodyType: 'Pick-up', years: [[2007, 2024]], engines: ['4.3L', '5.3L'] },
      { name: 'Tahoe', bodyType: 'SUV', years: [[2007, 2024]], engines: ['5.3L'] },
      { name: 'Tracker', bodyType: 'SUV', years: [[2019, 2024]], engines: ['1.2T'] },
    ],
  },
  {
    name: 'Mazda',
    country: 'Japón',
    models: [
      { name: 'CX-5', bodyType: 'SUV', years: [[2013, 2024]], engines: ['2.0L', '2.5L'] },
      { name: 'Mazda 3', bodyType: 'Sedán', years: [[2004, 2024]], engines: ['1.6L', '2.0L'] },
      { name: 'Mazda 2', bodyType: 'Hatchback', years: [[2011, 2024]], engines: ['1.5L'] },
      { name: 'BT-50', bodyType: 'Pick-up', years: [[2007, 2020]], engines: ['2.5D', '3.2D'] },
    ],
  },
  {
    name: 'Suzuki',
    country: 'Japón',
    models: [
      { name: 'Swift', bodyType: 'Hatchback', years: [[2005, 2024]], engines: ['1.2L', '1.4L'] },
      { name: 'Vitara', bodyType: 'SUV', years: [[2015, 2024]], engines: ['1.6L'] },
      { name: 'Grand Vitara', bodyType: 'SUV', years: [[2006, 2017]], engines: ['2.0L', '2.4L'] },
      { name: 'Jimny', bodyType: 'SUV', years: [[2019, 2024]], engines: ['1.5L'] },
    ],
  },
  {
    name: 'Ford',
    country: 'Estados Unidos',
    models: [
      { name: 'Ranger', bodyType: 'Pick-up', years: [[2006, 2024]], engines: ['2.5L', '3.2D'] },
      { name: 'F-150', bodyType: 'Pick-up', years: [[2009, 2024]], engines: ['3.5L', '5.0L'] },
      { name: 'Escape', bodyType: 'SUV', years: [[2008, 2020]], engines: ['2.5L'] },
      { name: 'Explorer', bodyType: 'SUV', years: [[2011, 2024]], engines: ['3.5L'] },
    ],
  },
  {
    name: 'Volkswagen',
    country: 'Alemania',
    models: [
      { name: 'Jetta', bodyType: 'Sedán', years: [[2006, 2024]], engines: ['1.4T', '2.0L'] },
      { name: 'Golf', bodyType: 'Hatchback', years: [[2005, 2021]], engines: ['1.4T', '2.0T'] },
      { name: 'Tiguan', bodyType: 'SUV', years: [[2009, 2024]], engines: ['1.4T', '2.0T'] },
      { name: 'Amarok', bodyType: 'Pick-up', years: [[2011, 2022]], engines: ['2.0D'] },
    ],
  },
  {
    name: 'Isuzu',
    country: 'Japón',
    models: [
      { name: 'D-Max', bodyType: 'Pick-up', years: [[2007, 2024]], engines: ['2.5D', '3.0D'] },
      { name: 'NPR', bodyType: 'Camión', years: [[2008, 2024]], engines: ['3.0D'] },
    ],
  },
];

/**
 * Sinónimos que no caben en el diccionario del código porque son regionales y se descubren con
 * `search_event`. La tabla existe para que la plataforma los cure sin desplegar.
 */
const TERMS: { term: string; canonical: string }[] = [
  { term: 'cubierta', canonical: 'capo' },
  { term: 'capot', canonical: 'capo' },
  { term: 'balata', canonical: 'pastillas' },
  { term: 'balatas', canonical: 'pastillas' },
  { term: 'mordaza', canonical: 'caliper' },
  { term: 'maza', canonical: 'maza' },
  { term: 'ruleman', canonical: 'rodamiento' },
  { term: 'cuna', canonical: 'soporte' },
  { term: 'bomba de agua', canonical: 'bomba' },
  { term: 'tirador', canonical: 'manija' },
];

async function main() {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DIRECT_DATABASE_URL o DATABASE_URL');

  const pool = new Pool({ connectionString: url, max: 1 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });

  try {
    for (const brand of VEHICLES) {
      const row = await prisma.vehicleBrand.upsert({
        where: { name: brand.name },
        update: { country: brand.country },
        create: { name: brand.name, country: brand.country },
      });

      for (const model of brand.models) {
        const m = await prisma.vehicleModel.upsert({
          where: { brandId_name: { brandId: row.id, name: model.name } },
          update: { bodyType: model.bodyType ?? null },
          create: { brandId: row.id, name: model.name, bodyType: model.bodyType ?? null },
        });

        for (const [start, end] of model.years) {
          // Una fila por rango de años y motor: es la granularidad con la que se liga una pieza.
          const engines = model.engines?.length ? model.engines : [null];
          for (const engine of engines) {
            /**
             * `findFirst` + `create` y no `upsert`: la llave única de `vehicle` incluye columnas
             * anulables y Prisma exige que ninguna sea `null` en un `where` compuesto. La semilla
             * es idempotente igual, porque compara los cinco campos que forman la llave.
             */
            const existing = await prisma.vehicle.findFirst({
              where: { modelId: m.id, yearStart: start, yearEnd: end, engine },
              select: { id: true },
            });
            if (existing) continue;
            await prisma.vehicle.create({
              data: { modelId: m.id, yearStart: start, yearEnd: end, engine },
            });
          }
        }
      }
    }

    for (const t of TERMS) {
      await prisma.partTerm.upsert({
        where: { term: t.term },
        update: { canonical: t.canonical },
        create: t,
      });
    }

    const [brands, models, applications] = await Promise.all([
      prisma.vehicleBrand.count(),
      prisma.vehicleModel.count(),
      prisma.vehicle.count(),
    ]);
    console.log(
      `Referencia vehicular lista: ${brands} marcas, ${models} modelos, ${applications} aplicaciones.`,
    );
  } finally {
    // El adaptador está configurado con `disposeExternalPool`: él cierra el pool. Cerrarlo también
    // aquí lo cierra dos veces y el error tapa el resultado de la siembra.
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Fallo al sembrar la referencia vehicular:', err);
  process.exit(1);
});
