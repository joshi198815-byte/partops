'use client';

import type { DemandRow, SearchResponse } from '@partops/contracts';
import { formatMoney } from '@partops/contracts';
import { Alert, Button, CodeChip, EmptyState, StockPill } from '@partops/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

interface ScreenProps {
  canSeeDemand: boolean;
  canSeeCost: boolean;
}

const EXAMPLES = ['capo corolla 2009', 'pastillas hilux', 'faro sentra', '04465-0K290'];

/**
 * Búsqueda de mostrador.
 *
 * Tres decisiones que se notan al usarla:
 *
 *  - Se busca solo, sin botón. El vendedor escribe mientras el cliente habla; un "Enter" de más es
 *    una espera de más. El retardo de 220 ms evita una consulta por tecla sin sentirse lento.
 *  - Los códigos (OEM, SKU, número de parte) salen siempre visibles y en monoespaciada: es lo que
 *    se dicta por teléfono y lo que se compara con la pieza en la mano.
 *  - Una búsqueda sin resultado NO es un callejón: se registra como demanda y se dice, para que el
 *    vendedor sepa que la próxima compra lo va a traer.
 */
export function SearchScreen({ canSeeDemand, canSeeCost }: ScreenProps) {
  const [q, setQ] = useState('');
  const [brand, setBrand] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cada consulta lleva el número de la última pedida: si llega una respuesta vieja después de
  // una nueva, se descarta. Sin esto, escribir rápido deja en pantalla el resultado de "capo"
  // cuando ya se buscó "capo corolla".
  const seq = useRef(0);

  const run = useCallback(async (query: string, b: string | null, m: string | null) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (b) params.set('brand', b);
      if (m) params.set('model', m);
      const res = await api<SearchResponse>(`/api/search?${params}`);
      if (mine === seq.current) setData(res);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void run(q, brand, model), 220);
    return () => clearTimeout(timer);
  }, [q, brand, model, run]);

  /**
   * La marca deduce el modelo: al cambiar de marca se suelta el modelo, porque "Corolla" filtrado
   * sobre Nissan no devuelve nada y el vendedor culpa a la búsqueda, no al filtro.
   */
  function pickBrand(next: string | null) {
    setBrand(next);
    setModel(null);
  }

  const parsed = data?.parsed;
  const hits = data?.hits ?? [];
  const searched = Boolean(q.trim() || brand || model);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-4">
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          Buscar pieza
        </h1>
        <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">
          Por número OEM, por nombre o como lo dice el cliente. El año y el modelo se entienden solos.
        </p>
      </header>

      <div className="relative">
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="capo toyota corolla 2009 · 04465-0K290"
          aria-label="Buscar pieza"
          spellCheck={false}
          autoComplete="off"
          className="h-12 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] pl-3.5 pr-24 text-[15px] text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] uppercase tracking-wide text-[var(--foreground-muted)]">
          {loading ? 'Buscando…' : data ? `${data.total} ${data.total === 1 ? 'pieza' : 'piezas'}` : ''}
        </span>
      </div>

      {!searched ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-[var(--foreground-muted)]">Ejemplos:</span>
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setQ(e)}
              className="rounded-[var(--radius-xs)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 font-mono text-[11.5px] text-[var(--foreground)] hover:bg-[var(--surface-sunken)]"
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}

      {parsed && searched ? <Interpretation parsed={parsed} /> : null}

      {error ? (
        <div className="mt-4">
          <Alert tone="error" title="No se pudo buscar">
            {error}
          </Alert>
        </div>
      ) : null}

      {data && searched ? (
        <Facets
          brands={data.facets.brands}
          models={data.facets.models}
          brand={brand}
          model={model}
          onBrand={pickBrand}
          onModel={setModel}
        />
      ) : null}

      <div className="mt-4 space-y-2">
        {hits.map((hit) => (
          <PartCard key={hit.partId} hit={hit} canSeeCost={canSeeCost} />
        ))}
      </div>

      {data && searched && !loading && hits.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No hay ninguna pieza con eso"
            description={
              q.trim()
                ? `"${q.trim()}" quedó registrada como demanda. Aparecerá en la lista de compras para que la próxima vez sí esté.`
                : 'No hay piezas que apliquen a ese vehículo. Prueba sin el filtro.'
            }
            action={
              brand || model ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    pickBrand(null);
                  }}
                >
                  Quitar filtro de vehículo
                </Button>
              ) : null
            }
          />
        </div>
      ) : null}

      {canSeeDemand ? <DemandPanel /> : null}
    </div>
  );
}

function Interpretation({ parsed }: { parsed: NonNullable<SearchResponse['parsed']> }) {
  const bits: { label: string; value: string; tone?: 'accent' }[] = [];
  if (parsed.term)
    bits.push({ label: 'pieza', value: parsed.term, tone: parsed.synonym ? 'accent' : undefined });
  if (parsed.brand) bits.push({ label: 'marca', value: parsed.brand });
  if (parsed.model) bits.push({ label: 'modelo', value: parsed.model });
  if (parsed.year) bits.push({ label: 'año', value: String(parsed.year) });
  if (!bits.length) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {bits.map((b) => (
        <CodeChip key={b.label} label={b.label} tone={b.tone === 'accent' ? 'default' : 'muted'}>
          {b.value}
        </CodeChip>
      ))}
      {parsed.suggestions.length ? (
        <span className="text-[12px] text-[var(--foreground-muted)]">
          ¿Quisiste decir{' '}
          <span className="font-medium text-[var(--foreground)]">{parsed.suggestions.join(', ')}</span>?
        </span>
      ) : null}
      {parsed.synonym ? (
        <span className="text-[11.5px] text-[var(--foreground-muted)]">
          (sinónimo del mostrador, ya normalizado)
        </span>
      ) : null}
    </div>
  );
}

function Facets({
  brands,
  models,
  brand,
  model,
  onBrand,
  onModel,
}: {
  brands: SearchResponse['facets']['brands'];
  models: SearchResponse['facets']['models'];
  brand: string | null;
  model: string | null;
  onBrand: (b: string | null) => void;
  onModel: (m: string | null) => void;
}) {
  const visibleModels = useMemo(
    () => (brand ? models.filter((m) => m.brand === brand) : models).slice(0, 8),
    [models, brand],
  );
  if (!brands.length) return null;

  return (
    <div className="mt-3 space-y-1.5">
      <FilterRow
        title="Marca"
        items={brands.slice(0, 8).map((b) => ({ key: b.name, label: b.name, count: b.count }))}
        active={brand}
        onPick={onBrand}
      />
      {visibleModels.length ? (
        <FilterRow
          title="Modelo"
          items={visibleModels.map((m) => ({ key: m.name, label: m.name, count: m.count }))}
          active={model}
          onPick={onModel}
        />
      ) : null}
    </div>
  );
}

function FilterRow({
  title,
  items,
  active,
  onPick,
}: {
  title: string;
  items: { key: string; label: string; count: number }[];
  active: string | null;
  onPick: (key: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
        {title}
      </span>
      {items.map((item) => {
        const on = active === item.key;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(on ? null : item.key)}
            className={`inline-flex items-center gap-1 rounded-[var(--radius-xs)] border px-2 py-1 text-[12px] transition-colors ${
              on
                ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-sunken)]'
            }`}
          >
            {item.label}
            <span
              className={`partops-num text-[10.5px] ${on ? 'opacity-80' : 'text-[var(--foreground-muted)]'}`}
            >
              {item.count}
            </span>
          </button>
        );
      })}
      {active ? (
        <button
          type="button"
          onClick={() => onPick(null)}
          className="text-[11.5px] text-[var(--color-copper-700)] hover:underline"
        >
          quitar
        </button>
      ) : null}
    </div>
  );
}

function PartCard({ hit, canSeeCost }: { hit: SearchResponse['hits'][number]; canSeeCost: boolean }) {
  const [open, setOpen] = useState(false);
  const cheapest = hit.variants.reduce((min, v) => Math.min(v.priceCents, min), Number.POSITIVE_INFINITY);
  const price = Number.isFinite(cheapest) ? cheapest : null;
  const codes = uniqueCodes(
    hit.variants.flatMap((v) => [v.partNumber, ...v.oemNumbers]).filter((c): c is string => Boolean(c)),
  ).slice(0, 3);
  // "UNIDAD" en 40 tarjetas es ruido: la unidad solo se escribe cuando no es la obvia.
  const unitLabel = hit.unit === 'UNIDAD' ? 'u' : hit.unit.toLowerCase();

  return (
    <article className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-start gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-[14px] font-semibold leading-tight text-[var(--foreground)]">{hit.name}</h2>
            {hit.codeMatch ? (
              <span className="rounded-[var(--radius-xs)] bg-[var(--color-copper-100)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-copper-800)]">
                código exacto
              </span>
            ) : null}
            {hit.condition !== 'NUEVO' ? (
              <span className="text-[11px] uppercase tracking-wide text-[var(--foreground-muted)]">
                {hit.condition === 'USADO' ? 'usado' : 'remanufacturado'}
              </span>
            ) : null}
          </div>

          <p className="mt-0.5 text-[12px] text-[var(--foreground-muted)]">
            {[
              hit.category,
              hit.brand,
              hit.vehicles[0] ? `${hit.vehicles[0].brand} ${hit.vehicles[0].model}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            {hit.vehicles.length > 1 ? ` · +${hit.vehicles.length - 1} aplicaciones` : ''}
          </p>

          {codes.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {codes.map((c) => (
                <CodeChip key={c}>{c}</CodeChip>
              ))}
              {hit.variants.length > 1 ? (
                <span className="self-center text-[11px] text-[var(--foreground-muted)]">
                  {hit.variants.length} variantes
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="shrink-0 text-right">
          {price !== null ? (
            <p className="partops-num text-[14px] font-semibold text-[var(--foreground)]">
              {formatMoney(price)}
            </p>
          ) : null}
          <div className="mt-1">
            <StockPill
              quantity={hit.totalAvailable}
              reorderPoint={hit.variants[0]?.availability[0]?.reorderPoint ?? null}
              unit={unitLabel}
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full border-t border-[var(--border)] px-3 py-1.5 text-left text-[11.5px] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]"
      >
        {open ? 'Ocultar' : 'Ver'} códigos, bodegas y aplicaciones
      </button>

      {open ? (
        <div className="space-y-3 border-t border-[var(--border)] px-3 py-3">
          {hit.variants.map((variant) => (
            <div key={variant.id} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                {/* El título de la variante solo se escribe si dice algo distinto del nombre:
                    repetir "Capó delantero" bajo "Capó delantero" no informa, ocupa. */}
                <p className="text-[12.5px] font-medium text-[var(--foreground)]">
                  {variant.title === hit.name ? variant.sku : variant.title}
                </p>
                <p className="partops-num text-[12.5px] text-[var(--foreground)]">
                  {formatMoney(variant.priceCents)}
                  {canSeeCost && variant.costCents !== null ? (
                    <span className="ml-2 text-[11px] text-[var(--foreground-muted)]">
                      costo {formatMoney(variant.costCents)}
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <CodeChip label="sku">{variant.sku}</CodeChip>
                {variant.partNumber ? <CodeChip label="parte">{variant.partNumber}</CodeChip> : null}
                {/* El número de parte suele ser también el OEM: repetirlo en dos etiquetas hace
                    dudar de si son dos códigos distintos. */}
                {variant.oemNumbers
                  .filter((oem) => oem !== variant.partNumber)
                  .slice(0, 4)
                  .map((oem) => (
                    <CodeChip key={oem} label="oem">
                      {oem}
                    </CodeChip>
                  ))}
              </div>
              <ul className="grid gap-1 pt-1 sm:grid-cols-2">
                {variant.availability.map((a) => (
                  <li
                    key={a.warehouseId}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] px-2 py-1"
                  >
                    <span className="min-w-0 truncate text-[11.5px] text-[var(--foreground)]">
                      {a.warehouseCode} · {a.warehouseName}
                      {a.binLocation ? (
                        <span className="ml-1 font-mono text-[10.5px] text-[var(--foreground-muted)]">
                          {a.binLocation}
                        </span>
                      ) : null}
                    </span>
                    <StockPill quantity={a.available} reorderPoint={a.reorderPoint} />
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {hit.vehicles.length ? (
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                Aplica a
              </p>
              <ul className="mt-1 space-y-0.5">
                {hit.vehicles.slice(0, 12).map((v) => (
                  <li
                    key={`${v.brand}-${v.model}-${v.yearStart}-${v.yearEnd}-${v.engine ?? ''}`}
                    className="text-[11.5px] text-[var(--foreground)]"
                  >
                    {v.brand} {v.model}{' '}
                    <span className="partops-num text-[var(--foreground-muted)]">
                      {v.yearStart === v.yearEnd ? v.yearStart : `${v.yearStart}–${v.yearEnd}`}
                    </span>
                    {v.engine ? (
                      <span className="ml-1 text-[var(--foreground-muted)]">{v.engine}</span>
                    ) : null}
                  </li>
                ))}
                {hit.vehicles.length > 12 ? (
                  <li className="text-[11px] text-[var(--foreground-muted)]">
                    y {hit.vehicles.length - 12} aplicaciones más
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function DemandPanel() {
  const [rows, setRows] = useState<DemandRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api<DemandRow[]>('/api/search/demand')
      .then(setRows)
      .catch((err) => setError(errorMessage(err)));
  }, [open]);

  return (
    <section className="mt-8 border-t border-[var(--border)] pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
          Búsquedas sin existencia · últimos 30 días
        </span>
        <span className="text-[11.5px] text-[var(--color-copper-700)]">{open ? 'Ocultar' : 'Ver'}</span>
      </button>

      {open ? (
        <div className="mt-2">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {rows === null && !error ? (
            <p className="text-[12.5px] text-[var(--foreground-muted)]">Cargando…</p>
          ) : null}
          {rows?.length === 0 ? (
            <p className="text-[12.5px] text-[var(--foreground-muted)]">
              Nadie ha buscado algo que no tengas en los últimos 30 días.
            </p>
          ) : null}
          {rows?.length ? (
            <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
              <table className="w-full text-left">
                <thead className="bg-[var(--surface-sunken)]">
                  <tr>
                    <Th>Lo que se buscó</Th>
                    <Th>Vehículo</Th>
                    <Th align="right">Veces</Th>
                    <Th align="right">Sin resultado</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={`${r.term}-${r.brand ?? ''}-${r.model ?? ''}-${r.year ?? ''}`}
                      className="border-t border-[var(--border)]"
                    >
                      <Td>
                        <span className="font-medium text-[var(--foreground)]">{r.term || '(vacío)'}</span>
                      </Td>
                      <Td>
                        {[r.brand, r.model, r.year].filter(Boolean).join(' ') || (
                          <span className="text-[var(--foreground-muted)]">—</span>
                        )}
                      </Td>
                      <Td align="right">{r.searches}</Td>
                      <Td align="right">{r.missedCount}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)] ${align === 'right' ? 'text-right' : ''}`}
    >
      {children}
    </th>
  );
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td
      className={`px-3 py-2 text-[12.5px] text-[var(--foreground)] ${align === 'right' ? 'partops-num text-right' : ''}`}
    >
      {children}
    </td>
  );
}

/** Conserva el orden y quita repetidos: el OEM de una variante suele repetirse en la siguiente. */
function uniqueCodes(values: string[]): string[] {
  return [...new Set(values)];
}
