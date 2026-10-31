import {
  PUBLIC_ORDER_MAX_ITEMS,
  PUBLIC_ORDER_MAX_QUANTITY,
  type PublicCatalogItem,
  type PublicVariant,
} from '@partops/contracts';

/**
 * Carrito de la vitrina.
 *
 * Vive en `sessionStorage`, no en el servidor: el visitante no tiene cuenta y no debería tener que
 * crearla para juntar dos piezas. Se guarda solo lo que la API necesita para armar el pedido
 * (`variantId` y cantidad) más lo justo para pintarlo sin volver a pedir el catálogo; el precio
 * definitivo lo congela el servidor al crear el pedido.
 *
 * `sessionStorage` y no `localStorage`: el carrito de una visita no debe reaparecer tres días
 * después con precios que ya cambiaron y una pieza que se vendió.
 */

const KEY = 'partops.cart.v1';

export interface CartLine {
  variantId: string;
  partSlug: string;
  partName: string;
  variantTitle: string;
  sku: string;
  priceCents: number;
  quantity: number;
  /** Disponibilidad al momento de agregar: se muestra en el carrito, no se usa para validar. */
  bucket: 'HAY' | 'POCAS' | 'AGOTADO';
}

function read(): CartLine[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (line): line is CartLine =>
        typeof line === 'object' &&
        line !== null &&
        typeof (line as CartLine).variantId === 'string' &&
        Number.isInteger((line as CartLine).quantity) &&
        (line as CartLine).quantity > 0,
    );
  } catch {
    return [];
  }
}

function write(lines: CartLine[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Modo privado con cuota llena: el carrito se pierde al cambiar de página, pero la compra sigue.
  }
}

export function loadCart(): CartLine[] {
  return read();
}

export function cartCount(lines: CartLine[]): number {
  return lines.reduce((n, l) => n + l.quantity, 0);
}

export function cartTotal(lines: CartLine[]): number {
  return lines.reduce((n, l) => n + l.priceCents * l.quantity, 0);
}

/** Une la variante al carrito respetando el tope por pieza y el tope de piezas distintas. */
export function addLine(
  lines: CartLine[],
  part: PublicCatalogItem,
  variant: PublicVariant,
  quantity = 1,
): { lines: CartLine[]; message: string | null } {
  const bucket = variant.availability.reduce<'HAY' | 'POCAS' | 'AGOTADO'>(
    (best, a) => (RANK[a.bucket] > RANK[best] ? a.bucket : best),
    'AGOTADO',
  );
  if (!variant.purchasable) return { lines, message: 'Esa pieza se agotó. Escríbenos por WhatsApp.' };

  const existing = lines.find((l) => l.variantId === variant.id);
  if (!existing && lines.length >= PUBLIC_ORDER_MAX_ITEMS) {
    return {
      lines,
      message: `Un pedido lleva hasta ${PUBLIC_ORDER_MAX_ITEMS} piezas distintas. Ciérralo y hacemos otro.`,
    };
  }

  const current = existing?.quantity ?? 0;
  const next = Math.min(current + quantity, PUBLIC_ORDER_MAX_QUANTITY);
  const capped = next === current;
  const updated: CartLine[] = existing
    ? lines.map((l) => (l.variantId === variant.id ? { ...l, quantity: next } : l))
    : [
        ...lines,
        {
          variantId: variant.id,
          partSlug: part.slug,
          partName: part.name,
          variantTitle: variant.title,
          sku: variant.sku,
          priceCents: variant.priceCents,
          quantity: next,
          bucket,
        },
      ];

  write(updated);
  return {
    lines: updated,
    message: capped ? `Máximo ${PUBLIC_ORDER_MAX_QUANTITY} por pieza en un pedido.` : null,
  };
}

export function setQuantity(lines: CartLine[], variantId: string, quantity: number): CartLine[] {
  const updated =
    quantity <= 0
      ? lines.filter((l) => l.variantId !== variantId)
      : lines.map((l) =>
          l.variantId === variantId ? { ...l, quantity: Math.min(quantity, PUBLIC_ORDER_MAX_QUANTITY) } : l,
        );
  write(updated);
  return updated;
}

export function clearCart(): CartLine[] {
  write([]);
  return [];
}

const RANK = { AGOTADO: 0, POCAS: 1, HAY: 2 } as const;

/**
 * Clave de idempotencia del pedido.
 *
 * Se genera al abrir el formulario y se conserva mientras ese carrito no cambie. Si el teléfono se
 * queda sin señal y el cliente toca "Enviar" tres veces, el servidor devuelve el MISMO pedido; si
 * se genera una clave por clic, se reservan tres veces las mismas piezas.
 */
export function newOrderKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
