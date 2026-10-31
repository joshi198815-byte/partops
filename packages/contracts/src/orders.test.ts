import { describe, expect, it } from 'vitest';
import {
  canTransitionLine,
  deriveOrderStatus,
  isOrderClosed,
  type LineStatus,
  lineHoldsReservation,
  nextAction,
  orderCode,
  orderTotals,
  spreadDiscount,
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

describe('reserva viva por línea', () => {
  it('pendiente, en preparación y listo tienen pieza apartada', () => {
    expect(lineHoldsReservation('PENDIENTE')).toBe(true);
    expect(lineHoldsReservation('EN_PREPARACION')).toBe(true);
    expect(lineHoldsReservation('LISTO')).toBe(true);
  });

  it('entregado, sin stock y cancelado no apartan nada', () => {
    expect(lineHoldsReservation('ENTREGADO')).toBe(false);
    expect(lineHoldsReservation('SIN_STOCK')).toBe(false);
    expect(lineHoldsReservation('CANCELADO')).toBe(false);
  });
});

describe('folio y totales', () => {
  it('el folio se rellena a cuatro dígitos y conserva el prefijo del negocio', () => {
    expect(orderCode('PD', 1)).toBe('PD-0001');
    expect(orderCode('FV', 1234)).toBe('FV-1234');
    expect(orderCode('PD', 12345)).toBe('PD-12345');
  });

  it('el IVA se desglosa por diferencia: base + impuesto es exactamente el total', () => {
    const t = orderTotals([{ quantity: 3, unitPriceCents: 33_333, discountCents: 0 }], 1200);
    expect(t.totalCents).toBe(99_999);
    expect(t.subtotalCents + t.taxCents).toBe(t.totalCents);
    expect(t.taxCents).toBe(99_999 - t.subtotalCents);
  });

  it('sin impuesto el subtotal es el total', () => {
    const t = orderTotals([{ quantity: 1, unitPriceCents: 10_000, discountCents: 0 }], 0);
    expect(t).toEqual({ totalCents: 10_000, subtotalCents: 10_000, taxCents: 0, discountCents: 0 });
  });

  it('el descuento de cabecera se reparte sin perder ni inventar un centavo', () => {
    const parts = spreadDiscount([100, 100, 100], 1_000);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_000);
    expect(parts.every((p) => Number.isInteger(p))).toBe(true);
  });

  it('un pedido sin líneas no inventa total', () => {
    expect(orderTotals([], 1200).totalCents).toBe(0);
  });
});
