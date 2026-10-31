'use client';

import type { PublicPart } from '@partops/contracts';
import { formatMoney, PART_CONDITION_LABEL } from '@partops/contracts';
import type { Route } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { AvailabilityPill } from '../../_components/availability-pill';
import { StockWatchForm } from '../../_components/stock-watch-form';
import { useCart } from '../../_components/storefront-shell';

/**
 * Ficha de la pieza.
 *
 * La abre casi siempre alguien que llegó por un enlace de WhatsApp con la referencia: llega sabiendo
 * qué busca y necesita tres respuestas —sirve para mi carro, cuánto cuesta, la tienen— antes de
 * cualquier otra cosa. Por eso el orden es ese y no una galería grande arriba.
 *
 * La compatibilidad se lista completa y agrupada por modelo, no por año: "Corolla 2003–2008" es una
 * línea; seis líneas de años sueltos hacen que la ficha parezca generada por una máquina.
 */
export function PartDetailScreen({
  part,
  shopSlug,
  shopName,
  currency,
  whatsappE164,
  pricesIncludeTax,
}: {
  part: PublicPart;
  shopSlug: string;
  shopName: string;
  currency: string;
  whatsappE164: string | null;
  pricesIncludeTax: boolean;
}) {
  const { add, openCart, count } = useCart();
  const [selected, setSelected] = useState(
    part.variants.find((v) => v.purchasable) ?? part.variants[0] ?? null,
  );

  const money = (cents: number) => formatMoney(cents, currency);
  const inquiry = whatsappE164
    ? `https://wa.me/${whatsappE164.replace(/\D/g, '')}?text=${encodeURIComponent(
        `Hola ${shopName}, me interesa "${part.name}"${selected ? ` (${selected.sku})` : ''}. ¿Está disponible?`,
      )}`
    : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-4">
      <nav className="mb-3 flex items-center gap-1.5 text-[12px] text-[var(--foreground-muted)]">
        <Link
          href={`/c/${encodeURIComponent(shopSlug)}` as Route}
          className="hover:text-[var(--foreground)] hover:underline"
        >
          Catálogo
        </Link>
        <span aria-hidden>›</span>
        <span className="truncate text-[var(--foreground)]">{part.name}</span>
      </nav>

      <article className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
        <div className="grid gap-4 p-4 sm:grid-cols-[220px_1fr]">
          <div className="relative aspect-square overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)]">
            {part.imageUrl ? (
              <Image
                src={part.imageUrl}
                alt={part.name}
                width={part.imageWidth ?? 640}
                height={part.imageHeight ?? 640}
                unoptimized
                className="size-full object-cover"
              />
            ) : (
              <span className="partops-hatch grid size-full place-items-center px-3 text-center font-mono text-[11px] text-[var(--foreground-muted)]">
                {part.brand ?? 'Sin foto'}
              </span>
            )}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <AvailabilityPill bucket={part.availability} />
              <span className="text-[11.5px] text-[var(--foreground-muted)]">
                {PART_CONDITION_LABEL[part.condition]}
                {part.warrantyDays ? ` · garantía ${part.warrantyDays} días` : ''}
              </span>
            </div>

            <h1 className="mt-2 font-[family-name:var(--font-display)] text-[clamp(1.15rem,3.4vw,1.5rem)] font-bold leading-tight tracking-[-0.02em]">
              {part.name}
            </h1>

            <p className="mt-1 text-[12.5px] text-[var(--foreground-muted)]">
              {[part.brand, part.category].filter(Boolean).join(' · ')}
            </p>

            {part.description ? (
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--foreground)]">{part.description}</p>
            ) : null}

            <div className="mt-3 space-y-2">
              {part.variants.map((v) => {
                const on = selected?.id === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    disabled={!v.purchasable}
                    aria-pressed={on}
                    onClick={() => setSelected(v)}
                    className={
                      on
                        ? 'flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] border-2 border-[var(--primary)] bg-[var(--surface-sunken)] px-3 py-2 text-left'
                        : 'flex w-full items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--surface-sunken)] disabled:opacity-45'
                    }
                  >
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">
                        {v.title || 'Única'}
                        {!v.purchasable ? (
                          <span className="ml-2 text-[11px] font-normal text-[var(--color-stock-out)]">
                            agotada
                          </span>
                        ) : null}
                      </span>
                      <span className="partops-num block font-mono text-[10.5px] text-[var(--foreground-muted)]">
                        {v.sku}
                        {v.oemNumbers.length ? ` · OEM ${v.oemNumbers.join(', ')}` : ''}
                      </span>
                    </span>
                    <span className="partops-num shrink-0 text-[15px] font-bold">{money(v.priceCents)}</span>
                  </button>
                );
              })}
            </div>

            {selected?.availability.length ? (
              <p className="mt-2 text-[11.5px] text-[var(--foreground-muted)]">
                Disponible en{' '}
                {selected.availability
                  .filter((a) => a.bucket !== 'AGOTADO')
                  .map((a) => a.warehouseName)
                  .join(', ') || 'ninguna bodega en línea'}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!selected?.purchasable}
                onClick={() => (selected ? add(part, selected) : undefined)}
                className="h-11 rounded-[var(--radius-sm)] px-5 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                style={{ backgroundColor: 'var(--shop-primary)', color: 'var(--shop-on-primary)' }}
              >
                {selected?.purchasable ? 'Agregar al pedido' : 'Agotado'}
              </button>
              {count > 0 ? (
                <button
                  type="button"
                  onClick={openCart}
                  className="h-11 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-4 text-[13px] font-medium hover:bg-[var(--surface-sunken)]"
                >
                  Ver pedido ({count})
                </button>
              ) : null}
              {inquiry ? (
                <a
                  href={inquiry}
                  target="_blank"
                  rel="noreferrer"
                  className="h-11 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-4 text-[13px] font-medium leading-[2.6] hover:bg-[var(--surface-sunken)]"
                >
                  Preguntar
                </a>
              ) : null}
            </div>

            <p className="mt-2 text-[11px] text-[var(--foreground-muted)]">
              {pricesIncludeTax ? 'El precio incluye IVA.' : 'El precio no incluye IVA.'} La existencia se
              aparta al enviar el pedido.
            </p>

            {/* Agotada, el botón de pedir está apagado y lo que queda es apuntar al cliente. */}
            {selected && !selected.purchasable ? (
              <div className="mt-3">
                <StockWatchForm slug={shopSlug} variantId={selected.id} partId={part.id} compact />
              </div>
            ) : null}
          </div>
        </div>

        {part.vehicles.length ? (
          <section className="border-t border-[var(--border)] px-4 py-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
              Le queda a
            </h2>
            <ul className="mt-2 divide-y divide-[var(--border)]">
              {part.vehicles.map((v) => (
                <li
                  key={`${v.brand}-${v.model}-${v.engine ?? ''}`}
                  className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]"
                >
                  <span>
                    <span className="font-medium">{v.brand}</span> {v.model}
                    {v.engine ? <span className="text-[var(--foreground-muted)]"> · {v.engine}</span> : null}
                  </span>
                  <span className="partops-num shrink-0 text-[12px] text-[var(--foreground-muted)]">
                    {v.yearStart}–{v.yearEnd}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </article>

      <p className="mt-4 text-center text-[11px] leading-relaxed text-[var(--foreground-muted)]">
        ¿No es la pieza que buscabas?{' '}
        <Link
          href={`/c/${encodeURIComponent(shopSlug)}` as Route}
          className="underline hover:text-[var(--foreground)]"
        >
          Vuelve al catálogo
        </Link>{' '}
        y filtra por tu vehículo.
      </p>
    </main>
  );
}
