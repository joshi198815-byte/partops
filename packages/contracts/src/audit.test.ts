import { describe, expect, it } from 'vitest';
import { actionLabel, auditQuerySchema, entityLabel } from './audit.js';

describe('auditoría: filtros y etiquetas', () => {
  it('el rango invertido se rechaza con un mensaje que se entiende', () => {
    const result = auditQuerySchema.safeParse({ from: '2026-10-30', to: '2026-10-01' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('La fecha inicial va antes de la final');
  });

  it('sin filtros aplica los valores por omisión', () => {
    const parsed = auditQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it('un rango válido pasa', () => {
    expect(auditQuerySchema.safeParse({ from: '2026-10-01', to: '2026-10-30' }).success).toBe(true);
  });

  it('las acciones conocidas se traducen y las nuevas se muestran crudas', () => {
    expect(actionLabel('finance.expense_created')).toBe('Gasto registrado');
    expect(actionLabel('algo.nuevo')).toBe('algo.nuevo');
  });

  it('las entidades conocidas se traducen', () => {
    expect(entityLabel('part_variant')).toBe('Variante');
    expect(entityLabel('desconocida')).toBe('desconocida');
  });
});
