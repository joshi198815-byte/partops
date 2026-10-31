const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
        ],
      },
    ];
  },
};

export default nextConfig;
