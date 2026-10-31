/**
 * Instrumentación de Next.
 *
 * `register()` corre una vez al arrancar el servidor; aquí es donde se inicializa Sentry. La
 * condición —solo si `NEXT_PUBLIC_SENTRY_DSN` existe— no es una optimización: sin ella, `next dev`
 * en una máquina sin red tarda varios segundos esperando a un DSN vacío y luego escupe un error de
 * configuración que parece del proyecto.
 *
 * El import es dinámico a propósito. `@sentry/nextjs` es grande y su envoltorio toca el ciclo de
 * request; cargarlo sin DSN solo cambia el tiempo de arranque y las trazas de Next.
 */

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN;

export async function register(): Promise<void> {
  if (!DSN) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV,
    release: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT,
    // El 10 % es el mismo criterio que la API: alcanza para latencias, no agota la cuota gratis.
    tracesSampleRate: 0.1,
    // Misma política que la API: la web maneja sesiones de negocios ajenos y no hay razón para
    // mandar cookies, cabeceras ni cuerpos a un tercero.
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
  });
}

/**
 * Next llama esto cuando un Server Component o un route handler falla. Sin exportarlo, los errores
 * de servidor llegan a la consola del contenedor y a ningún lado más.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  if (!DSN) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(error, request, context);
}
