'use client';

import {
  INVENTORY_FILTERS,
  type InventoryListQueryInput,
  type InventoryListResponse,
  type InventoryRow,
  type InventorySummary,
  inventoryListQuerySchema,
  type WarehouseOption,
} from '@partops/contracts';
import { Alert, Button, CodeChip, EmptyState, Select, StatTile, StockPill } from '@partops/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { MovementsPanel } from './movements-panel';
import { TransferPanel } from './transfer-panel';

const FILTER_LABEL: Record<(typeof INVENTORY_FILTERS)[number], string> = {
  TODOS: 'Todo',
  CON: 'Con existencia',
  BAJO: 'Bajo el mínimo',
  AGOTADO: 'Agotado',
  SIN_UBICACION: 'Sin ubicación',
};

type Tab = 'existencias' | 'traslados' | 'movimientos';

/**
 * Inventario.
 *
 * Tres vistas y no una: el bodeguero busca existencias, el encargado mueve piezas entre sucursales
 * y el dueño audita. Meterlas en una sola pantalla obligaría a cada uno a atravesar el trabajo de
 * los otros dos. La pestaña vive en la URL para que el enlace abierto mande a lo mismo.
 *
 * Existencia, reservado y disponible se muestran los tres juntos porque son tres números distintos
 * y confundirlos es la forma más común de prometer una pieza que ya está apartada.
 */
export function InventoryScreen({ canAdjust, canTransfer }: { canAdjust: boolean; canTransfer: boolean }) {
  const [tab, setTab] = useState<Tab>(() => readTab());
  const [query, setQuery] = useState<InventoryListQueryInput>(() => ({
    q: '',
    filter: 'TODOS',
    limit: 40,
    offset: 0,
    ...readQuery(),
  }));
  const [data, setData] = useState<InventoryListResponse | null>(null);
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingTransfer, setCreatingTransfer] = useState(false);

  // Una respuesta vieja no puede pisar a la nueva: se escribe rápido y llegan fuera de orden.
  const seq = useRef(0);

  const loadWarehouses = useCallback(async () => {
    try {
      setWarehouses(await api<WarehouseOption[]>('/api/inventory/warehouses'));
    } catch {
      // Sin bodegas la pantalla sigue sirviendo para ver el ledger: no vale tumbar todo.
    }
  }, []);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<InventorySummary>('/api/inventory/summary'));
    } catch {
      setSummary(null);
    }
  }, []);

  const reload = useCallback(async (next: InventoryListQueryInput) => {
    const mine = ++seq.current;
    const parsed = inventoryListQuerySchema.safeParse(next);
    if (!parsed.success) return;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }

    setLoading(true);
    setError(null);
    window.history.replaceState(null, '', `/app/inventario?${params}`);

    try {
      const res = await api<InventoryListResponse>(`/api/inventory?${params}`);
      if (mine === seq.current) setData(res);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWarehouses();
    void loadSummary();
  }, [loadWarehouses, loadSummary]);

  useEffect(() => {
    if (tab !== 'existencias') return;
    const timer = setTimeout(() => void reload(query), 220);
    return () => clearTimeout(timer);
  }, [query, reload, tab]);

  function patch(next: Partial<InventoryListQueryInput>) {
    setQuery((current) => ({ ...current, ...next, offset: 0 }));
  }

  function refresh() {
    void loadSummary();
    if (tab === 'existencias') void reload(query);
  }

  const items = data?.items ?? [];
  const pageEnd = (data?.offset ?? 0) + items.length;

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Inventario
          </h1>
          <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">
            {summary
              ? `${summary.variants} referencias · ${summary.units} unidades · ${summary.reserved} reservadas`
              : 'Cargando…'}
            {loading && data && tab === 'existencias' ? ' · actualizando' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canTransfer ? (
            <Button
              size="sm"
              onClick={() => {
                // El formulario vive en la pestaña de traslados: sin cambiar de pestaña, el botón
                // parecería no hacer nada y la persona volvería a pulsarlo.
                setTab('traslados');
                window.history.replaceState(null, '', '/app/inventario?vista=traslados');
                setCreatingTransfer(true);
              }}
            >
              Nuevo traslado
            </Button>
          ) : null}
        </div>
      </header>

      {summary ? (
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Bajo el mínimo" value={String(summary.low)} hint="para pedir a la central" />
          <StatTile label="Agotado" value={String(summary.out)} hint="sin existencia en ninguna bodega" />
          <StatTile label="Sin ubicación" value={String(summary.unlocated)} hint="hay pieza, falta pasillo" />
          <StatTile
            label="Traslados abiertos"
            value={String(summary.openTransfers)}
            hint="en tránsito o por despachar"
          />
        </div>
      ) : null}

      <nav aria-label="Secciones de inventario" className="mb-4 flex gap-1 border-b border-[var(--border)]">
        {(
          [
            ['existencias', 'Existencias'],
            ['traslados', 'Traslados'],
            ['movimientos', 'Movimientos'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => {
              setTab(key);
              window.history.replaceState(null, '', `/app/inventario?vista=${key}`);
            }}
            className={
              tab === key
                ? '-mb-px border-b-2 border-[var(--color-copper-600)] px-3 py-2 text-[13px] font-semibold text-[var(--foreground)]'
                : '-mb-px border-b-2 border-transparent px-3 py-2 text-[13px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]'
            }
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'existencias' ? (
        <>
          {error ? (
            <Alert tone="error" title="No se pudo cargar el inventario">
              {error}
            </Alert>
          ) : null}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query.q ?? ''}
              onChange={(e) => patch({ q: e.target.value })}
              placeholder="SKU, pieza, OEM o marca"
              aria-label="Buscar en el inventario"
              spellCheck={false}
              autoComplete="off"
              className="h-10 min-w-[200px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[14px] text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]"
            />
            <Select
              aria-label="Bodega"
              value={query.warehouseId ?? ''}
              onChange={(e) => patch({ warehouseId: e.target.value || undefined })}
              className="h-10 w-auto text-[13px]"
            >
              <option value="">Todas las bodegas</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filtro"
              value={query.filter ?? 'TODOS'}
              onChange={(e) => patch({ filter: e.target.value as (typeof INVENTORY_FILTERS)[number] })}
              className="h-10 w-auto text-[13px]"
            >
              {INVENTORY_FILTERS.map((f) => (
                <option key={f} value={f}>
                  {FILTER_LABEL[f]}
                </option>
              ))}
            </Select>
          </div>

          {!loading && !error && items.length === 0 ? (
            <EmptyState
              title="Nada con esos filtros"
              description="Prueba otra bodega o quita el filtro. Si la pieza existe pero nunca entró, no aparece aquí: primero hay que cargarla o importarla."
            />
          ) : null}

          {items.length ? (
            <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border)]">
              <table className="w-full text-left">
                <thead className="bg-[var(--surface-sunken)]">
                  <tr>
                    <th className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
                      Pieza
                    </th>
                    <th className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)] sm:table-cell">
                      Bodega
                    </th>
                    <th className="hidden px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)] md:table-cell">
                      Ubicación
                    </th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
                      Físico
                    </th>
                    <th className="hidden px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)] sm:table-cell">
                      Reservado
                    </th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
                      Disponible
                    </th>
                    <th className="hidden px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)] lg:table-cell">
                      Mínimo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <Row
                      key={`${row.variantId}-${row.warehouseId}`}
                      row={row}
                      canAdjust={canAdjust}
                      onSaved={refresh}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

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
                    setQuery((c) => ({ ...c, offset: Math.max((c.offset ?? 0) - (c.limit ?? 40), 0) }))
                  }
                >
                  Anterior
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pageEnd >= data.total}
                  onClick={() => setQuery((c) => ({ ...c, offset: (c.offset ?? 0) + (c.limit ?? 40) }))}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === 'traslados' ? (
        <TransferPanel
          canTransfer={canTransfer}
          warehouses={warehouses}
          openCreate={creatingTransfer}
          onCreate={() => setCreatingTransfer(true)}
          onCloseCreate={() => setCreatingTransfer(false)}
          onChanged={refresh}
        />
      ) : null}

      {tab === 'movimientos' ? <MovementsPanel warehouses={warehouses} /> : null}
    </div>
  );
}

function Row({ row, canAdjust, onSaved }: { row: InventoryRow; canAdjust: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState<'reorder' | null>(null);

  return (
    <>
      <tr className="border-t border-[var(--border)] hover:bg-[var(--surface-sunken)]">
        <td className="px-3 py-2">
          <span className="flex flex-col">
            <span className="text-[13px] font-medium text-[var(--foreground)]">{row.partName}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {row.title && row.title !== row.partName ? (
                <span className="text-[11.5px] text-[var(--foreground-muted)]">{row.title}</span>
              ) : null}
              <span className="font-mono text-[11px] text-[var(--foreground-muted)]">{row.sku}</span>
              {row.brand ? (
                <span className="text-[11px] text-[var(--foreground-muted)]">· {row.brand}</span>
              ) : null}
            </span>
          </span>
        </td>
        <td className="hidden px-3 py-2 text-[12.5px] text-[var(--foreground-muted)] sm:table-cell">
          {row.warehouseCode}
        </td>
        <td className="hidden px-3 py-2 md:table-cell">
          {row.binLocation ? (
            <CodeChip label="ubi">{row.binLocation}</CodeChip>
          ) : (
            <button
              type="button"
              disabled={!canAdjust}
              onClick={() => setEditing('reorder')}
              className="text-[11px] text-[var(--color-copper-700)] hover:underline disabled:text-[var(--foreground-muted)] disabled:no-underline"
            >
              {canAdjust ? 'asignar' : 'sin ubicación'}
            </button>
          )}
        </td>
        <td className="partops-num px-3 py-2 text-right text-[12.5px] text-[var(--foreground)]">
          {row.onHand}
        </td>
        <td className="partops-num hidden px-3 py-2 text-right text-[12.5px] text-[var(--foreground-muted)] sm:table-cell">
          {row.reserved || '—'}
        </td>
        <td className="px-3 py-2 text-right">
          <StockPill quantity={row.available} reorderPoint={row.reorderPoint} />
        </td>
        <td className="hidden px-3 py-2 text-right lg:table-cell">
          {canAdjust ? (
            <button
              type="button"
              onClick={() => setEditing('reorder')}
              className="partops-num text-[12px] text-[var(--color-copper-700)] hover:underline"
            >
              {row.reorderPoint === null ? 'definir' : row.reorderPoint}
            </button>
          ) : (
            <span className="partops-num text-[12px] text-[var(--foreground-muted)]">
              {row.reorderPoint ?? '—'}
            </span>
          )}
        </td>
      </tr>
      {editing ? (
        <tr className="border-t border-[var(--border)] bg-[var(--surface-sunken)]">
          <td colSpan={7} className="px-3 py-2">
            <ReorderForm row={row} onClose={() => setEditing(null)} onSaved={onSaved} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Mínimo y ubicación en línea.
 *
 * Se edita dentro de la tabla y no en un panel aparte: el encargado recorre la lista de bajo mínimo
 * y define el punto de reorden de diez piezas seguidas; abrir y cerrar un panel por cada una
 * convierte cinco minutos de trabajo en veinte.
 */
function ReorderForm({
  row,
  onClose,
  onSaved,
}: {
  row: InventoryRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reorderPoint, setReorderPoint] = useState(row.reorderPoint === null ? '' : String(row.reorderPoint));
  const [binLocation, setBinLocation] = useState(row.binLocation ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api(`/api/inventory/variants/${row.variantId}/reorder`, {
        method: 'POST',
        body: {
          warehouseId: row.warehouseId,
          reorderPoint: reorderPoint.trim() === '' ? null : Number(reorderPoint),
          binLocation: binLocation.trim() || null,
        },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-2">
      <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
        Mínimo
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={reorderPoint}
          onChange={(e) => setReorderPoint(e.target.value)}
          placeholder="sin aviso"
          className="mt-1 block h-9 w-24 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[13px] text-[var(--foreground)]"
        />
      </label>
      <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
        Pasillo / estante
        <input
          type="text"
          maxLength={40}
          value={binLocation}
          onChange={(e) => setBinLocation(e.target.value)}
          placeholder="P-03-A2"
          spellCheck={false}
          className="mt-1 block h-9 w-32 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--surface)] px-2 font-mono text-[13px] text-[var(--foreground)]"
        />
      </label>
      <Button size="sm" type="submit" loading={pending}>
        Guardar
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={onClose}>
        Cancelar
      </Button>
      {error ? <span className="text-[12px] text-[var(--color-stock-out)]">{error}</span> : null}
      <span className="ml-auto text-[11px] text-[var(--foreground-muted)]">
        El mínimo no mueve existencia: solo decide cuándo avisar que hay que pedir.
      </span>
    </form>
  );
}

function readTab(): Tab {
  if (typeof window === 'undefined') return 'existencias';
  const valor = new URLSearchParams(window.location.search).get('vista');
  return valor === 'traslados' || valor === 'movimientos' ? valor : 'existencias';
}

function readQuery(): InventoryListQueryInput {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const out: Record<string, unknown> = {};
  for (const key of ['q', 'warehouseId', 'filter', 'limit', 'offset'] as const) {
    const raw = params.get(key);
    if (raw === null || raw === '') continue;
    const field = inventoryListQuerySchema.shape[key].safeParse(raw);
    if (field.success) out[key] = field.data;
  }
  return out as InventoryListQueryInput;
}
