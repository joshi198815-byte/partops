import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carga el `.env` de la raíz antes de importar la app.
 *
 * Los tests que tocan la base y la configuración de auth necesitan las mismas variables que el
 * servidor real. Sin esto, `vitest` arranca sin `BETTER_AUTH_SECRET` y el archivo falla al
 * importarse —un error que parece del test y es del entorno—. Node 22 trae `loadEnvFile`, así que
 * no hace falta una dependencia extra.
 */
const root = resolve(import.meta.dirname, '../..');
const envFile = resolve(root, '.env');

if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Un `.env` ilegible no debe impedir correr tests que no dependen de la base.
  }
}
