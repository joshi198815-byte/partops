import { describe, expect, it } from 'vitest';
import { PLAN_TIERS, planActive, planGrantSchema, planLabel } from './platform.js';

describe('plan de plataforma', () => {
  it('no acepta un vencimiento en el pasado', () => {
    const parsed = planGrantSchema.safeParse({
      tier: 'PRO',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('La fecha de vencimiento ya pasó');
  });

  it('sin vencimiento es un plan válido', () => {
    const parsed = planGrantSchema.parse({ tier: 'TALLER', expiresAt: null });
    expect(parsed).toEqual({ tier: 'TALLER', expiresAt: null });
  });

  it('default de vencimiento es null, no fecha inventada', () => {
    expect(planGrantSchema.parse({ tier: 'FREE' }).expiresAt).toBeNull();
  });

  it('solo conoce los tres niveles de v1', () => {
    expect(planGrantSchema.safeParse({ tier: 'ENTERPRISE' }).success).toBe(false);
    expect(PLAN_TIERS).toEqual(['FREE', 'PRO', 'TALLER']);
  });

  it('un plan sin fecha no vence; uno con fecha pasada sí', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    expect(planActive(null, now)).toBe(true);
    expect(planActive('2026-10-29T12:00:00.000Z', now)).toBe(false);
    expect(planActive('2026-11-30T12:00:00.000Z', now)).toBe(true);
  });

  it('la etiqueta cae al valor guardado si no es un nivel conocido', () => {
    expect(planLabel('PRO')).toBe('PRO');
    expect(planLabel(null)).toBe('Sin plan');
    expect(planLabel('LEGACY')).toBe('LEGACY');
  });
});
