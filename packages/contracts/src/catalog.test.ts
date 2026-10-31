import { describe, expect, it } from 'vitest';
import {
  compatibilityRangeSchema,
  imageUploadProblem,
  MAX_IMAGE_BYTES,
  normalizeOemList,
  normalizePartCode,
  normalizeSku,
  partCreateSchema,
  partSlug,
  partSlugCandidate,
  partVariantInputSchema,
} from './catalog.js';

/**
 * Lo que se prueba aquí es lo que se rompe en silencio: dos códigos que parecen distintos y son el
 * mismo, un SKU con espacio que crea una segunda variante, un slug que cambia y rompe un enlace ya
 * enviado. Ninguno de estos fallos lanza un error en producción; todos cuestan dinero.
 */
describe('normalización de códigos', () => {
  it('el guion y el espacio no hacen dos códigos distintos', () => {
    expect(normalizePartCode('04465-0K290')).toBe(normalizePartCode('04465 0k290'));
    expect(normalizePartCode(' 53301-02330 ')).toBe('5330102330');
  });

  it('el SKU se guarda en mayúsculas, con guion y sin basura', () => {
    expect(normalizeSku('cap cor 0913')).toBe('CAP-COR-0913');
    // El acento no desaparece con la letra: "capó#0913" es CAPO-0913, no CAP-0913.
    expect(normalizeSku(' capó#0913 ')).toBe('CAPO-0913');
    expect(normalizeSku('A--B')).toBe('A-B');
  });

  it('la lista OEM deduplica por forma comparable y descarta basura del Excel', () => {
    const list = normalizeOemList('04465-0K290, 044650K290; N/A | 26010-ET000');
    // El mismo código escrito distinto se guarda una sola vez, con la forma de la primera aparición.
    expect(list).toEqual(['04465-0K290', '26010-ET000']);
  });

  it('acepta también un arreglo y recorta los espacios internos', () => {
    expect(normalizeOemList(['04465 0K290', ''])).toEqual(['044650K290']);
  });
});

describe('slug de la pieza', () => {
  it('quita tildes y signos', () => {
    expect(partSlug('Capó delantero derecho')).toBe('capo-delantero-derecho');
    expect(partSlug('Faro  izquierdo / 2019')).toBe('faro-izquierdo-2019');
  });

  it('el segundo intento anexa el número y respeta el límite', () => {
    expect(partSlugCandidate('capo', 1)).toBe('capo-2');
    const long = 'a'.repeat(60);
    expect(partSlugCandidate(long, 3).length).toBeLessThanOrEqual(60);
  });
});

describe('validación de imagen', () => {
  it('rechaza más de 8 MB y formatos que sharp no procesa aquí', () => {
    expect(imageUploadProblem({ size: MAX_IMAGE_BYTES + 1, mimetype: 'image/jpeg' })).toContain('8 MB');
    expect(imageUploadProblem({ size: 1024, mimetype: 'image/gif' })).toContain('Formato');
    expect(imageUploadProblem({ size: 0, mimetype: 'image/png' })).toContain('vacío');
    expect(imageUploadProblem({ size: 1024, mimetype: 'image/jpeg' })).toBeNull();
  });
});

describe('esquemas de entrada', () => {
  it('el precio se escribe como en el mostrador y se guarda en centavos', () => {
    const parsed = partVariantInputSchema.parse({ sku: 'cap 0913', price: 'Q 1,850.50' });
    expect(parsed.price).toBe(185050);
    expect(parsed.sku).toBe('CAP-0913');
  });

  it('un monto ilegible falla con mensaje, no con NaN', () => {
    const result = partVariantInputSchema.safeParse({ sku: 'X1', price: 'mil pesos' });
    expect(result.success).toBe(false);
  });

  it('una pieza sin variantes no pasa: no se puede vender lo que no tiene precio', () => {
    const result = partCreateSchema.safeParse({ name: 'Capó', variants: [] });
    expect(result.success).toBe(false);
  });

  it('el rango de años invertido se rechaza con un mensaje entendible', () => {
    const result = compatibilityRangeSchema.safeParse({
      brand: 'Toyota',
      model: 'Corolla',
      yearStart: 2013,
      yearEnd: 2009,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('año inicial');
  });
});
