'use client';

import {
  MOVEMENT_TYPE_LABEL,
  MOVEMENT_TYPES,
  type MovementListResponse,
  type MovementTypeKey,
  type WarehouseOption,
} from '@partops/contracts';
import { Alert, Button, CodeChip, EmptyState, Select } from '@partops/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/**
 * Ledger de inventario.
 *
 * Se lee como un extracto de banco: fecha, qué pasó, cuánto cambió y con qué saldo quedó. No hay
 * botón de editar ni de borrar porque la tabla es inmutable por trigger en la base: si un movimiento
 * está mal, se corrige con otro movimiento que lo explique, y los dos quedan a la vista.
 *
 * Las reservas y liberaciones se esconden a propósito: son movimientos de disponibilidad, no del
 * estante, y en una lista de 50 llenarían la vista de ceros que no cambiaron nada.
 */
export function MovementsPanel({ warehouses }: { warehouses: WarehouseOption[] }) {
  const [type, setType] = useState<MovementTypeKey | ''>('');
  const [warehouseId, setWarehouseId] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<MovementListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const params = new URLSearchParams({ limit: '50', offset: String(offset) });
    if (type) params.set('type', type);
    if (warehouseId) params.set('warehouseId', warehouseId);

    setLoading(true);
    setError(null);
    try {
      const res = await api<MovementListResponse>(`/api/inventory/movements?${params}`);
      if (mine === seq.current) setData(res);
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [type, warehouseId, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = data?.items ?? [];
  const pageEnd = offset + items.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Tipo de movimiento"
          value={type}
          onChange={(e) => {
            setType(e.target.value as MovementTypeKey | '');
            setOffset(0);
          }}
          className="h-9 w-auto text-[13px]"
        >
          <option value="">Todo tipo</option>
          {MOVEMENT_TYPES.filter((t) => t !== 'RESERVA' && t !== 'LIBERACION').map((t) => (
            <option key={t} value={t}>
              {MOVEMENT_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Bodega del movimiento"
          value={warehouseId}
          onChange={(e) => {
            setWarehouseId(e.target.value);
            setOffset(0);
          }}
          className="h-9 w-auto text-[13px]"
        >
          <option value="">Todas las bodegas</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {w.name}
            </option>
          ))}
        </Select>
        <span className="text-[11.5px] text-[var(--foreground-muted)]">
          {data ? `${data.total} movimientos` : 'Cargando…'}
        </span>
      </div>

      {error ? (
        <Alert tone="error" title="No se pudo leer el historial">
          {error}
        </Alert>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <EmptyState
          title="Sin movimientos"
          description="Cada entrada, salida y ajuste queda aquí para siempre. Si todavía no hay nada, la primera compra o importación va a abrir el historial."
        />
      ) : null}

      {items.length ? (
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border)]">
          <table className="w-full text-left">
            <thead className="bg-[var(--surface-sunken)]">
              <tr>
                {[
                  ['Cuándo', ''],
                  ['Pieza', ''],
                  ['Qué pasó', ''],
                  ['Bodega', 'hidden sm:table-cell'],
                  ['Cambio', 'text-right'],
                  ['Saldo', 'text-right'],
                ].map(([label, extra]) => (
                  <th
                    key={label}
                    className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)] ${extra}`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-t border-[var(--border)]">
                  <td className="whitespace-nowrap px-3 py-2 text-[11.5px] text-[var(--foreground-muted)]">
                    {formatMoment(m.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="block text-[12.5px] text-[var(--foreground)]">{m.partName}</span>
                    <span className="font-mono text-[10.5px] text-[var(--foreground-muted)]">{m.sku}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="block text-[12px] text-[var(--foreground)]">
                      {MOVEMENT_TYPE_LABEL[m.type] ?? m.type}
                    </span>
                    <span className="block text-[10.5px] text-[var(--foreground-muted)]">
                      {[m.reason, m.userName].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2 text-[11.5px] text-[var(--foreground-muted)] sm:table-cell">
                    <CodeChip>{m.warehouseCode}</CodeChip>
                  </td>
                  <td
                    className={`partops-num px-3 py-2 text-right text-[12.5px] font-medium ${
                      m.delta > 0 ? 'text-[var(--color-stock-ok)]' : 'text-[var(--color-stock-out)]'
                    }`}
                  >
                    {m.delta > 0 ? `+${m.delta}` : m.delta}
                  </td>
                  <td className="partops-num px-3 py-2 text-right text-[12.5px] text-[var(--foreground)]">
                    {m.balanceAfter}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data && (data.total > 50 || offset > 0) ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-[var(--foreground-muted)]">
            {offset + 1}–{pageEnd} de {data.total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset <= 0}
              onClick={() => setOffset((o) => Math.max(o - 50, 0))}
            >
              Anterior
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pageEnd >= data.total}
              onClick={() => setOffset((o) => o + 50)}
            >
              Siguiente
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatMoment(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-GT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
