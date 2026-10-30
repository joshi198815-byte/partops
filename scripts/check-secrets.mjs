import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Bloquea el commit si aparece un secreto con pinta real en los archivos preparados.
 *
 * No sustituye a gitleaks en CI (que mira el historial completo); esto es la red de seguridad
 * local para que un `git add .` con un .env dentro no llegue ni al primer push.
 */
const PATTERNS = [
  { name: 'Clave privada', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google service account', re: /"type"\s*:\s*"service_account"/ },
  { name: 'Stripe live key', re: /\bsk_live_[0-9a-zA-Z]{24,}\b/ },
  { name: 'Resend key', re: /\bre_[0-9a-zA-Z]{20,}\b/ },
  {
    name: 'Postgres URL con credenciales',
    re: /postgres(ql)?:\/\/[^\s:'"]+:[^\s@'"]+@(?!localhost|127\.0\.0\.1)/,
  },
  { name: 'Token de GitHub', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'Clave de OpenAI/Anthropic', re: /\b(sk-ant-|sk-proj-)[0-9A-Za-z_-]{20,}\b/ },
];

const ALLOWED = [
  // Cadenas de ejemplo en documentación y .env.example, con valores evidentemente falsos.
  /\.env\.example$/,
  /check-secrets\.mjs$/,
  /AGENTS\.md$/,
  /README\.md$/,
];

let files;
try {
  files = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  process.exit(0);
}

const hits = [];
for (const file of files) {
  if (ALLOWED.some((re) => re.test(file))) continue;
  // Los binarios no se leen: un PNG con "BEGIN PRIVATE KEY" en los metadatos es ruido.
  if (/\.(png|jpe?g|webp|ico|pdf|zip|apk|aab)$/i.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    const match = content.match(re);
    if (match) hits.push({ file, name, sample: match[0].slice(0, 12) });
  }
}

if (hits.length) {
  console.error('\nCommit bloqueado: posibles secretos en archivos preparados.\n');
  for (const h of hits) console.error(`  ${h.file}  →  ${h.name}  (${h.sample}…)`);
  console.error('\nQuita el valor, usa una variable de entorno, y vuelve a preparar el archivo.');
  process.exit(1);
}
