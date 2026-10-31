import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { allowedOrigins, env, isProduction } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.setGlobalPrefix('api');
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
  await app.listen(env.PORT, '0.0.0.0');

  new Logger('PartOps').log(`PartOps API escuchando en ${env.API_PUBLIC_URL} (rol: ${env.PROCESS_ROLE})`);
}

bootstrap().catch((err: unknown) => {
  // `console.error` y no el Logger: con `bufferLogs` activo, el logger de Nest puede no haber
  // inicializado todavía cuando el fallo ocurre, y el error moriría sin imprimirse. Es
  // exactamente el modo de falla que deja un contenedor reiniciándose sin pista alguna.
  console.error('Fallo al arrancar PartOps API:', err);
  process.exit(1);
});
