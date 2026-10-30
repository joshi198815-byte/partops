import { describe, expect, it } from 'vitest';
import { allocateProportionally, lineProfitCents, marginBps, splitTaxIncluded, toCents } from './money.js';

describe('toCents', () => {
  it('lee el formato guatemalteco con coma decimal', () => {
    expect(toCents('Q 1.250,50')).toBe(125050);
  });

  it('lee el formato con punto decimal y separador de miles', () => {
    expect(toCents('1,250.50')).toBe(125050);
  });

  it('acepta números directos', () => {
    expect(toCents(1250.5)).toBe(125050);
  });

  it('devuelve NaN cuando no hay número', () => {
    expect(toCents('')).toBeNaN();
    expect(toCents('sin precio')).toBeNaN();
    expect(toCents(null)).toBeNaN();
  });

  it('no pierde centavos por representación binaria', () => {
    expect(toCents('0.29')).toBe(29);
    expect(toCents('19.99')).toBe(1999);
  });
});

describe('allocateProportionally', () => {
  it('reparte sin perder centavos', () => {
    const parts = allocateProportionally(10000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(parts).toEqual([3334, 3333, 3333]);
  });

  it('respeta los pesos', () => {
    expect(allocateProportionally(1000, [3, 1])).toEqual([750, 250]);
  });

  it('reparte el residuo de mayor a menor fracción', () => {
    const parts = allocateProportionally(100, [1, 2, 3]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('no divide entre cero', () => {
    expect(allocateProportionally(1000, [0, 0])).toEqual([0, 0]);
  });
});

describe('splitTaxIncluded', () => {
  it('base más impuesto suman exactamente el total', () => {
    for (const total of [1, 999, 10000, 123457, 999999]) {
      const { subtotal, tax } = splitTaxIncluded(total, 1200);
      expect(subtotal + tax).toBe(total);
    }
  });

  it('desglosa un total con IVA 12%', () => {
    const { subtotal, tax } = splitTaxIncluded(11200, 1200);
    expect(subtotal).toBe(10000);
    expect(tax).toBe(1200);
  });

  it('sin impuesto devuelve todo como base', () => {
    expect(splitTaxIncluded(5000, 0)).toEqual({ subtotal: 5000, tax: 0, total: 5000 });
  });
});

describe('utilidad', () => {
  it('calcula utilidad por línea con costo congelado', () => {
    expect(lineProfitCents(15000, 9000, 3)).toBe(18000);
  });

  it('el margen se expresa en puntos base', () => {
    expect(marginBps(15000, 9000)).toBe(4000);
    expect(marginBps(0, 9000)).toBe(0);
  });

  it('una venta por debajo del costo da margen negativo', () => {
    expect(lineProfitCents(8000, 9000, 2)).toBe(-2000);
    expect(marginBps(8000, 9000)).toBe(-1250);
  });
});
