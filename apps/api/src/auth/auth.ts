import type { BaseClient } from '@partops/db';
import { APIError, betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAuthMiddleware } from 'better-auth/api';
import { emailOTP, twoFactor } from 'better-auth/plugins';
import { env, isProduction } from '../config/env.js';
import type { MailService } from '../mail/mail.service.js';

/**
 * Rutas de Better Auth que NO se usan.
 *
 * Better Auth trae su propio CRUD de organizaciones y de administración de usuarios. Esas rutas se
 * saltan las reglas de PartOps: un miembro con `team.manage` podría llamar a un endpoint que le
 * suba el rol, y `/admin/*` da poderes de plataforma a quien tenga `user.role` en `admin`. El
 * equipo, las invitaciones y los roles viven en `/api/team/*`, donde cada cambio escribe auditoría
 * y respeta la regla del último propietario.
 *
 * Se responden como 404 y no 403: no hay razón para confirmar que existen.
 */
const BLOCKED_AUTH_ROUTES = new Set([
  '/delete-user',
  '/delete-user/callback',
  '/admin/set-role',
  '/admin/create-user',
  '/admin/update-user',
  '/admin/remove-user',
  '/admin/ban-user',
  '/admin/unban-user',
  '/admin/set-user-password',
  '/admin/impersonate-user',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/list-users',
  '/admin/list-user-sessions',
]);

export function createAuth(db: BaseClient, mail: MailService) {
  const web = env.WEB_APP_URL;

  return betterAuth({
    appName: 'PartOps',
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: 'postgresql' }),

    // La app Android (Capacitor) se sirve desde estos orígenes; sin ellos el login falla en el APK.
    trustedOrigins: [
      web,
      ...env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      // En desarrollo y pruebas el puerto cambia (Vite, `app.listen(0)`, túneles), así que
      // `localhost` y `127.0.0.1` en cualquier puerto se aceptan. En producción NO: ahí solo
      // entran los orígenes declarados, porque un comodín de host es una puerta CSRF abierta.
      ...(isProduction ? [] : ['localhost', '127.0.0.1', 'http://localhost:*', 'http://127.0.0.1:*']),
      'capacitor://localhost',
      'https://localhost',
    ],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
      /**
       * Better Auth arma `${baseURL}/reset-password/:token?callbackURL=<redirectTo>`. Si el
       * llamador no manda `redirectTo`, el enlace sale con `callbackURL` vacío y la API no sabe a
       * dónde reenviar el token: el correo llega muerto. El enlace se reconstruye contra la
       * pantalla propia, que es la única que existe.
       */
      sendResetPassword: async ({ user, url }) => {
        const target = new URL('/recuperar', web);
        const token = new URL(url).pathname.split('/').filter(Boolean).pop();
        if (token) target.searchParams.set('token', token);
        await mail.send(user.email, { template: 'reset-password', url: target.toString() });
      },
    },

    emailVerification: {
      // No se verifica al registrarse: el alta normal es por invitación, que ya valida el correo.
      sendOnSignUp: false,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mail.send(user.email, { template: 'verify-email', url });
      },
    },

    user: {
      additionalFields: {
        /** Fuerza el cambio de la contraseña temporal entregada en mano. Solo lo escribe el alta. */
        mustChangePassword: { type: 'boolean', required: false, defaultValue: false, input: false },
        phone: { type: 'string', required: false, input: true },
        /**
         * Rol de plataforma. Sin declararlo aquí, Better Auth no lo devuelve en `session.user`
         * aunque exista la columna, y el guard nunca podría reconocer al dueño de PartOps:
         * `@PlatformAdmin()` respondería 404 a todo el mundo, incluido a quien sí puede entrar.
         * `input: false` porque nadie se asciende solo desde el formulario de registro.
         */
        role: { type: 'string', required: false, input: false },
      },
      // Borrar la cuenta pasa por /api/account/delete, que además limpia el negocio propio,
      // las bodegas asignadas y los tokens. El endpoint nativo deja residuos.
      deleteUser: { enabled: false },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      // Renueva cada día: el vendedor que entra a diario no vuelve a escribir la contraseña.
      updateAge: 60 * 60 * 24,
      /**
       * Sin `cookieCache`. Cachear la sesión en la cookie firmada ahorra una consulta, pero deja
       * el negocio activo congelado hasta que la cookie expira: el usuario cambia de sucursal y
       * sigue viendo la anterior, o el dueño le quita el acceso a alguien y esa persona sigue
       * entrando. Una lectura indexada por request es más barata que un error de aislamiento.
       */
      additionalFields: {
        /**
         * Negocio activo. Se reutiliza la columna `activeOrganizationId` del esquema para no
         * agregar una migración por un nombre: el dato es el mismo.
         */
        activeTenantId: {
          type: 'string',
          required: false,
          input: false,
          fieldName: 'activeOrganizationId',
        },
      },
    },

    rateLimit: {
      // En desarrollo y tests se apaga para no bloquear las pruebas; en producción, siempre activo.
      enabled: isProduction,
      window: 60,
      max: 100,
      // Las credenciales tienen presupuesto propio y mucho más estrecho: sin esto, un bucle de
      // adivinanza podría gastar los 100/min globales probando contraseñas.
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 300, max: 5 },
        '/email-otp/send-verification-otp': { window: 300, max: 5 },
        '/email-otp/verify-email': { window: 300, max: 10 },
        '/change-password': { window: 300, max: 5 },
      },
    },

    advanced: {
      cookiePrefix: 'partops',
      useSecureCookies: isProduction,
      /**
       * Cookie de dominio padre.
       *
       * Sin esto, la web en `app.partops.autos` y la API en `api.partops.autos` tendrían cookies
       * distintas y el login «funcionaría» hasta la siguiente pantalla, que expulsa al usuario.
       * El punto inicial es obligatorio: `partops.autos` sin punto no cubre los subdominios.
       * En desarrollo queda apagado y todo sigue por el rewrite de Next.
       */
      crossSubDomainCookies:
        isProduction && env.COOKIE_DOMAIN ? { enabled: true, domain: env.COOKIE_DOMAIN } : { enabled: false },
      /**
       * `'uuid'` haría que Better Auth esperara que la base generara el id con `gen_random_uuid()`,
       * pero el esquema declara `@id` sin default: el insert salía sin `id` y todo alta fallaba
       * con "Argument `id` is missing". Se genera en la app, que funciona igual en cualquier
       * proveedor y permite sembrar filas con ids conocidos en las pruebas.
       */
      database: { generateId: () => crypto.randomUUID() },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (BLOCKED_AUTH_ROUTES.has(ctx.path)) {
          throw new APIError('NOT_FOUND', { message: 'No encontrado' });
        }

        // La contraseña temporal que se entrega en mano no puede quedarse puesta.
        if (ctx.path === '/change-password') {
          const next = (ctx.body as { newPassword?: string } | undefined)?.newPassword;
          if (next && next === process.env.BOOTSTRAP_PASSWORD) {
            throw new APIError('BAD_REQUEST', { message: 'Elige una contraseña distinta a la inicial' });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // Cambiar o restablecer la contraseña apaga el flag de contraseña temporal.
        if (ctx.path === '/change-password' || ctx.path.startsWith('/reset-password')) {
          const userId = (ctx.context.session as { user?: { id: string } } | null)?.user?.id;
          if (userId) {
            await db.user.update({ where: { id: userId }, data: { mustChangePassword: false } });
          }
        }
      }),
    },

    plugins: [
      twoFactor({ issuer: 'PartOps' }),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        // El alta por invitación ya verificó el correo al abrir el enlace; el OTP queda para
        // recuperación y para verificar un correo nuevo.
        sendVerificationOnSignUp: false,
        sendVerificationOTP: async ({ email, otp }) => {
          await mail.send(email, { template: 'otp', otp, type: 'verificacion' });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
