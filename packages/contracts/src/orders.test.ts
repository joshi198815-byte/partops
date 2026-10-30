import { describe, expect, it } from 'vitest';
import {
  canTransitionLine,
  deriveOrderStatus,
  isOrderClosed,
  type LineStatus,
  nextAction,
} from './orders.js';

const line = (status: LineStatus, quantity = 1) => ({ status, quantity });

describe('transiciones de línea', () => {
  it('permite el camino normal', () => {
    expect(canTransitionLine('PENDIENTE', 'EN_PREPARACION')).toBe(true);
    expect(canTransitionLine('EN_PREPARACION', 'LISTO')).toBe(true);
    expect(canTransitionLine('LISTO', 'ENTREGADO')).toBe(true);
  });

  it('prohíbe saltarse la preparación', () => {
    expect(canTransitionLine('PENDIENTE', 'ENTREGADO')).toBe(false);
  });

  it('un entregado o cancelado es terminal', () => {
    expect(canTransitionLine('ENTREGADO', 'CANCELADO')).toBe(false);
    expect(canTransitionLine('CANCELADO', 'PENDIENTE')).toBe(false);
  });

  it('sin stock puede volver a pendiente cuando llega la pieza', () => {
    expect(canTransitionLine('SIN_STOCK', 'PENDIENTE')).toBe(true);
  });
});

describe('deriveOrderStatus', () => {
  it('pedido recién creado está en preparación', () => {
    expect(deriveOrderStatus([line('PENDIENTE'), line('PENDIENTE')])).toBe('EN_PREPARACION');
  });

  it('todo listo para entregar', () => {
    expect(deriveOrderStatus([line('LISTO'), line('LISTO')])).toBe('LISTO');
  });

  it('todo entregado', () => {
    expect(deriveOrderStatus([line('ENTREGADO'), line('ENTREGADO')])).toBe('ENTREGADO');
  });

  it('entregado con una línea cancelada es parcial, no completo', () => {
    expect(deriveOrderStatus([line('ENTREGADO'), line('CANCELADO')])).toBe('PARCIAL');
  });

  it('una línea entregada y otra en preparación sigue en preparación', () => {
    expect(deriveOrderStatus([line('ENTREGADO'), line('EN_PREPARACION')])).toBe('EN_PREPARACION');
  });

  it('surtido de dos bodegas: una lista, una sin stock', () => {
    expect(deriveOrderStatus([line('LISTO'), line('SIN_STOCK')])).toBe('ABIERTO');
  });

  it('todo sin stock es abierto: falta comprar', () => {
    expect(deriveOrderStatus([line('SIN_STOCK'), line('SIN_STOCK')])).toBe('ABIERTO');
  });

  it('todo cancelado', () => {
    expect(deriveOrderStatus([line('CANCELADO'), line('CANCELADO')])).toBe('CANCELADO');
  });

  it('sin líneas no inventa estado entregado', () => {
    expect(deriveOrderStatus([])).toBe('ABIERTO');
  });
});

describe('cierre y siguiente acción', () => {
  it('entregado y cancelado están cerrados', () => {
    expect(isOrderClosed('ENTREGADO')).toBe(true);
    expect(isOrderClosed('CANCELADO')).toBe(true);
    expect(isOrderClosed('PARCIAL')).toBe(false);
  });

  it('cada estado abierto sugiere una acción con su permiso', () => {
    expect(nextAction('EN_PREPARACION')?.permission).toBe('orders.dispatch');
    expect(nextAction('LISTO')?.label).toContain('entregado');
    expect(nextAction('ENTREGADO')).toBeNull();
  });
});
