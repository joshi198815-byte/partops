import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DEFAULT_ROLES, isPermission, OWNER_ROLE, staffHomePath } from './permissions.js';

const role = (key: string) => {
  const r = DEFAULT_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(`rol inexistente: ${key}`);
  return r;
};

describe('catálogo de permisos', () => {
  it('no hay permisos duplicados entre grupos', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('valida permisos conocidos y rechaza inventados', () => {
    expect(isPermission('orders.dispatch')).toBe(true);
    expect(isPermission('orders.hack')).toBe(false);
    expect(isPermission('')).toBe(false);
  });

  it('el propietario tiene todo', () => {
    expect(new Set(role(OWNER_ROLE).permissions)).toEqual(new Set(ALL_PERMISSIONS));
  });
});

describe('roles base', () => {
  it('el vendedor no ve costos ni ajusta existencias', () => {
    const v = role('vendedor').permissions;
    expect(v).not.toContain('finance.cost.view');
    expect(v).not.toContain('catalog.cost.view');
    expect(v).not.toContain('inventory.adjust');
    expect(v).toContain('orders.create');
  });

  it('el bodeguero despacha pero no vende ni ve finanzas', () => {
    const b = role('bodeguero').permissions;
    expect(b).toContain('orders.dispatch');
    expect(b).not.toContain('orders.create');
    expect(b).not.toContain('finance.view');
  });

  it('solo el propietario gestiona facturación', () => {
    const conBilling = DEFAULT_ROLES.filter((r) => r.permissions.includes('billing.manage'));
    expect(conBilling.map((r) => r.key)).toEqual([OWNER_ROLE]);
  });

  it('ningún rol base queda vacío ni con permisos repetidos', () => {
    for (const r of DEFAULT_ROLES) {
      expect(r.permissions.length).toBeGreaterThan(0);
      expect(new Set(r.permissions).size).toBe(r.permissions.length);
    }
  });
});

describe('staffHomePath', () => {
  it('el propietario arranca en el tablero', () => {
    expect(staffHomePath([OWNER_ROLE], role(OWNER_ROLE).permissions)).toBe('/app');
  });

  it('el bodeguero arranca en despacho', () => {
    expect(staffHomePath(['bodeguero'], role('bodeguero').permissions)).toBe('/app/despacho');
  });

  it('el vendedor arranca en ventas', () => {
    expect(staffHomePath(['vendedor'], role('vendedor').permissions)).toBe('/app/ventas');
  });

  it('quien solo tiene dashboard cae en el tablero', () => {
    expect(staffHomePath(['raro'], ['dashboard.view'])).toBe('/app');
  });

  it('sin permisos no revienta', () => {
    expect(staffHomePath([], [])).toBe('/app');
  });
});
