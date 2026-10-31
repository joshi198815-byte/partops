/**
 * Identificadores que se escriben a mano o se dictan por teléfono.
 *
 * Viven en `contracts` y no en la API porque la web los necesita para lo mismo: previsualizar el
 * slug mientras se escribe el nombre del negocio, validar el teléfono antes de enviarlo y armar el
 * enlace de invitación. Dos implementaciones de "qué es un teléfono guatemalteco válido" acaban
 * discrepando, y la discrepancia se descubre cuando un cliente no puede registrarse.
 */

/**
 * Alfabeto sin caracteres que se confunden al dictarlos (0/O, 1/l/I).
 *
 * `crypto.getRandomValues` existe tanto en Node 18+ como en el navegador, así que el mismo código
 * sirve en la API y en la web sin `import` de `node:crypto`.
 */
const HUMAN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function humanCode(length = 8): string {
  const bytes = new Uint8Array(length);
  const webCrypto = (globalThis as unknown as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } })
    .crypto;
  webCrypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += HUMAN_ALPHABET[bytes[i]! % HUMAN_ALPHABET.length];
  return out;
}

/** Token de invitación: opaco, dictable y con entropía de sobra para no adivinarse. */
export const inviteToken = () => `${humanCode(4)}-${humanCode(4)}-${humanCode(4)}`.toLowerCase();

/**
 * Slugs que no pueden ser de un negocio: chocan con rutas del producto o con subdominios de
 * infraestructura. Sin esta lista, un cliente puede reclamar `admin` y quedarse con una URL que
 * parece del sistema.
 */
const RESERVED_SLUGS = new Set([
  'app',
  'api',
  'admin',
  'auth',
  'login',
  'signup',
  'registro',
  'recuperar',
  'catalogo',
  'catalog',
  'blog',
  'ayuda',
  'soporte',
  'facturacion',
  'precios',
  'www',
  'static',
  'assets',
  'health',
  'onboarding',
  'invitacion',
  'recibo',
  'docs',
  'status',
  'mail',
  'cdn',
]);

/** `Repuestos El Tornillo, S.A.` → `repuestos-el-tornillo`. Legible en la URL pública. */
export function slugify(input: string): string {
  const base = input
    .normalize('NFD')
    // Marcas diacríticas sueltas: "Peña" → "pena", no "pea".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'negocio';
}

/** Segundo intento en adelante: `repuestos-tornillo-2`, `-3`… */
export function slugCandidate(base: string, attempt: number): string {
  if (attempt <= 0) return base;
  return `${base.slice(0, 36).replace(/-+$/g, '')}-${attempt + 1}`;
}

export const isReservedSlug = (slug: string) => RESERVED_SLUGS.has(slug);

/**
 * Teléfono guatemalteco a E.164.
 *
 * Se aceptan las formas en que llega de verdad: `5555-1234`, `+502 5555 1234`, `50255551234`.
 * Devuelve `+50255551234`, que es lo que necesita el enlace de WhatsApp del recibo: `wa.me`
 * exige el país y no acepta guiones.
 */
export function normalizeGtPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const national = digits.startsWith('502') && digits.length > 8 ? digits.slice(3) : digits;
  // Móvil GT empieza con 3–6; fijo con 2. Ambos son 8 dígitos.
  if (!/^[2-6]\d{7}$/.test(national)) return null;
  return `+502${national}`;
}

/** `+50255551234` → `5555-1234`, para mostrar en pantalla. */
export function formatGtPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const national = e164.replace(/\D/g, '').replace(/^502/, '');
  return national.length === 8 ? `${national.slice(0, 4)}-${national.slice(4)}` : e164;
}

/**
 * El NIT no se valida con dígito verificador: hay negocios que lo escriben mal desde hace años y
 * rechazarlos en el registro es perder al cliente en el primer paso. Se normaliza a mayúsculas sin
 * guiones, que es como lo pide la SAT.
 */
export function normalizeNit(raw: string): string | null {
  const value = raw.toUpperCase().replace(/[\s-]/g, '');
  if (!value) return null;
  return value.length >= 6 && value.length <= 12 ? value : null;
}
