import { env } from '../config/env.js';

/**
 * Observabilidad opcional.
 *
 * Sin `SENTRY_DSN` esta función no hace **nada** y ni siquiera carga el SDK: ni una llamada de red,
 * ni una advertencia, ni 3 MB de node_modules en memoria. Eso es deliberado. En desarrollo y en CI
 * no hay DSN, y una integración que igual arranca y falla en segundo plano llena los logs de ruido
 * que enseña a ignorarlos —y el día que hay un error real ya nadie mira.
 *
 * Con DSN, las trazas van al 10 %: el plan gratuito se agota con el tráfico de una bodega un día
 * normal, y una muestra del 10 % alcanza para ver latencias por ruta. Los errores van al 100 %,
 * porque un error no muestreado es un error que nunca existió.
 *
 * `dataCollection` en falso importa más de lo que parece: PartOps sirve datos de negocios ajenos.
 * Con la colección por defecto el SDK adjunta IPs, cabeceras y cuerpos a cada evento. Un tablero de
 * errores no es lugar para el correo de un cliente ni para el cuerpo de una venta.
 */

type SentryModule = typeof import('@sentry/node');

let sdk: SentryModule | null = null;

/** Arranca Sentry si hay DSN. Devuelve `false` sin tocar la red cuando no lo hay. */
export async function initObservability(): Promise<boolean> {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;

  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn,
    environment: env.NODE_ENV,
    release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT,
    tracesSampleRate: 0.1,
    // Sentry 11 retiró `sendDefaultPii` y lo reemplazó por control por categoría. La política
    // sigue siendo la misma y más explícita: nada de cookies, nada de cabeceras, nada de cuerpos,
    // nada de variables locales (llevan precios y correos), y sin `user.*` automático. Lo único
    // que viaja es la pila, la ruta redactada y el mensaje.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend(event) {
      // La ruta pública lleva el slug del negocio; la privada, tokens de recibo e invitación. En los
      // eventos solo se quiere saber qué endpoint falló, no a quién.
      if (event.request?.url) event.request.url = redactUrl(event.request.url);
      return event;
    },
  });
  sdk = Sentry;
  return true;
}

/** Reemplaza slugs y tokens de la ruta por un marcador estable, para agrupar eventos en Sentry. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.pathname = url.pathname
      .replace(/^\/api\/public\/catalog\/[^/]+/, '/api/public/catalog/:slug')
      .replace(/^\/api\/r\/[^/]+/, '/api/r/:token')
      .replace(/^\/api\/auth\/[^/]+\/[^/]+/, '/api/auth/:flow');
    url.search = '';
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * Cerrar el cliente deja salir los eventos que quedaron en cola. Llamarlo al recibir SIGTERM es la
 * diferencia entre tener el error del último minuto y no tenerlo: Render reinicia el proceso justo
 * después del aviso.
 */
export async function closeObservability(): Promise<void> {
  if (!sdk) return;
  await sdk.close(2_000);
  sdk = null;
}

/** Captura un error fuera del ciclo de request (arranque, cron). No-op sin DSN. */
export function capture(error: unknown): void {
  sdk?.captureException(error);
}
