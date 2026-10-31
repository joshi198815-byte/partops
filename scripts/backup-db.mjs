#!/usr/bin/env node
/**
 * Respaldo nocturno de la base.
 *
 * Un respaldo que nunca se restauró no es un respaldo: es un archivo. Por eso este script hace tres
 * cosas que un `pg_dump` a secas no hace:
 *
 *  1. **Verifica que el dump tenga sentido** antes de subirlo. Un `pg_dump` contra una base vacía, o
 *     contra una URL equivocada, termina con código 0 y produce un archivo de 12 KB. Subirlo y
 *     borrar el de ayer sería perder las dos noches en una sola. Se exige tamaño mínimo y que
 *     `pg_restore --list` enumere las tablas que deben existir.
 *  2. **Sube con fecha en el nombre** para que la retención sea obvia en el bucket, no una regla
 *     escondida en el proveedor.
 *  3. **Borra solo después de subir**. Si la subida falla, el dump local queda y el cron de mañana
 *     no borra nada.
 *
 * Uso:
 *   DIRECT_DATABASE_URL=postgres://... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
 *   R2_SECRET_ACCESS_KEY=... R2_BUCKET=partops pnpm backup
 *
 * La URL tiene que ser la del rol **dueño** (`DIRECT_DATABASE_URL`), no la de la aplicación: con el
 * rol de la app la RLS bloquea el `COPY` y el dump muere a la mitad. Ver la nota en `main()`.
 *
 * Requiere `pg_dump`/`pg_restore` del cliente de PostgreSQL 18 en el PATH. Se comprueba antes de
 * tocar nada, con un mensaje que dice qué instalar: el error nativo de "command not found" dentro de
 * un cron es la mitad de un diagnóstico.
 */

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const run = promisify(execFile);

const MIN_BYTES = 64 * 1024;
const MIN_TABLES = 20;
const RETENTION_DAYS = 14;

/**
 * Los dumps van a `var/backups/`, que está en `.gitignore`.
 *
 * Se quedan en disco después de subirlos porque el simulacro de restauración los necesita, y porque
 * en una emergencia tener el archivo local ahorra bajar 40 MB de R2 con una credencial que quizá es
 * justo lo que se está depurando.
 */
const OUT_DIR = resolve('var/backups');

/** Tablas que tienen que aparecer en el dump. Si falta una, el respaldo es de otra base. */
const REQUIRED_TABLES = ['tenant', 'part', 'sales_order', 'stock_movement', 'inventory_level', 'member'];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name}`);
  return value;
}

/**
 * Fecha en Guatemala y no en UTC.
 *
 * El respaldo se llama con el día del negocio: un archivo `partops-2026-10-30.dump` creado a las
 * 18:30 de Guatemala (00:30 UTC del 31) tiene que decir 30, o quien busque "el respaldo del jueves"
 * no lo encuentra.
 */
function todayInGuatemala() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());
}

async function assertTool(command, hint) {
  try {
    await run(command, ['--version']);
  } catch {
    throw new Error(`No se encontró \`${command}\`. ${hint}`);
  }
}

async function main() {
  /**
   * El dump se hace con el rol **dueño**, no con el de la aplicación.
   *
   * Con `partops_app` la RLS aplica y `pg_dump` falla a la mitad: `COPY` sobre `audit_log` revienta
   * con «query would be affected by row-level security policy». Ese es el comportamiento correcto de
   * la base —protege los datos incluso de un dump— y por eso el respaldo necesita
   * `DIRECT_DATABASE_URL` (o `BACKUP_DATABASE_URL` explícito). Es también la razón por la que este
   * script no puede correr con las credenciales del contenedor de la API.
   */
  const url = process.env.BACKUP_DATABASE_URL ?? process.env.DIRECT_DATABASE_URL ?? required('DATABASE_URL');
  await assertTool(
    'pg_dump',
    'Instala postgresql-client (o `brew install libpq` en macOS) y vuelve a intentar.',
  );
  await assertTool('pg_restore', 'Instala postgresql-client: `pg_restore` viene en el mismo paquete.');

  await mkdir(OUT_DIR, { recursive: true });
  const day = todayInGuatemala();
  const file = join(OUT_DIR, `partops-${day}.dump`);

  try {
    // ── Dump ────────────────────────────────────────────────────────────────
    // `--format=custom` es lo que permite `pg_restore --list` y restauraciones selectivas.
    // `--no-owner`/`--no-privileges`: el respaldo se restaura en una base cuyo dueño es otro rol, y
    // los GRANT del origen no aplican ahí.
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`, url], {
      maxBuffer: 64 * 1024 * 1024,
    });

    // ── Verificación ────────────────────────────────────────────────────────
    const size = (await stat(file)).size;
    if (size < MIN_BYTES) {
      throw new Error(
        `El dump pesa ${(size / 1024).toFixed(1)} KB, menos del mínimo de ${MIN_BYTES / 1024} KB. ` +
          'Casi siempre significa base vacía o URL equivocada. NO se sube.',
      );
    }

    const { stdout: listing } = await run('pg_restore', ['--list', file], { maxBuffer: 64 * 1024 * 1024 });
    /**
     * `pg_restore --list` imprime `5626; 0 68902 TABLE DATA public account postgres` — identificador
     * del objeto al principio, nombre sin comillas, esquema antes del nombre y rol al final. Se ancla
     * en `TABLE DATA public` para no contar índices ni secuencias, que también son entradas.
     */
    const tables = new Set(
      [...listing.matchAll(/TABLE DATA public (\S+)/g)].map((m) => m[1]).filter(Boolean),
    );
    if (tables.size < MIN_TABLES) {
      throw new Error(`El dump solo contiene ${tables.size} tablas con datos (mínimo ${MIN_TABLES}).`);
    }
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) {
      throw new Error(`Al dump le faltan tablas obligatorias: ${missing.join(', ')}`);
    }

    console.log(`Dump verificado: ${(size / 1024 / 1024).toFixed(1)} MB, ${tables.size} tablas con datos.`);

    // ── Subida a R2 ─────────────────────────────────────────────────────────
    // Sin credenciales de R2 el respaldo se queda local y se avisa. Es lo que permite correr el
    // pipeline completo en una máquina de desarrollo y, en CI, detectar el problema antes de que
    // pase una noche sin respaldo en el bucket.
    if (!hasR2Credentials()) {
      console.warn(
        'R2 sin credenciales: el dump queda local y NO se subió. Configura R2_* para respaldar de verdad.',
      );
      console.log(JSON.stringify({ ok: true, uploaded: false, file, bytes: size, tables: tables.size }));
      return;
    }

    const bucket = process.env.R2_BUCKET ?? 'partops';
    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: required('R2_ACCESS_KEY_ID'),
        secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
      },
    });

    const key = `backups/partops-${day}.dump`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(file),
        ContentType: 'application/octet-stream',
        // Metadatos para poder auditar el objeto sin descargarlo: el tamaño y el conteo de tablas
        // son la evidencia de que este archivo sirve.
        Metadata: { tables: String(tables.size), bytes: String(size) },
      }),
    );
    console.log(`Subido a s3://${bucket}/${key}`);

    // ── Retención ───────────────────────────────────────────────────────────
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'backups/' }));
    let removed = 0;
    for (const object of listed.Contents ?? []) {
      if (!object.Key || !object.LastModified || object.LastModified >= cutoff) continue;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      removed += 1;
    }
    console.log(`Retención: ${removed} respaldo(s) de más de ${RETENTION_DAYS} días eliminados.`);

    // Evidencia para el resumen del workflow y para `RUNBOOK.md`.
    console.log(
      JSON.stringify({
        ok: true,
        uploaded: true,
        file: `partops-${day}.dump`,
        bytes: size,
        tables: tables.size,
        removed,
      }),
    );
  } catch (err) {
    // El archivo se queda para poder inspeccionarlo, pero se dice dónde: nadie lo va a buscar solo.
    console.error(`El dump queda en ${file} para revisión.`);
    throw err;
  }
}

function hasR2Credentials() {
  return Boolean(
    process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
  );
}

main().catch((err) => {
  console.error('Respaldo fallido:', err instanceof Error ? err.message : err);
  process.exit(1);
});
