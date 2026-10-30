import { describe, expect, it } from 'vitest';
import {
  applicationKey,
  coversYear,
  formatApplication,
  parseYearRange,
  type VehicleApplication,
} from './vehicles.js';

const corolla: VehicleApplication = {
  brand: 'Toyota',
  model: 'Corolla',
  yearStart: 2009,
  yearEnd: 2013,
  engine: '1.8L',
};

describe('clave de aplicación', () => {
  it('ignora mayúsculas y espacios de más', () => {
    expect(applicationKey(corolla)).toBe(
      applicationKey({ ...corolla, brand: ' TOYOTA ', model: 'corolla ' }),
    );
  });

  it('distingue por motor', () => {
    expect(applicationKey(corolla)).not.toBe(applicationKey({ ...corolla, engine: '2.0L' }));
  });
});

describe('etiqueta', () => {
  it('muestra el rango de años y el motor', () => {
    expect(formatApplication(corolla)).toBe('Toyota Corolla 2009–2013 1.8L');
  });

  it('un solo año no repite el año', () => {
    expect(formatApplication({ ...corolla, yearStart: 2010, yearEnd: 2010, engine: null })).toBe(
      'Toyota Corolla 2010',
    );
  });
});

describe('coversYear', () => {
  it('incluye los extremos', () => {
    expect(coversYear(corolla, 2009)).toBe(true);
    expect(coversYear(corolla, 2013)).toBe(true);
  });

  it('excluye fuera de rango', () => {
    expect(coversYear(corolla, 2008)).toBe(false);
    expect(coversYear(corolla, 2014)).toBe(false);
  });
});

describe('parseYearRange', () => {
  it('lee un rango con guion', () => {
    expect(parseYearRange('2008-2012')).toEqual({ start: 2008, end: 2012 });
  });

  it('ordena años invertidos en lugar de descartar la fila', () => {
    expect(parseYearRange('2012 - 2008')).toEqual({ start: 2008, end: 2012 });
  });

  it('un año suelto cubre solo ese año', () => {
    expect(parseYearRange(2015)).toEqual({ start: 2015, end: 2015 });
  });

  it('lee años de dos dígitos', () => {
    expect(parseYearRange('09-13')).toEqual({ start: 2009, end: 2013 });
  });

  it('rechaza basura sin años válidos', () => {
    expect(parseYearRange('varios')).toBeNull();
    expect(parseYearRange('')).toBeNull();
    expect(parseYearRange(null)).toBeNull();
    expect(parseYearRange('1800')).toBeNull();
  });

  it('se queda con los años plausibles si el texto trae ruido', () => {
    expect(parseYearRange('Corolla 2009 al 2013')).toEqual({ start: 2009, end: 2013 });
  });
});
