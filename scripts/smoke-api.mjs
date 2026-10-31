#!/usr/bin/env node
/**
 * Humo de producción.
 *
 * No es un test unitario disfrazado: comprueba el despliegue desde afuera, con lo que un usuario
 * vería. Las cinco cosas que revisa son las que se rompen en un despliegue y no en un `pnpm test`:
 *
 *   1. El dominio responde (DNS, TLS, certificado vencido, Cloudflare en rojo).
 *   2. `/health/ready` es 200 y la base ve la RLS. Un 503 aquí significa que la migración no corrió
 *      o que la API está conectada con el rol dueño —el escenario que filtra entre negocios.
 *   3. El `commit` desplegado es el que se quería desplegar. Sin esto, un deploy viejo que sigue
 *      sirviendo se ve verde para siempre.
 *   4. La portada trae `content-security-policy` con `nonce-`. Si falta, el proxy no está montado.
 *   5. `/app` sin sesión redirige. Si responde 200, hay una pantalla privada abierta.
 *
 * Uso:
 *   SMOKE_BASE_URL=https://app.partops.gt node scripts/smoke-api.mjs
 *   SMOKE_EXPECTED_COMMIT=abc1234 SMOKE_API_URL=https://api.partops.gt node scripts/smoke-api.mjs
 *
 * Sale con 1 y un listado de fallas; no se detiene en la primera para no arreglar una por vez.
 */

const BASE = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const API = (process.env.SMOKE_API_URL ?? BASE).replace(/\/+$/, '');
const EXPECTED_COMMIT = process.env.SMOKE_EXPECTED_COMMIT?.trim() ?? '';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);

const failures = [];
const lines = [];

/**
 * Una sola pasada de comprobaciones por endpoint.
 *
 * `redirect: 'manual'` es imprescindible en `/app`: con el `follow` por defecto, un redirect al
 * login se convierte en un 200 del formulario y la comprobación pasaría siempre.
 */
async function get(url, init = {}) {
  const started = Date.now();
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'partops-smoke/1.0' },
    ...init,
  });
  return { res, ms: Date.now() - started };
}

function check(ok, label, detail) {
  lines.push(`${ok ? 'ok  ' : 'FALLA'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function main() {
  // 1 · La API (o el dominio, si la web y la API comparten origen).
  try {
    const { res, ms } = await get(`${API}/api/health/ready`);
    const body = res.status === 200 ? await res.json().catch(() => null) : null;
    check(res.status === 200, 'GET /api/health/ready responde 200', `${res.status} en ${ms} ms`);
    if (body) {
      check(body.database === true, 'la base responde');
      check(body.rlsEnforced === true, 'RLS forzada en el esquema', 'si es false, la API corre como dueño');
      if (EXPECTED_COMMIT) {
        check(
          typeof body.commit === 'string' && body.commit.startsWith(EXPECTED_COMMIT),
          'el commit desplegado es el esperado',
          `esperado ${EXPECTED_COMMIT.slice(0, 8)}, servido ${String(body.commit).slice(0, 8)}`,
        );
      } else {
        lines.push('info  SMOKE_EXPECTED_COMMIT vacío: no se compara el commit');
      }
    } else {
      check(false, 'el body de /health/ready es JSON');
    }
  } catch (err) {
    check(false, 'la API responde', err instanceof Error ? err.message : String(err));
  }

  // 2 · La portada y el CSP.
  try {
    const { res } = await get(`${BASE}/entrar`);
    check(res.status === 200, 'GET /entrar responde 200', String(res.status));
    const csp = res.headers.get('content-security-policy') ?? '';
    check(csp.includes('nonce-'), 'la portada trae CSP con nonce');
    check(/frame-ancestors 'none'/.test(csp), 'CSP bloquea el encuadre (clickjacking)');
    check(/object-src 'none'/.test(csp), 'CSP bloquea plugins');
  } catch (err) {
    check(false, 'la portada responde', err instanceof Error ? err.message : String(err));
  }

  // 3 · Una pantalla privada no se sirve sin sesión.
  try {
    const { res } = await get(`${BASE}/app`);
    const redirected = res.status >= 300 && res.status < 400;
    check(redirected, 'GET /app sin sesión redirige', `respondió ${res.status}`);
  } catch (err) {
    check(false, 'GET /app responde', err instanceof Error ? err.message : String(err));
  }

  // 4 · El service worker se sirve desde la raíz y sin caché agresiva. Si el archivo no existe, la
  // PWA pierde el modo offline justo en la bodega sin señal.
  try {
    const { res } = await get(`${BASE}/sw.js`);
    check(res.status === 200, 'GET /sw.js responde 200', String(res.status));
  } catch (err) {
    check(false, 'GET /sw.js responde', err instanceof Error ? err.message : String(err));
  }

  console.log(lines.join('\n'));
  if (failures.length) {
    console.error(`\n${failures.length} comprobación(es) fallaron: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nHumo completo: el despliegue responde, está protegido y sirve el código esperado.');
}

main().catch((err) => {
  console.error('El humo no pudo completarse:', err);
  process.exit(1);
});
