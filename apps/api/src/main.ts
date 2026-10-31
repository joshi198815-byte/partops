import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { allowedOrigins, env, isProduction } from './config/env.js';
import { capture, closeObservability, initObservability } from './infra/observability.js';

async function bootstrap() {
  // Antes de Nest: si el arranque falla, se quiere la traza completa y no un `console.error` suelto.
  const observed = await initObservability();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  app.setGlobalPrefix('api');

  /**
   * IP real del cliente detrás del proxy.
   *
   * Sin esto, `req.ip` es la IP del balanceador: el límite de 10/min de `/auth` se aplicaría a todo
   * PartOps como si fuera un solo usuario, y el primer día con dos logins simultáneos bloquearía a
   * todos. `1` y no `true`: confía en exactamente un salto (el proxy del proveedor) y no en toda la
   * cadena, que es lo que permite a un cliente falsificar `x-forwarded-for` con un `true`.
   *
   * En desarrollo no se activa: sin proxy, cualquiera podría mandar su propio `x-forwarded-for` y
   * saltarse los límites de su máquina.
   */
  if (isProduction) app.set('trust proxy', 1);

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    // El cliente manda el tenant activo en cada request; sin exponerlo, el navegador no lo lee.
    exposedHeaders: ['x-request-id'],
  });

  app.use(
    helmet({
      // La API no sirve HTML: CSP estricta y sin inline. La web tiene la suya.
      contentSecurityPolicy: isProduction
        ? { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }
        : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Los logs se bufferizan hasta aquí; volcarlos es lo que hace visible el arranque en Render.
  app.flushLogs();

  /**
   * El rol `worker` no abre puerto.
   *
   * Comparte imagen con la API y su trabajo es el mantenimiento programado, no atender requests.
   * Escuchar en `PORT` con `PROCESS_ROLE=worker` en un servicio sin dominio no hace daño, pero sí
   * confunde: el healthcheck del proveedor marcaría verde un proceso que en realidad es el otro
   * rol, y un día alguien apuntaría tráfico ahí. `init()` deja el contenedor de Nest completo
   * —temporizadores, base, servicios— sin servidor HTTP.
   */
  if (env.PROCESS_ROLE === 'worker') {
    await app.init();
    new Logger('PartOps').log('PartOps worker iniciado (mantenimiento, sin puerto HTTP)');
    return installShutdown(observed);
  }

  await app.listen(env.PORT, '0.0.0.0');

  new Logger('PartOps').log(
    `PartOps API escuchando en ${env.API_PUBLIC_URL} (rol: ${env.PROCESS_ROLE}` +
      `${observed ? ', observabilidad activa' : ''})`,
  );

  installShutdown(observed);
}

/**
 * Render manda SIGTERM y da unos segundos. Sin esto, los eventos en cola de Sentry se pierden y el
 * apagado queda como un error de red en el panel.
 */
function installShutdown(observed: boolean): void {
  const shutdown = (signal: string) => {
    new Logger('PartOps').log(`${signal} recibido: cerrando${observed ? ' y vaciando Sentry' : ''}`);
    void closeObservability().finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch(async (err: unknown) => {
  // `console.error` y no el Logger: con `bufferLogs` activo, el logger de Nest puede no haber
  // inicializado todavía cuando el fallo ocurre, y el error moriría sin imprimirse. Es
  // exactamente el modo de falla que deja un contenedor reiniciándose sin pista alguna.
  console.error('Fallo al arrancar PartOps API:', err);
  capture(err);
  await closeObservability();
  process.exit(1);
});
