'use client';

import type { PublicCatalogItem, PublicShop, PublicVariant } from '@partops/contracts';
import { PartOpsMark } from '@partops/ui';
import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { shopTheme } from '@/lib/shop-theme';
import {
  addLine,
  type CartLine,
  cartCount,
  cartTotal,
  clearCart,
  loadCart,
  setQuantity as setLineQuantity,
} from '@/lib/storefront-cart';
import { CartBar } from './cart-bar';
import { CartDrawer } from './cart-drawer';

/**
 * Cáscara de la vitrina.
 *
 * Es lo único que comparten la portada y la ficha: cabecera con la marca del negocio, carrito en
 * memoria de sesión y el panel de pedido. La mercancía la pone cada página desde el servidor, así
 * la primera pintura ya trae precios y existencias sin esperar a JavaScript.
 *
 * El color del negocio se aplica como variables CSS DENTRO de este contenedor. Ni el resto de
 * PartOps ni la tienda de al lado se enteran, y `Button` sigue siendo el mismo componente.
 */
interface CartApi {
  shop: PublicShop;
  lines: CartLine[];
  total: number;
  count: number;
  add: (part: PublicCatalogItem, variant: PublicVariant) => void;
  setQuantity: (variantId: string, quantity: number) => void;
  clear: () => void;
  openCart: () => void;
}

const CartContext = createContext<CartApi | null>(null);

export function useCart(): CartApi {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart fuera de <StorefrontShell>');
  return ctx;
}

export function StorefrontShell({
  shop,
  turnstile,
  children,
}: {
  shop: PublicShop;
  turnstile: { required: boolean; siteKey: string | null };
  children: React.ReactNode;
}) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // El carrito vive en `sessionStorage`: se lee al montar, nunca en el render del servidor, porque
  // el HTML no puede depender de lo que este visitante juntó en su pestaña.
  useEffect(() => {
    setLines(loadCart());
  }, []);

  const add = useCallback(
    (part: PublicCatalogItem, variant: PublicVariant) => {
      const result = addLine(lines, part, variant, 1);
      setLines(result.lines);
      // Solo se abre el panel cuando hay algo que explicar (tope alcanzado, pieza agotada). Abrirlo
      // en cada "Agregar" interrumpe al cliente que está juntando tres piezas seguidas; la barra
      // fija ya le dice que el pedido va creciendo.
      if (result.message) {
        setNotice(result.message);
        setOpen(true);
      }
    },
    [lines],
  );

  const setQuantity = useCallback((variantId: string, quantity: number) => {
    setLines((current) => setLineQuantity(current, variantId, quantity));
  }, []);

  const clear = useCallback(() => {
    setLines(clearCart());
    setNotice(null);
  }, []);

  const api = useMemo<CartApi>(
    () => ({
      shop,
      lines,
      total: cartTotal(lines),
      count: cartCount(lines),
      add,
      setQuantity,
      clear,
      openCart: () => setOpen(true),
    }),
    [shop, lines, add, setQuantity, clear],
  );

  const hasCart = lines.length > 0;

  return (
    <CartContext.Provider value={api}>
      <div
        style={shopTheme(shop) as React.CSSProperties}
        // El aire inferior reserva el alto de la barra del carrito, que va fija: sin esto taparía
        // el botón de la última tarjeta justo cuando el cliente va a agregarla.
        className={`flex min-h-dvh flex-col bg-[var(--surface-sunken)] text-[var(--foreground)] ${
          hasCart ? 'pb-[72px]' : ''
        }`}
      >
        <ShopHeader shop={shop} />
        <div className="flex-1">{children}</div>
        <ShopFooter shop={shop} />
        <CartBar onOpen={() => setOpen(true)} />
        <CartDrawer
          open={open}
          notice={notice}
          turnstile={turnstile}
          onDismissNotice={() => setNotice(null)}
          onClose={() => setOpen(false)}
        />
      </div>
    </CartContext.Provider>
  );
}

/**
 * Cabecera.
 *
 * Va en el color del negocio y no en el de PartOps: el cliente entró a la bodega, no al sistema.
 * El teléfono y el WhatsApp están siempre visibles porque la mitad de las ventas de repuestos
 * terminan en una llamada: "¿me lo apartas?".
 */
function ShopHeader({ shop }: { shop: PublicShop }) {
  const wa = shop.whatsappE164
    ? `https://wa.me/${shop.whatsappE164.replace(/\D/g, '')}?text=${encodeURIComponent(
        `Hola ${shop.name}, vengo del catálogo en línea.`,
      )}`
    : null;

  return (
    <header className="bg-[var(--shop-primary)] text-[var(--shop-on-primary)]">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
        {shop.logoUrl ? (
          // El logo lo subió la bodega y ya viene recortado; se muestra tal cual en un cuadrado.
          // biome-ignore lint/performance/noImgElement: URL de marca del negocio, sin optimizador.
          <img
            src={shop.logoUrl}
            alt=""
            width={44}
            height={44}
            className="size-11 shrink-0 rounded-[var(--radius-sm)] bg-white/10 object-contain"
          />
        ) : (
          <span
            aria-hidden
            className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-white/25 font-[family-name:var(--font-display)] text-[19px] font-bold"
          >
            {shop.name.trim().charAt(0).toUpperCase()}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] opacity-70">
            Catálogo en línea
          </p>
          <p className="truncate font-[family-name:var(--font-display)] text-[19px] font-bold leading-tight tracking-[-0.015em]">
            {shop.name}
          </p>
          {shop.tagline ? <p className="mt-0.5 line-clamp-1 text-[12px] opacity-80">{shop.tagline}</p> : null}
        </div>

        <div className="flex items-center gap-2">
          {shop.phone ? (
            <a
              href={`tel:${shop.phone.replace(/[^\d+]/g, '')}`}
              className="partops-num hidden rounded-[var(--radius-sm)] border border-white/25 px-3 py-2 text-[13px] font-medium hover:bg-white/10 sm:block"
            >
              {shop.phone}
            </a>
          ) : null}
          {wa ? (
            <a
              href={wa}
              target="_blank"
              rel="noreferrer"
              className="rounded-[var(--radius-sm)] px-3.5 py-2 text-[13px] font-semibold"
              style={{ backgroundColor: 'var(--shop-accent)', color: 'var(--accent-foreground)' }}
            >
              WhatsApp
            </a>
          ) : null}
        </div>
      </div>

      {shop.address ? (
        <div className="border-t border-white/12">
          <p className="mx-auto max-w-5xl px-4 py-1.5 text-[11.5px] opacity-80">{shop.address}</p>
        </div>
      ) : null}
    </header>
  );
}

/**
 * Pie.
 *
 * Dice lo que de verdad pasa al pedir —se aparta la pieza y se confirma por WhatsApp— en vez de
 * prometer envíos o garantías que dependen de la bodega. La marca de PartOps va discreta: es el
 * sistema, no la tienda.
 */
function ShopFooter({ shop }: { shop: PublicShop }) {
  return (
    <footer className="border-t border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-5xl flex-wrap items-start justify-between gap-x-8 gap-y-4 px-4 py-6 text-[12px] text-[var(--foreground-muted)]">
        <div className="max-w-sm space-y-1">
          <p className="font-[family-name:var(--font-display)] text-[14px] font-semibold text-[var(--foreground)]">
            {shop.name}
          </p>
          {shop.address ? <p>{shop.address}</p> : null}
          {shop.phone ? <p className="partops-num">{shop.phone}</p> : null}
          <p className="pt-1 leading-relaxed">
            Al enviar el pedido se aparta la existencia y la bodega confirma por teléfono o WhatsApp.
            {shop.pricesIncludeTax ? ' Los precios incluyen IVA.' : ' Los precios no incluyen IVA.'}
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11.5px]">
          <PartOpsMark size={18} variant="color" />
          <span>
            Catálogo servido por{' '}
            <Link href="/" className="font-medium text-[var(--foreground)] hover:underline">
              PartOps
            </Link>
          </span>
        </div>
      </div>
    </footer>
  );
}
