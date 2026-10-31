import { describe, expect, it } from 'vitest';
import * as cart from './storefront-cart';

/**
 * Carrito de la vitrina.
 *
 * Se prueba sin navegador: lo que importa es la aritmética y los topes, que son las reglas que el
 * servidor va a volver a comprobar. La persistencia en `sessionStorage` es un detalle de transporte.
 */

function part(overrides: Partial<Parameters<typeof cart.addLine>[1]> = {}) {
  return {
    id: 'p1',
    slug: 'filtro',
    name: 'Filtro de aceite',
    brand: 'Toyota',
    category: 'Filtros',
    condition: 'NUEVO' as const,
    unit: 'u',
    warrantyDays: 90,
    imageUrl: null,
    imageFallbackUrl: null,
    imageWidth: null,
    imageHeight: null,
    priceMinCents: 10_000,
    priceMaxCents: 12_000,
    availability: 'HAY' as const,
    vehicles: [],
    variants: [],
    ...overrides,
  };
}

function variant(id: string, priceCents = 10_000, purchasable = true) {
  return {
    id,
    sku: `SKU-${id}`,
    title: id,
    partNumber: null,
    oemNumbers: [],
    priceCents,
    availability: [
      { warehouseName: 'Central', bucket: purchasable ? ('HAY' as const) : ('AGOTADO' as const) },
    ],
    purchasable,
  };
}

describe('carrito', () => {
  it('suma cantidades del mismo variant en vez de duplicar la línea', () => {
    const first = cart.addLine([], part(), variant('a'));
    const second = cart.addLine(first.lines, part(), variant('a'));
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]?.quantity).toBe(2);
  });

  it('respeta el tope por pieza y lo dice', () => {
    let lines = cart.addLine([], part(), variant('a')).lines;
    for (let i = 0; i < 30; i += 1) lines = cart.addLine(lines, part(), variant('a')).lines;
    expect(lines[0]?.quantity).toBe(20);
    const capped = cart.addLine(lines, part(), variant('a'));
    expect(capped.message).toMatch(/Máximo 20/);
  });

  it('no agrega una pieza agotada y avisa', () => {
    const result = cart.addLine([], part(), variant('a', 10_000, false));
    expect(result.lines).toHaveLength(0);
    expect(result.message).toMatch(/agotó/i);
  });

  it('corta en diez piezas distintas por pedido', () => {
    let lines = cart.addLine([], part(), variant('v1')).lines;
    for (let i = 2; i <= 10; i += 1) lines = cart.addLine(lines, part(), variant(`v${i}`)).lines;
    const extra = cart.addLine(lines, part(), variant('v11'));
    expect(extra.lines).toHaveLength(10);
    expect(extra.message).toMatch(/10 piezas distintas/);
  });

  it('el total y el conteo son la suma real del carrito', () => {
    const lines = cart.addLine(
      cart.addLine([], part(), variant('a', 12_500)).lines,
      part(),
      variant('b', 3_000),
    ).lines;
    expect(cart.cartCount(lines)).toBe(2);
    expect(cart.cartTotal(lines)).toBe(15_500);
  });

  it('cantidad cero quita la línea', () => {
    const lines = cart.addLine([], part(), variant('a')).lines;
    expect(cart.setQuantity(lines, 'a', 0)).toHaveLength(0);
  });

  it('la clave de idempotencia tiene largo suficiente para el esquema', () => {
    const key = cart.newOrderKey();
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(120);
    expect(cart.newOrderKey()).not.toBe(key);
  });
});
