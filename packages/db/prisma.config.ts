import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 lee la conexión desde aquí, no desde `datasource db { url = env(...) }`.
 *
 * `datasource` = rol de MIGRACIÓN (dueño de las tablas). La app nunca usa esta URL: su
 * `DATABASE_URL` es el rol `partops_app`, sin privilegios de dueño, para que RLS aplique.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/partops',
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
