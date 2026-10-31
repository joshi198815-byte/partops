import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carga el `.env` de la raíz antes de importar el cliente.
 *
 * Sin esto, `pnpm test` en este paquete corría con `DATABASE_URL` vacío y `rls.test.ts` se saltaba
 * en silencio: el test que prueba el aislamiento entre negocios era justo el único que nunca
 * corría en local. Saltarse en CI sin Postgres está bien; saltarse por no leer el `.env` que sí
 * existe, no.
 */
const root = resolve(import.meta.dirname, '../..');
const envFile = resolve(root, '.env');

if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Un `.env` ilegible no debe impedir correr los tests que no dependen de la base.
  }
}
