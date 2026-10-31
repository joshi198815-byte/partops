#!/usr/bin/env node
/**
 * Conecta el bucket R2 a `cdn.partops.autos`.
 *
 * Hoy las fotos salen por `pub-*.r2.dev`, un dominio de terceros que Cloudflare puede limitar o
 * cambiar sin avisar. El dominio propio da TLS, caché en el borde y una URL que no parece de
 * desarrollo cuando un cliente la ve en un WhatsApp.
 *
 * Requisitos:
 *   CF_API_TOKEN  token con `Zone:Read` + `R2:Edit` (se lee del entorno, nunca se pasa por argumento
 *                 ni queda en el historial del shell).
 *   CF_ACCOUNT_ID cuenta de Cloudflare dueña del bucket.
 *   CF_ZONE_ID    zona de `partops.autos`.
 *
 * Uso:
 *   node scripts/r2-custom-domain.mjs            # conecta y verifica
 *   node scripts/r2-custom-domain.mjs --check    # solo verifica, no escribe nada
 *
 * Es idempotente: si el dominio ya existe y está activo, no hace nada y termina en 0.
 */
const BUCKET = process.env.R2_BUCKET ?? 'partops';
const DOMAIN = process.env.R2_CUSTOM_DOMAIN ?? 'cdn.partops.autos';
const CHECK_ONLY = process.argv.includes('--check');

const token = process.env.CF_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID;
const zoneId = process.env.CF_ZONE_ID;

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!token || !accountId) fail('Faltan CF_API_TOKEN y CF_ACCOUNT_ID en el entorno.');
if (!CHECK_ONLY && !zoneId) fail('Falta CF_ZONE_ID. Sin zona no se puede emitir el certificado.');

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${BUCKET}/domains`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Cloudflare devuelve HTML en un 5xx del borde; el mensaje útil es el estado.
    json = { success: false, errors: [{ message: `HTTP ${res.status}` }] };
  }
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

/** Lista los dominios personalizados del bucket. La forma del payload cambió entre versiones. */
async function listDomains() {
  const { ok, status, json } = await call('GET', '/custom');
  if (!ok) return { ok: false, status, domains: [] };
  const domains = json.result?.domains ?? json.result ?? [];
  return { ok: true, status, domains: Array.isArray(domains) ? domains : [] };
}

function findDomain(domains) {
  return domains.find((d) => (d.domain ?? d.name ?? '').toLowerCase() === DOMAIN.toLowerCase());
}

const before = await listDomains();
if (!before.ok && !CHECK_ONLY) {
  fail(
    `No se pudo leer los dominios del bucket (HTTP ${before.status}). ` +
      'Revisa que CF_API_TOKEN tenga R2:Edit sobre esta cuenta.',
  );
}

const existing = findDomain(before.domains);

if (existing) {
  const active = existing.enabled !== false && existing.status !== 'inactive';
  console.log(
    `· ${DOMAIN} ya está conectado (estado: ${existing.status ?? (active ? 'activo' : 'inactivo')}).`,
  );
  if (!active && !CHECK_ONLY) {
    console.log('  Está inactivo: revisa el DNS en Cloudflare antes de reintentar. El script no lo fuerza.');
  }
  process.exit(active ? 0 : 1);
}

if (CHECK_ONLY) {
  console.log(`· ${DOMAIN} todavía no está conectado.`);
  process.exit(1);
}

console.log(`· Conectando ${DOMAIN} al bucket ${BUCKET}…`);
const created = await call('POST', '/custom', { domain: DOMAIN, zoneId, enabled: true, minTLS: '1.2' });
if (!created.ok) {
  const detail = (created.json.errors ?? []).map((e) => e.message).join(' · ') || `HTTP ${created.status}`;
  fail(`Cloudflare rechazó el dominio: ${detail}`);
}

// La emisión del certificado no es instantánea: Cloudflare responde `pending` y pasa a `active` en
// minutos. Se espera un rato acotado y, si sigue pendiente, se dice qué revisar en vez de fingir
// que ya funciona.
const deadline = Date.now() + 90_000;
let state = 'pending';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  const now = findDomain((await listDomains()).domains);
  state = (now?.status ?? now?.enabled) ? 'active' : 'pending';
  if (now?.status === 'active' || now?.enabled === true) {
    state = 'active';
    break;
  }
  process.stdout.write('.');
}

if (state !== 'active') {
  console.error(
    `\n⚠ ${DOMAIN} quedó en estado "pending". Revisa en Cloudflare:\n` +
      '  · que el registro DNS `cdn` apunte al bucket (CNAME automático de R2),\n' +
      '  · que el certificado haya terminado de emitirse en R2 → Settings → Custom Domains.\n' +
      'Vuelve a correr este script con --check en unos minutos.',
  );
  process.exit(2);
}

console.log(`\n✓ ${DOMAIN} activo.`);
console.log(`  Siguiente paso: R2_PUBLIC_URL=https://${DOMAIN} en el servicio de la API (Render).`);
console.log(
  '  Deja `pub-*.r2.dev` activo una semana: las URLs ya guardadas en la base siguen saliendo por ahí.',
);
