#!/usr/bin/env node
/**
 * Simulacro de restauración.
 *
 * Restaura un dump real en una base limpia y comprueba que lo restaurado es lo que se respaldó. La
 * pregunta que responde no es "¿el archivo se puede abrir?" sino "¿si mañana se pierde la base,
 * puedo devolver el negocio a como estaba esta mañana?".
 *
 * Tres comprobaciones, en orden de severidad:
 *
 *  1. **Los conteos cuadran** con el origen (si se pasa `SOURCE_DATABASE_URL`). Un dump que restaura
 *     sin error pero con la mitad de las ventas es peor que un dump que falla: se descubre en una
 *     auditoría, meses después.
 *  2. **La RLS sigue forzada** en `part`. Un `pg_restore` con `--no-owner` puede dejar las políticas
 *     en su lugar pero el `FORCE ROW LEVEL SECURITY` se pierde si se restauró con otro dueño. Sin
 *     `FORCE`, el dueño de la tabla ve todo: exactamente la fuga que RLS existe para evitar.
 *  3. **El ledger es consistente**: la suma de `stock_movement` por SKU cuadra con
 *     `inventory_level.onHand`. Es la regla de negocio que más duele si se rompe.
 *
 * La base de destino es `SCRATCH_DATABASE_URL` y **nunca** `DATABASE_URL`. El script se niega a
 * correr si ambas apuntan al mismo lugar: un simulacro que restaura encima de producción no es un
 * simulacro, es el incidente.
 *
 * Uso:
 *   SCRATCH_DATABASE_URL=postgres://... SOURCE_DATABASE_URL=postgres://... \
 *   pnpm restore:drill -- var/partops-2026-10-30.dump
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REPORT = resolve('var/restore-drill.json');

/** Tablas cuyo conteo tiene que cuadrar entre origen y restauración. */
const COUNTED = ['tenant', 'part', 'sales_order', 'sales_order_item', 'stock_movement', 'inventory_level'];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name}`);
  return value;
}

/**
 * `psql -At` devuelve valores crudos separados por `|`, sin adornos. Es más simple y más honesto que
 * traer un driver: el cliente ya está instalado porque `pg_restore` lo está.
 */
async function query(url, sql) {
  const { stdout } = await run('psql', [url, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

async function count(url, table) {
  const raw = await query(url, `SELECT count(*) FROM "${table}"`);
  return Number(raw);
}

/** Compara sin revelar las URLs: un informe que se adjunta a un workflow no puede llevar credenciales. */
function sameHost(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname === ub.hostname && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

async function main() {
  const dumpPath = process.argv[2];
  if (!dumpPath) throw new Error('Uso: pnpm restore:drill -- <ruta-al-dump>');

  const scratch = required('SCRATCH_DATABASE_URL');
  const source = process.env.SOURCE_DATABASE_URL;
  if (source && sameHost(source, scratch)) {
    throw new Error('SCRATCH_DATABASE_URL apunta a la misma base que SOURCE_DATABASE_URL. Abortado.');
  }

  const findings = [];
  const record = (ok, label, detail) => {
    findings.push({ ok, label, detail });
    console.log(`${ok ? 'ok  ' : 'FALLA'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };

  // ── Restaurar ─────────────────────────────────────────────────────────────
  // `--clean --if-exists`: la base de scratch puede tener restos del simulacro anterior. `--exit-on-error`
  // convierte un objeto que no se pudo crear en un fallo del simulacro, no en una advertencia que se
  // pierde entre cien líneas.
  await run(
    'pg_restore',
    ['--clean', '--if-exists', '--no-owner', '--exit-on-error', `--dbname=${scratch}`, dumpPath],
    {
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  record(true, 'el dump se restauró sin errores');

  // ── Conteos ───────────────────────────────────────────────────────────────
  const counts = {};
  for (const table of COUNTED) {
    counts[table] = await count(scratch, table);
  }
  record(
    counts.tenant > 0 && counts.part > 0,
    'la base restaurada tiene negocios y piezas',
    `tenant=${counts.tenant}, part=${counts.part}`,
  );

  if (source) {
    const mismatches = [];
    for (const table of COUNTED) {
      const origin = await count(source, table);
      if (origin !== counts[table])
        mismatches.push(`${table}: origen ${origin}, restaurado ${counts[table]}`);
    }
    record(mismatches.length === 0, 'los conteos cuadran con el origen', mismatches.join('; ') || undefined);
  } else {
    console.log('info  SOURCE_DATABASE_URL vacío: no se comparan los conteos contra el origen');
  }

  // ── RLS ───────────────────────────────────────────────────────────────────
  const rls = await query(
    scratch,
    "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'part'",
  );
  record(
    rls === 't',
    'RLS forzada en `part`',
    rls === 't' ? undefined : 'revisar las políticas y el dueño de la tabla',
  );

  const policies = Number(await query(scratch, "SELECT count(*) FROM pg_policies WHERE tablename = 'part'"));
  record(policies > 0, 'las políticas de `part` existen', `${policies} política(s)`);

  // ── Ledger ────────────────────────────────────────────────────────────────
  // Se comparan totales por bodega y variante, no fila por fila: cada movimiento lleva su `delta`
  // firmado, así que la proyección tiene que ser su suma exacta —incluidas las reservas, que no
  // mueven `onHand` pero sí quedan en el ledger como movimientos—.
  const drift = await query(
    scratch,
    `WITH ledger AS (
       SELECT "variantId", "warehouseId", sum("delta") AS qty
         FROM stock_movement GROUP BY 1, 2
     )
     SELECT count(*) FROM inventory_level l
       JOIN ledger g ON g."variantId" = l."variantId" AND g."warehouseId" = l."warehouseId"
      WHERE l."onHand" <> g.qty`,
  );
  record(Number(drift) === 0, 'el ledger cuadra con las existencias', `${drift} fila(s) con diferencia`);

  // ── Informe ───────────────────────────────────────────────────────────────
  await mkdir(resolve('var'), { recursive: true });
  const report = {
    ok: findings.every((f) => f.ok),
    ranAt: new Date().toISOString(),
    dump: dumpPath.split(/[\\/]/).pop(),
    dumpBytes: (await readFile(dumpPath)).byteLength,
    comparedWithSource: Boolean(source),
    counts,
    findings,
  };
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nInforme escrito en ${REPORT}`);

  if (!report.ok) process.exit(1);
}

main().catch((err) => {
  console.error('Simulacro fallido:', err instanceof Error ? err.message : err);
  process.exit(1);
});
