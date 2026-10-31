#!/usr/bin/env node
/**
 * Arma el `www/` de la cáscara Android.
 *
 * Los HTML guardados son plantillas con `__SERVER_URL__` en vez de la URL real. Se sustituye aquí y
 * no a mano porque `capacitor.config.ts` también lee `CAP_SERVER_URL`: si alguien apunta la cáscara
 * a un entorno de pruebas, el redireccionamiento y el `cleartext` tienen que cambiar juntos. Tenerlos
 * en dos archivos editados por separado garantiza que un día no coincidan.
 *
 * Uso:
 *   node scripts/build-mobile-shell.mjs                  → https://app.partops.gt
 *   CAP_SERVER_URL=http://10.0.2.2:3000 node …           → emulador contra el equipo local
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');
const target = (process.env.CAP_SERVER_URL ?? 'https://app.partops.gt').replace(/\/+$/, '');

/** Las plantillas y su salida. `index.html` se genera; `offline.html` es plantilla y también se genera. */
const pages = [
  { from: 'start.template.html', to: 'index.html' },
  { from: 'offline.template.html', to: 'offline.html' },
];

await mkdir(www, { recursive: true });

for (const page of pages) {
  const source = await readFile(join(www, page.from), 'utf8');
  if (!source.includes('__SERVER_URL__')) {
    throw new Error(`${page.from} no tiene __SERVER_URL__: revisa la plantilla.`);
  }
  await writeFile(join(www, page.to), source.replaceAll('__SERVER_URL__', target), 'utf8');
  console.log(`${page.from} → www/${page.to} (${target})`);
}

// `capacitor.config.ts` usa la misma variable. Se deja escrito para que quien abra Android Studio
// después no se pregunte a qué servidor apunta la cáscara que acaba de sincronizar.
await writeFile(
  join(www, 'build-info.json'),
  `${JSON.stringify({ server: target, builtAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);
console.log(`build-info.json → ${target}`);
