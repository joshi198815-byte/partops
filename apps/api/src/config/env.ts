import { z } from 'zod';

/**
 * Configuración validada al arrancar.
 *
 * Falla ruidosamente si falta un secreto: es preferible un contenedor que no arranca a uno que
 * arranca sin `BETTER_AUTH_SECRET` y firma sesiones con una clave vacía.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
  DIRECT_DATABASE_URL: z.string().optional(),

  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_APP_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET necesita al menos 32 caracteres'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),

  /** `gmail` mientras no haya dominio verificado; `resend` cuando exista. `log` en tests. */
  MAIL_PROVIDER: z.enum(['log', 'gmail', 'resend']).default('log'),
  MAIL_FROM: z.string().default('PartOps <partopsgt@gmail.com>'),
  GMAIL_USER: z.string().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('partops'),
  R2_PUBLIC_URL: z.string().optional(),
  /** Solo desarrollo: dónde caen las imágenes cuando no hay R2. */
  STORAGE_DIR: z.string().default('var/uploads'),

  /** Clave del sitio de Turnstile. La pareja del secreto: sin las dos, el widget no se pinta. */
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().optional(),

  /** Firebase Cloud Messaging. Sin las tres, el push al APK se apaga solo. */
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  /** PEM con `\n` literales: en `.env` un salto de línea real rompe el archivo. */
  FCM_PRIVATE_KEY: z.string().optional(),

  PG_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  PROCESS_ROLE: z.enum(['api', 'worker']).default('api'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Nunca se imprime el valor, solo el nombre del campo que falla.
  throw new Error(`Configuración inválida:\n${problems}`);
}

export const env = parsed.data;

export const allowedOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const isProduction = env.NODE_ENV === 'production';
