import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { allowedOrigins, env, isProduction } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('PartOps');

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

  await app.listen(env.PORT, '0.0.0.0');
  logger.log(`PartOps API escuchando en ${env.API_PUBLIC_URL} (rol: ${env.PROCESS_ROLE})`);
}

bootstrap().catch((err) => {
  // Sin este catch, un fallo de arranque (p. ej. env inválido) muere en silencio en Render.
  new Logger('Bootstrap').error(err);
  process.exit(1);
});
