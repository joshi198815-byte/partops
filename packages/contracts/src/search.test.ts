import { describe, expect, it } from 'vitest';
import {
  editDistance,
  extractPartCodes,
  normalizeQuery,
  normalizeYear,
  parsePartQuery,
  tokenize,
  toTsQuery,
  type VehicleVocabulary,
} from './search.js';

const VOCAB: VehicleVocabulary = {
  brands: ['Toyota', 'Nissan', 'Mazda', 'Mitsubishi', 'Hyundai', 'Kia', 'Chevrolet', 'Honda', 'Suzuki'],
  models: [
    { name: 'Corolla', brand: 'Toyota' },
    { name: 'Hilux', brand: 'Toyota' },
    { name: 'Yaris', brand: 'Toyota' },
    { name: 'Sentra', brand: 'Nissan' },
    { name: 'Frontier', brand: 'Nissan' },
    { name: 'CX-5', brand: 'Mazda' },
    { name: 'L200', brand: 'Mitsubishi' },
    { name: 'Accent', brand: 'Hyundai' },
    { name: 'Sportage', brand: 'Kia' },
  ],
  categories: ['Capo', 'Faro', 'Defensa', 'Amortiguador', 'Pastillas', 'Radiador', 'Filtro'],
};

describe('normalización', () => {
  it('quita tildes y signos', () => {
    expect(normalizeQuery('Capó Toyota Corolla (2009)')).toBe('capo toyota corolla 2009');
  });

  it('colapsa espacios extra', () => {
    expect(tokenize('  capo   toyota  ')).toEqual(['capo', 'toyota']);
  });

  it('normaliza guiones a espacio', () => {
    expect(normalizeQuery('bomba-de-agua')).toBe('bomba de agua');
  });
});

describe('años', () => {
  it('acepta cuatro dígitos en rango', () => {
    expect(normalizeYear('2009')).toBe(2009);
  });

  it('resuelve dos dígitos al siglo del vehículo', () => {
    expect(normalizeYear('09')).toBe(2009);
    expect(normalizeYear('98')).toBe(1998);
  });

  it('rechaza lo que no es año de carro', () => {
    expect(normalizeYear('1930')).toBeNull();
    expect(normalizeYear('3000')).toBeNull();
    expect(normalizeYear('abc')).toBeNull();
  });
});

describe('distancia de edición', () => {
  it('mide erratas de una letra', () => {
    expect(editDistance('corola', 'corolla')).toBe(1);
    expect(editDistance('faro', 'faro')).toBe(0);
  });

  it('corta temprano cuando la diferencia es grande', () => {
    expect(editDistance('radiador', 'defensa', 2)).toBeGreaterThan(2);
  });
});

describe('parsePartQuery', () => {
  it('extrae pieza, marca, modelo y año', () => {
    const r = parsePartQuery('capo toyota corolla 2009', VOCAB);
    expect(r.brand).toBe('Toyota');
    expect(r.model).toBe('Corolla');
    expect(r.year).toBe(2009);
    expect(r.term).toBe('capo');
    // "capo" es la forma canónica: no hubo sinónimo que normalizar, aunque sí sea un término
    // reconocido del vocabulario de piezas.
    expect(r.termFromSynonym).toBe(false);
  });

  it('funciona sin marca: la infiere del modelo', () => {
    const r = parsePartQuery('faro corolla 2009', VOCAB);
    expect(r.model).toBe('Corolla');
    expect(r.brand).toBe('Toyota');
    expect(r.term).toBe('faro');
  });

  it('tolera errata en el modelo y la sugiere', () => {
    const r = parsePartQuery('capo toyota corola 2009', VOCAB);
    expect(r.model).toBeNull();
    expect(r.suggestions).toContain('corolla');
    expect(r.term).toBe('capo');
  });

  /**
   * La corrección se ofrece, no se aplica sola. Pero quien la acepte tiene que poder reescribir
   * **solo** la palabra mal escrita: si la interfaz adivinara cuál era, «capo corola 2009» podría
   * terminar como «corolla» y perder la pieza y el año. El parser es el único que sabe cuál era.
   */
  it('dice de qué palabra salió cada sugerencia, para reescribir solo esa', () => {
    const r = parsePartQuery('capo corola 2009', VOCAB);
    expect(r.suggestionFixes).toContainEqual({ from: 'corola', to: 'corolla' });
    // Nunca sugiere sobre el año ni sobre la pieza: solo sobre vehículos.
    expect(r.suggestionFixes.every((f) => f.from !== '2009' && f.from !== 'capo')).toBe(true);
  });

  it('canoniza sinónimos del habla local', () => {
    expect(parsePartQuery('cubierta nissan sentra 2015', VOCAB).term).toBe('capo');
    expect(parsePartQuery('balatas kia sportage', VOCAB).term).toBe('pastillas');
  });

  it('no marca como sinónimo una palabra que ya es la canónica', () => {
    // "capo" es la forma normal: decir que se "normalizó un sinónimo" sería inventar un cambio.
    expect(parsePartQuery('capo toyota corolla 2009', VOCAB).termFromSynonym).toBe(false);
    expect(parsePartQuery('cubierta toyota corolla 2009', VOCAB).termFromSynonym).toBe(true);
  });

  it('un modelo no se casa con la marca equivocada', () => {
    const r = parsePartQuery('faro nissan corolla', VOCAB);
    expect(r.brand).toBe('Nissan');
    expect(r.model).toBeNull();
  });

  it('respeta modelos con guion', () => {
    const r = parsePartQuery('amortiguador mazda cx 5 2018', VOCAB);
    expect(r.brand).toBe('Mazda');
    expect(r.year).toBe(2018);
  });

  it('no se traga un número que no es año', () => {
    const r = parsePartQuery('filtro aceite toyota hilux', VOCAB);
    expect(r.year).toBeNull();
  });

  it('conserva calificadores que no son vehículo', () => {
    const r = parsePartQuery('pastillas delanteras toyota corolla', VOCAB);
    expect(r.term).toBe('pastillas delanteras');
    expect(r.brand).toBe('Toyota');
  });

  it('consulta solo de código no inventa marca ni año', () => {
    const r = parsePartQuery('04465-0K290', VOCAB);
    expect(r.brand).toBeNull();
    expect(r.model).toBeNull();
    expect(r.year).toBeNull();
  });

  it('texto vacío no rompe', () => {
    const r = parsePartQuery('   ', VOCAB);
    expect(r.term).toBe('');
    expect(r.free).toEqual([]);
  });
});

describe('toTsQuery', () => {
  it('arma prefijos unidos por AND', () => {
    expect(toTsQuery('pastillas delanteras')).toBe('pastillas:* & delanteras:*');
  });

  it('descarta tokens de una letra', () => {
    expect(toTsQuery('faro a b')).toBe('faro:*');
  });

  it('neutraliza operadores inyectados', () => {
    expect(toTsQuery('faro & !capo')).toBe('faro:* & capo:*');
  });

  it('sin tokens útiles devuelve null', () => {
    expect(toTsQuery('  ')).toBeNull();
  });
});

describe('extractPartCodes', () => {
  it('conserva un OEM con guion y lo deja comparable', () => {
    expect(extractPartCodes('04465-0K290')).toContain('044650K290');
  });

  it('encuentra el OEM aunque venga con espacio en vez de guion', () => {
    expect(extractPartCodes('04465 0k290')).toContain('044650K290');
  });

  it('encuentra el código dentro de una frase', () => {
    expect(extractPartCodes('pastillas 04465-0K290 toyota')).toContain('044650K290');
  });

  it('no confunde un año con un código', () => {
    expect(extractPartCodes('capo corolla 2009')).toEqual([]);
  });

  it('descarta palabras sin dígitos', () => {
    expect(extractPartCodes('capo toyota corolla')).toEqual([]);
  });

  it('descarta fragmentos demasiado cortos para ser un código', () => {
    expect(extractPartCodes('ab12')).toEqual([]);
  });

  it('quita repetidos y limita la cantidad', () => {
    const codes = extractPartCodes('04465-0K290 04465-0K290 12345 67890 11111 22222 33333 44444');
    expect(codes).toHaveLength(6);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
