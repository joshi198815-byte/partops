'use client';

import type { PublicCatalogItem, PublicVariant } from '@partops/contracts';
import { formatMoney, PART_CONDITION_LABEL } from '@partops/contracts';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { partPath } from '@/lib/public-catalog';
import { AvailabilityPill } from './availability-pill';
import { useCart } from './storefront-shell';

/**
 * Tarjeta de pieza.
 *
 * Tres cosas siempre visibles, en este orden: qué es (nombre y vehículo), cuánto cuesta y si se
 * puede pedir. El SKU va en monoespaciada porque es lo que el cliente compara con la pieza vieja en
 * la mano o dicta por teléfono.
 *
 * Si la pieza tiene variantes —"1.8L", "con ABS"— se eligen aquí mismo en vez de mandar al cliente
 * a otra página: la diferencia de precio entre variantes es justo la duda que lo hace dudar.
 */
export function PartCard({
  part,
  shopSlug,
  currency,
}: {
  part: PublicCatalogItem;
  shopSlug: string;
  currency: string;
}) {
  const { add } = useCart();
  const [selected, setSelected] = useState<PublicVariant | null>(
    part.variants.find((v) => v.purchasable) ?? part.variants[0] ?? null,
  );

  const money = (cents: number) => formatMoney(cents, currency);
  const price =
    part.priceMinCents === part.priceMaxCents
      ? money(part.priceMinCents)
      : `${money(part.priceMinCents)} – ${money(part.priceMaxCents)}`;
  const vehicle = part.vehicles[0];
  const moreVehicles = Math.max(0, part.vehicles.length - 1);

  return (
    <article className="flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex gap-3 p-3">
        <Link
          href={partPath(shopSlug, part.slug)}
          className="relative size-[76px] shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)]"
          tabIndex={-1}
          aria-hidden
        >
          {part.imageUrl ? (
            <Image
              src={part.imageUrl}
              alt=""
              width={part.imageWidth ?? 300}
              height={part.imageHeight ?? 300}
              unoptimized
              className="size-full object-cover"
            />
          ) : (
            <span className="partops-hatch grid size-full place-items-center font-mono text-[10px] text-[var(--foreground-muted)]">
              {part.brand ?? 'PIEZA'}
            </span>
          )}
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <Link
                href={partPath(shopSlug, part.slug)}
                className="block text-[14px] font-semibold leading-snug text-[var(--foreground)] hover:underline"
              >
                {part.name}
              </Link>
              <p className="mt-0.5 text-[11.5px] text-[var(--foreground-muted)]">
                {[part.brand, PART_CONDITION_LABEL[part.condition], part.category]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <AvailabilityPill bucket={part.availability} className="shrink-0" />
          </div>

          {vehicle ? (
            <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--foreground-muted)]">
              <span className="font-medium text-[var(--foreground)]">{vehicle.brand}</span> {vehicle.model} ·{' '}
              {vehicle.yearStart}
              {vehicle.yearEnd !== vehicle.yearStart ? `–${vehicle.yearEnd}` : ''}
              {vehicle.engine ? ` · ${vehicle.engine}` : ''}
              {moreVehicles ? ` y ${moreVehicles} más` : ''}
            </p>
          ) : null}

          <p className="partops-num mt-1.5 font-[family-name:var(--font-display)] text-[16px] font-bold leading-none">
            {price}
          </p>
        </div>
      </div>

      {part.variants.length > 1 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-[var(--border)] px-3 py-2">
          {part.variants.map((v) => {
            const on = selected?.id === v.id;
            return (
              <button
                key={v.id}
                type="button"
                aria-pressed={on}
                disabled={!v.purchasable}
                onClick={() => setSelected(v)}
                className={
                  on
                    ? 'rounded-[var(--radius-xs)] border border-[var(--primary)] bg-[var(--primary)] px-2 py-1 text-[11.5px] font-medium text-[var(--primary-foreground)]'
                    : 'rounded-[var(--radius-xs)] border border-[var(--border)] px-2 py-1 text-[11.5px] text-[var(--foreground)] hover:bg-[var(--surface-sunken)] disabled:opacity-40'
                }
              >
                {v.title || v.sku}
                <span className="partops-num ml-1 opacity-75">{money(v.priceCents)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-auto flex items-center gap-2 border-t border-[var(--border)] px-3 py-2">
        <p className="partops-num min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--foreground-muted)]">
          {selected?.sku ?? '—'}
        </p>
        <button
          type="button"
          disabled={!selected?.purchasable}
          onClick={() => (selected ? add(part, selected) : undefined)}
          className="h-9 rounded-[var(--radius-sm)] px-3.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={
            selected?.purchasable
              ? { backgroundColor: 'var(--shop-primary)', color: 'var(--shop-on-primary)' }
              : { border: '1px solid var(--border-strong)', color: 'var(--foreground-muted)' }
          }
        >
          {selected?.purchasable ? 'Agregar' : 'Agotado'}
        </button>
      </div>
    </article>
  );
}
