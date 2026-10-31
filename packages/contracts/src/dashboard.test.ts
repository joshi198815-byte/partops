import { describe, expect, it } from 'vitest';
import { canSeeSales } from './dashboard.js';

describe('tablero: qué se ve y qué no', () => {
  it('sin finance.view no se ven las ventas del día', () => {
    expect(canSeeSales(['dashboard.view', 'inventory.view'])).toBe(false);
  });

  it('con finance.view sí', () => {
    expect(canSeeSales(['finance.view'])).toBe(true);
  });
});
