import { describe, expect, it } from 'vitest';
import { MULTI_LOCATION_PRICE_CENTS, nextPlan, PLANS, planSpec, usageLabel } from './plans.js';
import { PLAN_TIERS } from './platform.js';

describe('planes', () => {
  it('el gratis es cero y los de pago suben en orden', () => {
    expect(PLANS.FREE.priceCentsPerMonth).toBe(0);
    expect(PLANS.PRO.priceCentsPerMonth).toBe(19_900);
    expect(PLANS.TALLER.priceCentsPerMonth).toBe(39_900);
    expect(PLANS.TALLER.priceCentsPerMonth).toBeGreaterThan(PLANS.PRO.priceCentsPerMonth);
  });

  it('un tier nulo o desconocido cae en FREE, nunca revienta', () => {
    expect(planSpec(null).tier).toBe('FREE');
    expect(planSpec(undefined).tier).toBe('FREE');
    expect(planSpec('CADENA').tier).toBe('FREE');
    expect(planSpec('pro').tier).toBe('FREE');
  });

  it('los topes no bajan al subir de plan', () => {
    expect(PLANS.FREE.limits.parts).toBe(150);
    expect(PLANS.PRO.limits.parts).toBe(2_000);
    expect(PLANS.TALLER.limits.parts).toBeNull();
    // FREE incluye al dueño y un empleado: con un solo lugar, el paso «invita a tu equipo» del
    // alta no tendría a quién invitar y el plan gratis arrancaría sin poder venderse solo.
    expect(PLANS.FREE.limits.members).toBeGreaterThanOrEqual(2);
    expect(PLANS.PRO.limits.members).toBeGreaterThan(PLANS.FREE.limits.members!);
    expect(PLANS.TALLER.limits.members).toBeGreaterThan(PLANS.PRO.limits.members!);
  });

  it('solo de PRO en adelante se publica el catálogo y se exporta', () => {
    expect(PLANS.FREE.limits.publicCatalog).toBe(false);
    expect(PLANS.PRO.limits.publicCatalog).toBe(true);
    expect(PLANS.TALLER.limits.publicCatalog).toBe(true);
    expect(PLANS.FREE.limits.exportData).toBe(false);
    expect(PLANS.PRO.limits.exportData).toBe(true);
  });

  it('el siguiente plan es el que se le ofrece a quien se topó', () => {
    expect(nextPlan('FREE')?.tier).toBe('PRO');
    expect(nextPlan('PRO')?.tier).toBe('TALLER');
    expect(nextPlan('TALLER')).toBeNull();
    expect(nextPlan(null)?.tier).toBe('PRO');
  });

  it('la etiqueta de uso dice el tope, y "sin tope" cuando no hay', () => {
    expect(usageLabel(1420, 2000, 'piezas')).toBe('1,420 de 2,000 piezas');
    expect(usageLabel(0, 150, 'piezas')).toBe('0 de 150 piezas');
    expect(usageLabel(1420, null, 'piezas')).toBe('1,420 piezas · sin tope');
  });

  /**
   * El precio multi-sucursal está anunciado en `/planes` como «cuando exista». No es un plan y no
   * debe confundirse con uno: si alguien lo metiera en `PLANS` sin el modelo que lo sostiene, la
   * página cobraría un catálogo separado por sucursal que el código no entrega.
   */
  it('el precio multi-sucursal se anuncia por encima de Cadena y no es un tier', () => {
    expect(MULTI_LOCATION_PRICE_CENTS).toBeGreaterThan(PLANS.TALLER.priceCentsPerMonth);
    expect(PLAN_TIERS).toHaveLength(3);
    expect(PLAN_TIERS).not.toContain('MULTI_SUCURSAL' as never);
  });
});
