import { type NextRequest, NextResponse } from 'next/server';

/**
 * CSP con nonce por petición.
 *
 * `'unsafe-inline'` en `script-src` es la puerta que se usa para inyectar cualquier cosa cuando hay
 * un XSS reflejado; con nonce, cada `<script>` que Next sirve lleva un valor que el atacante no
 * puede adivinar. El nonce viaja en dos lugares y ambos son necesarios:
 *
 *  - en la **respuesta** (`content-security-policy`), que es lo que el navegador aplica;
 *  - en la **petición** (`x-nonce` y el propio CSP), para que Next se lo ponga a sus propios
 *    scripts de hidratación. Sin esto la política se cumple al pie de la letra y la app no
 *    arranca: React nunca hidrata y la página se ve, pero no responde. Es el modo de falla que
 *    más tiempo cuesta diagnosticar, por eso la verificación es abrir `/entrar` y usar el
 *    formulario, no solo mirar el header.
 *
 * Costo aceptado: leer headers hace la página dinámica. En una app con sesión detrás de cada
 * pantalla no se pierde caché estática que importara.
 *
 * `frame-ancestors 'none'` y `object-src 'none'` son gratis y cierran clickjacking y plugins.
 * `style-src 'unsafe-inline'` es necesario: Next inyecta estilos críticos inline y Tailwind los
 * genera en runtime; un nonce en `style-src` rompería el primer pintado sin ganar casi nada.
 */

/** Rutas que no son documentos: la API tiene su propio CSP, y los assets estáticos no lo necesitan. */
const BYPASS = [/^\/api(?:\/|$)/, /^\/_next\//, /^\/__nextjs/];

/** Un archivo con extensión nunca es un documento: manifest, service worker, imágenes, fuentes. */
const HAS_EXTENSION = /\.[a-z0-9]{2,5}$/i;

const DEV = process.env.NODE_ENV !== 'production';

/** Origen de la API cuando el navegador la llama directo (`api.partops.autos`). Vacío en local. */
const API_ORIGIN = (() => {
  const value = process.env.NEXT_PUBLIC_API_URL;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    // Una variable mal escrita no debe tumbar el CSP: se ignora y la web sigue por el rewrite.
    return null;
  }
})();

function buildPolicy(nonce: string): string {
  // En `next dev` el refresh en caliente usa `eval` y un websocket al propio servidor. Se relaja
  // solo ahí: relajarlo en producción por comodidad es exactamente cómo se acaba sin CSP.
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(DEV ? ["'unsafe-eval'"] : [])];
  const connectSrc = [
    "'self'",
    'https:',
    'wss:',
    // Explícito además de `https:`: deja la intención escrita para quien lea la política.
    ...(API_ORIGIN ? [API_ORIGIN] : []),
    ...(DEV ? ['ws:', 'http://localhost:*'] : []),
  ];

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://cdn.partops.autos https://*.r2.dev https://*.r2.cloudflarestorage.com",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self' https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(DEV ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (BYPASS.some((re) => re.test(pathname)) || HAS_EXTENSION.test(pathname)) {
    return NextResponse.next();
  }

  // UUID sin guiones: hexadecimal, que es subconjunto de base64 y cumple la gramática de nonce.
  // Evita `Buffer`/`btoa`, que no existen igual en todos los runtimes donde corre el proxy.
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const policy = buildPolicy(nonce);

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  // Next lee el nonce de aquí para sus scripts de hidratación.
  headers.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: [
    /*
     * Todo menos lo que ya se excluyó arriba, pero además se deja fuera del matcher lo que Next
     * resuelve sin ejecutar código (archivos con extensión). Duplicar la condición en el código y
     * en el matcher es a propósito: el matcher evita pagar el costo del proxy, y el código cubre
     * el caso de que alguien cambie el matcher sin mirar.
     */
    '/((?!api/|_next/|.*\\..*).*)',
  ],
};
