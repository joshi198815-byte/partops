'use client';

import type { PublicCatalogResponse } from '@partops/contracts';
import { EmptyState } from '@partops/ui';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type StorefrontQuery, storefrontQueryString } from '@/lib/public-catalog';
import { PartCard } from './part-card';
import { StockWatchForm } from './stock-watch-form';
import { VehicleSelector } from './vehicle-selector';

/**
 * Portada de la tienda.
 *
 * El buscador manda la consulta al servidor al enviar, no en cada tecla: la vitrina se cachea en el
 * borde y una petición por pulsación tira esa caché a la basura. Con el filtro de vehículo pasa lo
 * mismo, y ahí el `<select>` ya obliga a un gesto deliberado.
 *
 * La búsqueda que no encuentra nada NO se queda en un "sin resultados": se registra como demanda
 * (para que la bodega compre lo que la gente pide) y se ofrece el WhatsApp del negocio con el texto
 * ya escrito. Es la diferencia entre perder la venta y abrir una conversación.
 */
export function CatalogScreen({ data, query }: { data: PublicCatalogResponse; query: StorefrontQuery }) {
  const router = useRouter();
  const [q, setQ] = useState(query.q);
  const tracked = useRef<string | null>(null);
  const { shop } = data;

  useEffect(() => {
    setQ(query.q);
  }, [query.q]);

  /**
   * Demanda.
   *
   * Se registra una sola vez por término y solo cuando hubo una búsqueda escrita de verdad. Va en
   * `POST` aparte porque el `GET` del catálogo tiene que ser cacheable; si falla, al cliente no le
   * importa y la bodega pierde una fila de estadística, no una venta.
   */
  useEffect(() => {
    const term = query.q.trim();
    if (term.length < 3 || tracked.current === term) return;
    tracked.current = term;
    void fetch(`/api/public/catalog/${encodeURIComponent(shop.slug)}/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: term }),
      keepalive: true,
    }).catch(() => undefined);
  }, [query.q, shop.slug]);

  function search(term: string) {
    router.push(
      `/c/${encodeURIComponent(shop.slug)}${storefrontQueryString({ ...query, q: term, page: 1 })}` as Route,
    );
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = Boolean(query.q || query.brand || query.model || query.year);

  return (
    <main className="mx-auto max-w-5xl px-4 py-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search(q);
        }}
        className="relative"
      >
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Pieza, número OEM o SKU · capo corolla 2009"
          aria-label="Buscar pieza en el catálogo"
          spellCheck={false}
          autoComplete="off"
          className="h-12 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] pl-3.5 pr-24 text-[15px]"
        />
        <button
          type="submit"
          className="absolute right-1.5 top-1.5 h-9 rounded-[var(--radius-sm)] px-3.5 text-[13px] font-semibold"
          style={{ backgroundColor: 'var(--shop-primary)', color: 'var(--shop-on-primary)' }}
        >
          Buscar
        </button>
      </form>

      <div className="mt-3">
        <VehicleSelector
          shopSlug={shop.slug}
          query={query}
          brands={data.facets.vehicles.brands}
          models={data.facets.vehicles.models}
        />
      </div>

      {data.facets.categories.length > 1 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
            Categoría
          </span>
          {data.facets.categories.slice(0, 8).map((c) => {
            const on = query.q.toLowerCase() === c.name.toLowerCase();
            return (
              <button
                key={c.name}
                type="button"
                aria-pressed={on}
                onClick={() => search(on ? '' : c.name)}
                className={
                  on
                    ? 'rounded-[var(--radius-xs)] border border-[var(--primary)] bg-[var(--primary)] px-2 py-1 text-[11.5px] text-[var(--primary-foreground)]'
                    : 'rounded-[var(--radius-xs)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11.5px] hover:bg-[var(--surface-sunken)]'
                }
              >
                {c.name}
                <span className="partops-num ml-1 opacity-60">{c.count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <p className="text-[12.5px] text-[var(--foreground-muted)]">
          {data.total === 0
            ? 'Sin piezas'
            : `${data.total} ${data.total === 1 ? 'pieza' : 'piezas'}${
                query.brand || query.model || query.year
                  ? ` para ${[query.brand, query.model, query.year].filter(Boolean).join(' ')}`
                  : ''
              }`}
        </p>
        {pages > 1 ? (
          <p className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
            {data.page} / {pages}
          </p>
        ) : null}
      </div>

      {data.items.length ? (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {data.items.map((part) => (
            <li key={part.id}>
              <PartCard part={part} shopSlug={shop.slug} currency={shop.currency} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3">
          <NoResults
            slug={shop.slug}
            shopName={shop.name}
            whatsapp={shop.whatsappE164}
            query={query}
            filtered={filtered}
          />
        </div>
      )}

      {pages > 1 ? (
        <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Páginas">
          <PageLink
            slug={shop.slug}
            query={query}
            page={data.page - 1}
            disabled={data.page <= 1}
            label="← Anterior"
          />
          <PageLink
            slug={shop.slug}
            query={query}
            page={data.page + 1}
            disabled={data.page >= pages}
            label="Siguiente →"
          />
        </nav>
      ) : null}

      <p className="mt-6 text-center text-[11px] leading-relaxed text-[var(--foreground-muted)]">
        Los precios {shop.pricesIncludeTax ? 'incluyen' : 'no incluyen'} IVA. La existencia se confirma al
        apartar la pieza.
      </p>
    </main>
  );
}

function PageLink({
  slug,
  query,
  page,
  disabled,
  label,
}: {
  slug: string;
  query: StorefrontQuery;
  page: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="rounded-[var(--radius-sm)] border border-[var(--border)] px-3 py-2 text-[12.5px] text-[var(--foreground-muted)] opacity-50">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={`/c/${encodeURIComponent(slug)}${storefrontQueryString({ ...query, page })}` as Route}
      className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-[12.5px] font-medium hover:bg-[var(--surface-sunken)]"
    >
      {label}
    </Link>
  );
}

/**
 * Sin resultados.
 *
 * Distingue dos casos porque la salida es distinta: un filtro demasiado estrecho se quita con un
 * clic; una pieza que la bodega no tiene se resuelve hablando o dejando el aviso. En los dos, el
 * WhatsApp lleva el texto escrito: el cliente no tiene que explicar qué buscaba.
 */
function NoResults({
  slug,
  shopName,
  whatsapp,
  query,
  filtered,
}: {
  slug: string;
  shopName: string;
  whatsapp: string | null;
  query: StorefrontQuery;
  filtered: boolean;
}) {
  const term = query.q.trim();
  const text = [
    `Hola ${shopName}, busco ${term ? `"${term}"` : 'una pieza'} y no la encontré en el catálogo.`,
    query.brand || query.model || query.year
      ? `Es para un ${[query.brand, query.model, query.year].filter(Boolean).join(' ')}.`
      : null,
    '¿Me ayudan a conseguirla?',
  ]
    .filter(Boolean)
    .join('\n');
  const href = whatsapp
    ? `https://wa.me/${whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`
    : null;

  return (
    <div className="space-y-3">
      <EmptyState
        title={filtered ? 'No hay piezas con ese filtro' : 'Todavía no hay piezas publicadas'}
        description={
          term
            ? `"${term}" quedó anotado como demanda: la bodega lo ve en su lista de compras.`
            : 'Prueba sin el filtro de vehículo o pregúntanos directamente.'
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {filtered ? (
              <Link
                href={`/c/${encodeURIComponent(slug)}` as Route}
                className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 py-2 text-[12.5px] font-medium hover:bg-[var(--surface-sunken)]"
              >
                Ver todo el catálogo
              </Link>
            ) : null}
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="rounded-[var(--radius-sm)] px-3 py-2 text-[12.5px] font-semibold"
                style={{ backgroundColor: 'var(--shop-accent)', color: 'var(--accent-foreground)' }}
              >
                Preguntar por WhatsApp
              </a>
            ) : null}
          </div>
        }
      />
      {/* La otra salida del callejón: dejar el teléfono y esperar. Solo tiene sentido cuando el
          cliente escribió qué busca, porque es eso lo que la bodega va a reponer. */}
      {term.length >= 3 ? <StockWatchForm slug={slug} q={term} compact /> : null}
    </div>
  );
}
