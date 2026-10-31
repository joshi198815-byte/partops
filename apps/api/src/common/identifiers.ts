import { z } from 'zod';

/** Alfabeto sin caracteres que se confunden al dictarlos por teléfono (0/O, 1/l/I). */
const HUMAN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function humanCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += HUMAN_ALPHABET[bytes[i]! % HUMAN_ALPHABET.length];
  return out;
}

/** Token de invitación: opaco, sin ambigüedad y con entropía suficiente para no adivinarse. */
export const inviteToken = () => `${humanCode(4)}-${humanCode(4)}-${humanCode(4)}`.toLowerCase();

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
  'r',
  'docs',
  'status',
]);

/** `Repuestos El Tornillo, S.A.` → `repuestos-el-tornillo`. Estable y legible en la URL pública. */
export function slugify(input: string): string {
  const base = input
    .normalize('NFD')
    // Marcas diacríticas sueltas: "Peña" → "Pena", no "Pea".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'negocio';
}

export function slugCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base;
  return `${base.slice(0, 36)}-${attempt + 1}`;
}

export const isReservedSlug = (slug: string) => RESERVED_SLUGS.has(slug);

/**
 * Teléfono guatemalteco. Se aceptan las formas en que llega de verdad: `5555-1234`,
 * `+502 5555 1234`, `50255551234`. Se normaliza a E.164 (`+50255551234`) porque es lo que necesita
 * el enlace de WhatsApp del recibo.
 */
export function normalizeGtPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const national = digits.startsWith('502') ? digits.slice(3) : digits;
  // Móvil GT: 8 dígitos que empiezan con 3, 4, 5 o 6. Fijo: empieza con 2 y también son 8.
  if (!/^[2-6]\d{7}$/.test(national)) return null;
  return `+502${national}`;
}

export const phoneSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const normalized = normalizeGtPhone(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Escribe un teléfono de Guatemala de 8 dígitos' });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * NIT guatemalteco. El dígito verificador no se valida aquí a propósito: hay negocios que lo
 * escriben mal desde hace años y rechazarlos en el registro es perder al cliente en el paso 1.
 * Se guarda tal cual, en mayúsculas y sin guiones, que es como lo pide la SAT.
 */
export const nitSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/[\s-]/g, ''))
  .refine((v) => v.length >= 6 && v.length <= 12, 'El NIT tiene entre 6 y 12 caracteres')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Solo minúsculas, números y guiones')
  .min(3, 'Al menos 3 caracteres')
  .max(40, 'Máximo 40 caracteres')
  .refine((v) => !isReservedSlug(v), 'Esa dirección está reservada');
