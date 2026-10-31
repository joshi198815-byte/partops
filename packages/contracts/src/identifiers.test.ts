import { describe, expect, it } from 'vitest';
import {
  formatGtPhone,
  humanCode,
  inviteToken,
  isReservedSlug,
  normalizeGtPhone,
  normalizeNit,
  slugCandidate,
  slugify,
} from './identifiers.js';
import { passwordSchema, phoneSchema, slugSchema, suggestSlug, utf8Length } from './onboarding.js';

describe('slugify', () => {
  it('quita acentos y signos sin comerse letras', () => {
    expect(slugify('Repuestos La Peña')).toBe('repuestos-la-pena');
    expect(slugify('AutoPartes Núñez & Hijos, S.A.')).toBe('autopartes-nunez-hijos-s-a');
  });

  it('nunca devuelve vacío', () => {
    expect(slugify('   ')).toBe('negocio');
    expect(slugify('¿?¡!')).toBe('negocio');
  });

  it('corta sin dejar guion al final', () => {
    const slug = slugify(`${'a'.repeat(50)} bbb`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('el candidato con intento cabe en el límite', () => {
    const candidate = slugCandidate('x'.repeat(40), 3);
    expect(candidate.length).toBeLessThanOrEqual(40);
    expect(candidate.endsWith('-4')).toBe(true);
  });
});

describe('slugs reservados', () => {
  it('bloquea rutas del producto', () => {
    expect(isReservedSlug('admin')).toBe(true);
    expect(isReservedSlug('onboarding')).toBe(true);
    expect(isReservedSlug('mi-bodega')).toBe(false);
  });

  it('el esquema del alta los rechaza', () => {
    expect(slugSchema.safeParse('admin').success).toBe(false);
    expect(slugSchema.safeParse('mi-bodega-2').success).toBe(true);
    expect(slugSchema.safeParse('Con Mayúsculas').success).toBe(false);
  });
});

describe('teléfono guatemalteco', () => {
  it('acepta las formas en que llega de verdad', () => {
    expect(normalizeGtPhone('5555-1234')).toBe('+50255551234');
    expect(normalizeGtPhone('+502 5555 1234')).toBe('+50255551234');
    expect(normalizeGtPhone('50255551234')).toBe('+50255551234');
    expect(normalizeGtPhone('(502) 5555-1234')).toBe('+50255551234');
  });

  it('acepta fijo además de móvil', () => {
    expect(normalizeGtPhone('2234-5678')).toBe('+50222345678');
  });

  it('rechaza lo que no es un número nacional', () => {
    expect(normalizeGtPhone('1234')).toBeNull();
    expect(normalizeGtPhone('15551234')).toBeNull();
    expect(normalizeGtPhone('5555123456')).toBeNull();
    expect(normalizeGtPhone('')).toBeNull();
  });

  it('formatea para pantalla', () => {
    expect(formatGtPhone('+50255551234')).toBe('5555-1234');
    expect(formatGtPhone(null)).toBe('');
  });

  it('el esquema del onboarding normaliza antes de guardar', () => {
    const parsed = phoneSchema.parse('5555 1234');
    expect(parsed).toBe('+50255551234');
    expect(phoneSchema.safeParse('123').success).toBe(false);
  });
});

describe('NIT', () => {
  it('normaliza a mayúsculas sin guiones', () => {
    expect(normalizeNit('1234-5678')).toBe('12345678');
    expect(normalizeNit('1234567-8')).toBe('12345678');
  });

  it('rechaza longitudes imposibles', () => {
    expect(normalizeNit('123')).toBeNull();
    expect(normalizeNit('1234567890123')).toBeNull();
  });
});

describe('tokens', () => {
  it('el código humano evita caracteres ambiguos', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = humanCode(8);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
  });

  it('las invitaciones no se repiten', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => inviteToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('contraseña', () => {
  it('cuenta bytes, no caracteres', () => {
    // 40 caracteres con acento son 80 bytes en UTF-8: bcrypt truncaría en 72 sin avisar.
    expect(utf8Length('á'.repeat(40))).toBe(80);
    expect(passwordSchema.safeParse('á'.repeat(40)).success).toBe(false);
    expect(passwordSchema.safeParse('contraseñaSegura1').success).toBe(true);
    expect(passwordSchema.safeParse('corta').success).toBe(false);
  });
});

describe('sugerencia de slug', () => {
  it('es la misma función que usa el servidor', () => {
    expect(suggestSlug('Repuestos El Tornillo')).toBe('repuestos-el-tornillo');
  });
});
