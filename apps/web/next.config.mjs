import path from 'node:path';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/**
 * Commit que se está construyendo, expuesto como cabecera.
 *
 * Render no inyecta el SHA en la imagen; lo pone como variable al desplegar. Leerlo al servir
 * probaría solo que la variable existe, no que el contenedor es nuevo. Se resuelve al construir
 * para que la cabecera sea prueba del artefacto, igual que `/api/health/ready` lo es de la API.
 */
const BUILD_COMMIT = (process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA ?? 'dev').slice(0, 8);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * Salida autocontenida para la imagen de producción.
   *
   * `.next/standalone` trae el servidor y solo las dependencias que el trazado de imports
   * encontró; sin esto habría que copiar `node_modules` completo al contenedor. En un monorepo
   * hay que subir la raíz del trazado un nivel, o Next resuelve `@partops/ui` contra
   * `apps/web/node_modules` y el paquete del workspace queda fuera del artefacto.
   */
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  // La UI vive en un paquete del monorepo: hay que transpilarla, si no Next sirve TS crudo.
  transpilePackages: ['@partops/ui', '@partops/contracts'],
  typedRoutes: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.r2.cloudflarestorage.com' },
      { protocol: 'https', hostname: '*.r2.dev' },
    ],
  },
  /**
   * La API se monta bajo el mismo origen.
   *
   * Sin esto, la cookie de sesión sería de `localhost:4000` y no viajaría en las peticiones del
   * servidor de Next ni en las navegaciones del navegador sin CORS con credenciales en cada
   * llamada. Con el rewrite, `partops.session_token` es una cookie del sitio y el formulario de
   * login funciona igual en desarrollo que detrás de Cloudflare.
   *
   * `API_URL` se lee al construir, no al servir: el rewrite se hornea en la tabla de rutas del
   * build. Por eso el Dockerfile la recibe como build arg, y por eso apuntar la web a otra API
   * exige reconstruir la imagen, no solo cambiar una variable de entorno.
   */
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          // El CSP no vive aquí: se genera por petición con nonce en `src/proxy.ts`. Un CSP
          // estático en este archivo y otro en el proxy se pisarían, y gana el último en escribirse.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          // Un año y `preload` sería el objetivo, pero solo cuando el dominio esté confirmado
          // detrás de Cloudflare con TLS en todos los subdominios.
          { key: 'Strict-Transport-Security', value: 'max-age=15552000; includeSubDomains' },
          // El commit del build, para que `deploy.yml` pueda distinguir "ya desplegó" de "sigue
          // sirviendo el contenedor anterior". Se resuelve al construir, así que prueba que el
          // artefacto es nuevo y no solo que la variable de entorno cambió.
          { key: 'x-partops-commit', value: BUILD_COMMIT },
        ],
      },
    ];
  },
};

export default nextConfig;
