'use client';

import {
  type CatalogListQueryInput,
  type CatalogListResponse,
  type CatalogPartSummary,
  catalogListQuerySchema,
  formatMoney,
  PART_CONDITIONS,
  type PartConditionKey,
  STOCK_FILTERS,
} from '@partops/contracts';
import { Alert, Button, EmptyState, Select, StockPill } from '@partops/ui';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { PartDetail } from './part-detail';
import { PartEditor } from './part-editor';

interface ScreenProps {
  canCreate: boolean;
  canUpdate: boolean;
  canArchive: boolean;
  canAdjust: boolean;
  canSeeCost: boolean;
}

const STOCK_LABEL: Record<(typeof STOCK_FILTERS)[number], string> = {
  TODOS: 'Todas',
  CON: 'Con existencia',
  BAJO: 'Bajo el mínimo',
  AGOTADO: 'Agotadas',
};

const SORT_LABEL = { NOMBRE: 'Nombre', RECIENTES: 'Recientes', PRECIO: 'Precio' } as const;

const CONDITION_LABEL: Record<PartConditionKey, string> = {
  NUEVO: 'Nuevo',
  USADO: 'Usado',
  REMANUFACTURADO: 'Remanufacturado',
};

/**
 * Catálogo.
 *
 * La pantalla es una tabla, no tarjetas: en el catálogo se compara —cuánto cuesta, cuánto queda,
 * qué marca— y comparar se hace en columnas alineadas. El detalle se abre al costado porque
 * editar un precio no debería hacer perder el lugar donde se estaba mirando.
 *
 * Los filtros viven en la URL además del estado: el vendedor manda por WhatsApp "mirá la línea de
 * pastillas" y el enlace tiene que abrir exactamente eso.
 */
export function CatalogScreen(props: ScreenProps) {
  const [query, setQuery] = useState<CatalogListQueryInput>(() => ({
    q: '',
    status: 'ACTIVO',
    stock: 'TODOS',
    sort: 'NOMBRE',
    limit: 30,
    offset: 0,
    ...readUrl(),
  }));
  const [data, setData] = useState<CatalogListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | CatalogPartSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Igual que en la búsqueda: una respuesta vieja no puede pisar a la nueva.
  const seq = useRef(0);

  const reload = useCallback(async (next: CatalogListQueryInput) => {
    const mine = ++seq.current;
    const parsed = catalogListQuerySchema.safeParse(next);
    if (!parsed.success) return;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }

    setLoading(true);
    setError(null);
    // `replaceState` y no el router: filtrar no debe agregar una entrada al historial por tecla.
    window.history.replaceState(null, '', `/app/catalogo?${params}`);
    try {
      const res = await api<CatalogListResponse>(`/api/catalog/parts?${params}`);
      if (mine === seq.current) setData(res);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void reload(query), 220);
    return () => clearTimeout(timer);
  }, [query, reload]);

  function patch(next: Partial<CatalogListQueryInput>) {
    // Cambiar un filtro vuelve a la primera página: quedarse en la 4 de un resultado de 2 filas
    // muestra una tabla vacía que parece un error.
    setQuery((current) => ({ ...current, ...next, offset: 0 }));
  }

  function refresh() {
    void reload(query);
  }

  const items = data?.items ?? [];
  const pageEnd = (data?.offset ?? 0) + items.length;
  const hasFilters = Boolean(
    query.q || query.brand || query.categoryId || query.condition || query.stock !== 'TODOS',
  );

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Catálogo
          </h1>
          <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">
            {data ? `${data.total} ${data.total === 1 ? 'pieza' : 'piezas'}` : 'Cargando…'}
            {loading && data ? ' · actualizando' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {props.canCreate ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              Nueva pieza
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query.q ?? ''}
            onChange={(e) => patch({ q: e.target.value })}
            placeholder="Nombre, SKU u OEM"
            aria-label="Filtrar catálogo"
            spellCheck={false}
            autoComplete="off"
            className="h-10 min-w-[200px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[14px] text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]"
          />
          <Select
            aria-label="Existencia"
            value={query.stock ?? 'TODOS'}
            onChange={(e) => patch({ stock: e.target.value as (typeof STOCK_FILTERS)[number] })}
            className="h-10 w-auto text-[13px]"
          >
            {STOCK_FILTERS.map((s) => (
              <option key={s} value={s}>
                {STOCK_LABEL[s]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Orden"
            value={query.sort ?? 'NOMBRE'}
            onChange={(e) => patch({ sort: e.target.value as keyof typeof SORT_LABEL })}
            className="h-10 w-auto text-[13px]"
          >
            {Object.entries(SORT_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>

        <Facets
          data={data}
          brand={query.brand ?? null}
          categoryId={query.categoryId ?? null}
          condition={query.condition ?? null}
          onBrand={(brand) => patch({ brand: brand ?? undefined })}
          onCategory={(categoryId) => patch({ categoryId: categoryId ?? undefined })}
          onCondition={(condition) => patch({ condition: condition ?? undefined })}
        />

        {hasFilters ? (
          <button
            type="button"
            onClick={() =>
              setQuery({ q: '', status: 'ACTIVO', stock: 'TODOS', sort: 'NOMBRE', limit: 30, offset: 0 })
            }
            className="text-[11.5px] text-[var(--color-copper-700)] hover:underline"
          >
            Limpiar filtros
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="mt-4">
          <Alert tone="error" title="No se pudo cargar el catálogo">
            {error}
          </Alert>
        </div>
      ) : null}

      <div className="mt-4">
        {!loading && !error && items.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'Ninguna pieza con esos filtros' : 'El catálogo está vacío'}
            description={
              hasFilters
                ? 'Quita algún filtro. Si la pieza no existe, búscala: la búsqueda sin resultado queda registrada como demanda.'
                : 'Carga la primera pieza con su SKU y su precio, o importa el Excel de la bodega.'
            }
            action={
              <div className="flex gap-2">
                {hasFilters ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setQuery({
                        q: '',
                        status: 'ACTIVO',
                        stock: 'TODOS',
                        sort: 'NOMBRE',
                        limit: 30,
                        offset: 0,
                      })
                    }
                  >
                    Quitar filtros
                  </Button>
                ) : null}
                {props.canCreate ? (
                  <Button size="sm" onClick={() => setEditing('new')}>
                    Nueva pieza
                  </Button>
                ) : null}
                <Link
                  href="/app/catalogo/importar"
                  className="inline-flex h-9 items-center rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[13px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-sunken)]"
                >
                  Importar Excel
                </Link>
              </div>
            }
          />
        ) : null}

        {items.length ? (
          <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
            <table className="w-full text-left">
              <thead className="bg-[var(--surface-sunken)]">
                <tr>
                  {props.canUpdate ? <Th aria-label="Seleccionar" /> : null}
                  <Th>Pieza</Th>
                  <Th className="hidden sm:table-cell">Categoría</Th>
                  <Th align="right">Precio</Th>
                  <Th align="right">Existencia</Th>
                  <Th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const checked = selected.has(item.id);
                  return (
                    <tr
                      key={item.id}
                      className="border-t border-[var(--border)] hover:bg-[var(--surface-sunken)]"
                    >
                      {props.canUpdate ? (
                        <td className="w-8 pl-3">
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar ${item.name}`}
                            checked={checked}
                            onChange={() =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (next.has(item.id)) next.delete(item.id);
                                else next.add(item.id);
                                return next;
                              })
                            }
                            className="size-4 accent-[var(--primary)]"
                          />
                        </td>
                      ) : null}
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => setOpenId(item.id)} className="block text-left">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-[13.5px] font-medium text-[var(--foreground)]">
                              {item.name}
                            </span>
                            {item.status === 'ARCHIVADO' ? (
                              <span className="rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
                                archivada
                              </span>
                            ) : null}
                            {item.condition !== 'NUEVO' ? (
                              <span className="text-[10.5px] uppercase tracking-wide text-[var(--foreground-muted)]">
                                {CONDITION_LABEL[item.condition]}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1">
                            <span className="font-mono text-[11px] text-[var(--foreground-muted)]">
                              {item.sku}
                            </span>
                            {item.brand ? (
                              <span className="text-[11px] text-[var(--foreground-muted)]">
                                · {item.brand}
                              </span>
                            ) : null}
                            {item.variantCount > 1 ? (
                              <span className="text-[11px] text-[var(--foreground-muted)]">
                                · {item.variantCount} variantes
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </td>
                      <td className="hidden px-3 py-2 text-[12.5px] text-[var(--foreground-muted)] sm:table-cell">
                        {item.category ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className="partops-num text-[12.5px] text-[var(--foreground)]">
                          {item.priceMin === item.priceMax
                            ? formatMoney(item.priceMin)
                            : `${formatMoney(item.priceMin)} – ${formatMoney(item.priceMax)}`}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <StockPill
                          quantity={item.onHand - item.reserved}
                          low={item.lowStock}
                          unit={item.unit === 'UNIDAD' ? 'u' : item.unit.toLowerCase()}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setOpenId(item.id)}
                          className="text-[12px] text-[var(--color-copper-700)] hover:underline"
                        >
                          Abrir
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {data && data.total > data.limit ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-[var(--foreground-muted)]">
            {data.offset + 1}–{pageEnd} de {data.total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={(query.offset ?? 0) <= 0}
              onClick={() =>
                setQuery((c) => ({ ...c, offset: Math.max((c.offset ?? 0) - (c.limit ?? 30), 0) }))
              }
            >
              Anterior
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pageEnd >= data.total}
              onClick={() => setQuery((c) => ({ ...c, offset: (c.offset ?? 0) + (c.limit ?? 30) }))}
            >
              Siguiente
            </Button>
          </div>
        </div>
      ) : null}

      {selected.size && props.canUpdate ? (
        <BulkBar
          count={selected.size}
          categories={data?.facets.categories ?? []}
          onClear={() => setSelected(new Set())}
          onDone={() => {
            setSelected(new Set());
            refresh();
          }}
          ids={[...selected]}
        />
      ) : null}

      {editing ? (
        <PartEditor
          part={editing === 'new' ? null : editing}
          categories={data?.facets.categories ?? []}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            refresh();
            if (id) setOpenId(id);
          }}
        />
      ) : null}

      {openId ? (
        <PartDetail
          partId={openId}
          canUpdate={props.canUpdate}
          canArchive={props.canArchive}
          canAdjust={props.canAdjust}
          canSeeCost={props.canSeeCost}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
          onEdit={(part) => {
            setOpenId(null);
            setEditing(part);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Filtros iniciales desde la URL.
 *
 * El enlace que se manda por WhatsApp tiene que abrir el catálogo ya filtrado. Se valida campo por
 * campo: un `stock=basura` en la URL se descarta y deja su valor por omisión, en vez de tirar
 * también el `brand=Toyota` que sí era válido.
 */
function readUrl(): CatalogListQueryInput {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const out: Record<string, unknown> = {};
  for (const key of [
    'q',
    'categoryId',
    'brand',
    'condition',
    'status',
    'stock',
    'sort',
    'limit',
    'offset',
  ] as const) {
    const raw = params.get(key);
    if (raw === null || raw === '') continue;
    const field = catalogListQuerySchema.shape[key].safeParse(raw);
    if (field.success) out[key] = field.data;
  }
  return out as CatalogListQueryInput;
}

function Facets({
  data,
  brand,
  categoryId,
  condition,
  onBrand,
  onCategory,
  onCondition,
}: {
  data: CatalogListResponse | null;
  brand: string | null;
  categoryId: string | null;
  condition: PartConditionKey | null;
  onBrand: (brand: string | null) => void;
  onCategory: (id: string | null) => void;
  onCondition: (condition: PartConditionKey | null) => void;
}) {
  if (!data) return null;
  const { brands, categories } = data.facets;
  if (!brands.length && !categories.length) return null;

  return (
    <div className="space-y-1.5">
      {categories.length ? (
        <FacetRow
          title="Categoría"
          items={categories.map((c) => ({ key: c.id, label: c.name, count: c.count }))}
          active={categoryId}
          onPick={onCategory}
        />
      ) : null}
      {brands.length ? (
        <FacetRow
          title="Marca"
          items={brands.map((b) => ({ key: b.name, label: b.name, count: b.count }))}
          active={brand}
          onPick={onBrand}
        />
      ) : null}
      <FacetRow
        title="Condición"
        items={PART_CONDITIONS.map((c) => ({ key: c, label: CONDITION_LABEL[c], count: null }))}
        active={condition}
        onPick={(key) => onCondition(key as PartConditionKey | null)}
      />
    </div>
  );
}

function FacetRow({
  title,
  items,
  active,
  onPick,
}: {
  title: string;
  items: { key: string; label: string; count: number | null }[];
  active: string | null;
  onPick: (key: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-16 shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
        {title}
      </span>
      {items.slice(0, 12).map((item) => {
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
            {item.count !== null ? (
              <span
                className={`partops-num text-[10.5px] ${on ? 'opacity-80' : 'text-[var(--foreground-muted)]'}`}
              >
                {item.count}
              </span>
            ) : null}
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

/**
 * Acciones en lote.
 *
 * Archivar sin diálogo de confirmación porque es reversible (se puede reactivar); asignar
 * categoría sí pide elegirla, porque una categoría equivocada se descubre buscando y no aparece.
 */
function BulkBar({
  ids,
  count,
  categories,
  onClear,
  onDone,
}: {
  ids: string[];
  count: number;
  categories: Array<{ id: string; name: string }>;
  onClear: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'ARCHIVAR' | 'ACTIVAR' | 'CATEGORIA') {
    setBusy(true);
    setError(null);
    try {
      await api('/api/catalog/parts/bulk', {
        method: 'POST',
        body: { ids, action, ...(action === 'CATEGORIA' ? { categoryId } : {}) },
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sticky bottom-3 z-30 mt-4 rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface)] p-3 shadow-[var(--shadow-card)]">
      {error ? (
        <Alert tone="error" className="mb-2">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-[var(--foreground)]">
          {count} {count === 1 ? 'pieza' : 'piezas'}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            aria-label="Categoría de destino"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="h-9 w-auto text-[12.5px]"
          >
            <option value="">Mover a categoría…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!categoryId}
            loading={busy}
            onClick={() => run('CATEGORIA')}
          >
            Mover
          </Button>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => run('ACTIVAR')}>
            Activar
          </Button>
          <Button size="sm" variant="danger" loading={busy} onClick={() => run('ARCHIVAR')}>
            Archivar
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            Quitar selección
          </Button>
        </div>
      </div>
    </div>
  );
}

function Th({
  children,
  align = 'left',
  className,
}: {
  children?: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)] ${
        align === 'right' ? 'text-right' : ''
      } ${className ?? ''}`}
    >
      {children}
    </th>
  );
}
