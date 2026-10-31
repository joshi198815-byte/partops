#!/usr/bin/env node
/**
 * Provisiona los tres servicios de PartOps en Render a partir de `render.yaml`.
 *
 * La API de Render no crea blueprints desde un repositorio sin que la GitHub App esté instalada,
 * así que esto crea los servicios uno por uno con la misma configuración que declara el blueprint.
 * Es idempotente: si un servicio con el nombre ya existe, lo reporta y no lo toca.
 *
 * Dos detalles que la documentación pública no deja claros y que costaron un 400 cada uno:
 *   - el campo es `ownerID` (D mayúscula), no `ownerId`;
 *   - los tipos son `web_service` y `background_worker`, no `web` y `worker`.
 *
 * Uso (los secretos se leen del entorno, nunca de argumentos, para que no queden en el historial):
 *   RENDER_API_KEY=... OWNER_ID=... DATABASE_URL=... DIRECT_DATABASE_URL=... \
 *   BETTER_AUTH_SECRET=... node scripts/provision-render.mjs
 */
const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY;
const OWNER = process.env.OWNER_ID;
const REPO = process.env.REPO_URL ?? 'https://github.com/joshi198815-byte/partops';
const BRANCH = process.env.REPO_BRANCH ?? 'master';
const REGION = process.env.RENDER_REGION ?? 'virginia';
const PLAN = process.env.RENDER_PLAN ?? 'starter';

if (!KEY || !OWNER) {
  console.error('Faltan RENDER_API_KEY u OWNER_ID.');
  process.exit(1);
}

/**
 * Aviso antes de gastar veinte minutos en un 402.
 *
 * Una cuenta sin método de pago solo acepta plan `free`, y `free` no ofrece
 * `background_worker`: `partops-worker` falla con 402. Y todo repo privado exige la GitHub App de
 * Render instalada, que no tiene endpoint de API. Las dos cosas se resuelven en el dashboard.
 */
if (PLAN !== 'free' && !process.env.RENDER_HAS_PAYMENT) {
  console.warn(`· plan ${PLAN}: Render responde 402 sin tarjeta. Usa RENDER_PLAN=free o agrega pago.`);
}
if (!process.env.RENDER_GITHUB_APP_OK) {
  console.warn('· repo privado: si Render no tiene su GitHub App instalada, responde 400 "unfetchable".');
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return json;
}

const env = (key, value) => ({ key, value });

const existing = new Set();
for (const item of (await call('GET', '/services?limit=100')) ?? []) existing.add(item.service.name);

function apiEnv() {
  return [
    env('NODE_ENV', 'production'),
    env('DATABASE_URL', process.env.DATABASE_URL),
    env('DIRECT_DATABASE_URL', process.env.DIRECT_DATABASE_URL),
    env('API_PUBLIC_URL', 'https://api.partops.autos'),
    env('WEB_APP_URL', 'https://app.partops.autos'),
    env('BETTER_AUTH_URL', 'https://app.partops.autos'),
    env('BETTER_AUTH_SECRET', process.env.BETTER_AUTH_SECRET),
    env('CRON_SECRET', process.env.CRON_SECRET),
    env('CORS_ORIGINS', 'https://app.partops.autos,capacitor://localhost'),
    env('MAIL_PROVIDER', 'log'),
    env('MAIL_FROM', 'PartOps <partopsgt@gmail.com>'),
  ];
}

const apiDocker = { dockerfilePath: './apps/api/Dockerfile', dockerContext: '.' };

const services = [
  {
    type: 'web_service',
    name: 'partops-api',
    envVars: [...apiEnv(), env('PROCESS_ROLE', 'api'), env('PORT', '4000'), env('PG_POOL_MAX', '10')],
    serviceDetails: {
      runtime: 'docker',
      plan: PLAN,
      region: REGION,
      healthCheckPath: '/api/health/ready',
      envSpecificDetails: apiDocker,
    },
  },
  {
    type: 'background_worker',
    name: 'partops-worker',
    envVars: [...apiEnv(), env('PROCESS_ROLE', 'worker'), env('PG_POOL_MAX', '4')],
    serviceDetails: {
      runtime: 'docker',
      plan: PLAN,
      region: REGION,
      envSpecificDetails: apiDocker,
    },
  },
  {
    type: 'web_service',
    name: 'partops-web',
    envVars: [
      env('NODE_ENV', 'production'),
      env('PORT', '3000'),
      // Se hornea en el build del rewrite `/api/*`; Render traduce cada variable a build arg.
      env('API_URL', 'https://api.partops.autos'),
      env('NEXT_PUBLIC_APP_URL', 'https://app.partops.autos'),
    ],
    serviceDetails: {
      runtime: 'docker',
      plan: PLAN,
      region: REGION,
      healthCheckPath: '/entrar',
      envSpecificDetails: { dockerfilePath: './apps/web/Dockerfile', dockerContext: '.' },
    },
  },
];

/**
 * Se sigue después de un fallo: un servicio que no se puede crear no debe impedir crear los demás.
 *
 * El caso concreto es el worker en plan `free`, que responde `only web services allowed for plan`.
 * Abortar ahí dejaría la web sin crear y el despliegue a medias por un servicio que ya está cubierto
 * por el cron de Cloudflare.
 */
let failed = 0;
for (const svc of services) {
  if (existing.has(svc.name)) {
    console.log(`= ${svc.name} ya existe, se deja igual`);
    continue;
  }
  try {
    const created = await call('POST', '/services', {
      ...svc,
      ownerID: OWNER,
      repo: REPO,
      branch: BRANCH,
      autoDeployTrigger: 'off',
    });
    console.log(`+ ${svc.name} → ${created.service.id} (${created.service.dashboardUrl})`);
  } catch (err) {
    failed++;
    console.error(`! ${svc.name}: ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} servicio(s) no se crearon. Revisar el mensaje de arriba.`);
  process.exit(1);
}
