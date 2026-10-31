'use client';

import { formatMoney } from '@partops/contracts';
import { useCart } from './storefront-shell';

/**
 * Barra fija del carrito.
 *
 * En el teléfono, el pulgar vive en la mitad inferior de la pantalla: si el "ver pedido" queda en la
 * cabecera, el cliente lo busca. Solo aparece con algo dentro, para no tapar la última tarjeta del
 * catálogo cuando todavía no ha elegido nada.
 */
export function CartBar({ onOpen }: { onOpen: () => void }) {
  const { total, count, shop } = useCart();
  if (!count) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--surface)]/97 px-4 py-2.5 backdrop-blur-sm">
      <button
        type="button"
        onClick={onOpen}
        className="mx-auto flex h-12 w-full max-w-5xl items-center gap-3 rounded-[var(--radius-sm)] px-4 text-left"
        style={{ backgroundColor: 'var(--shop-primary)', color: 'var(--shop-on-primary)' }}
      >
        <span
          aria-hidden
          className="partops-num grid size-6 place-items-center rounded-full text-[12px] font-bold"
          style={{ backgroundColor: 'var(--shop-accent)', color: 'var(--accent-foreground)' }}
        >
          {count}
        </span>
        <span className="text-[14px] font-semibold">Ver pedido</span>
        <span className="partops-num ml-auto text-[15px] font-bold">{formatMoney(total, shop.currency)}</span>
      </button>
    </div>
  );
}
