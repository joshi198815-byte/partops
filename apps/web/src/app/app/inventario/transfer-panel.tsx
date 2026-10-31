'use client';

import {
  nextTransferAction,
  type StockTransferDetail,
  type StockTransferSummary,
  TRANSFER_STATUS_LABEL,
  type TransferStatusKey,
  type VariantOption,
  type WarehouseOption,
} from '@partops/contracts';
import { Alert, Button, CodeChip, EmptyState, Select } from '@partops/ui';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/**
 * Traslados entre bodegas.
 *
 * La lista muestra el estado y el siguiente paso, no un menú de acciones posibles: convertir al
 * bodeguero en intérprete de la máquina de estados es la forma más rápida de que despache un
 * traslado ya recibido. El detalle se abre debajo de la fila —no en otra página— porque al recibir
 * un traslado hay que cotejar caja por caja contra lo enviado.
 */
export function TransferPanel({
  canTransfer,
  warehouses,
  openCreate,
  onCreate,
  onCloseCreate,
  onChanged,
}: {
  canTransfer: boolean;
  warehouses: WarehouseOption[];
  openCreate: boolean;
  onCreate: () => void;
  onCloseCreate: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<TransferStatusKey | ''>('');
  const [items, setItems] = useState<StockTransferSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const res = await api<{ items: StockTransferSummary[]; total: number }>(
        `/api/inventory/transfers?${params}`,
      );
      setItems(res.items);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  function afterChange() {
    void load();
    onChanged();
  }

  return (
    <div className="space-y-3">
      {error ? (
        <Alert tone="error" title="No se pudieron cargar los traslados">
          {error}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Estado del traslado"
          value={status}
          onChange={(e) => setStatus(e.target.value as TransferStatusKey | '')}
          className="h-9 w-auto text-[13px]"
        >
          <option value="">Todos</option>
          {(['SOLICITADO', 'ENVIADO', 'RECIBIDO', 'CANCELADO'] as const).map((s) => (
            <option key={s} value={s}>
              {TRANSFER_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <span className="text-[11.5px] text-[var(--foreground-muted)]">
          En tránsito no cuenta en ninguna bodega: sale del origen al despachar y entra al destino al recibir.
        </span>
      </div>

      {openCreate && canTransfer ? (
        <TransferForm
          warehouses={warehouses}
          onClose={onCloseCreate}
          onSaved={() => {
            onCloseCreate();
            afterChange();
          }}
        />
      ) : null}

      {items && items.length === 0 ? (
        <EmptyState
          title="Sin traslados"
          description="Cuando una sucursal pida pieza a la central, el traslado aparece aquí con su folio y su estado."
          action={
            canTransfer ? (
              <Button size="sm" onClick={onCreate}>
                Nuevo traslado
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {items?.length ? (
        <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
          {items.map((t) => (
            <li key={t.id} className="border-b border-[var(--border)] last:border-b-0">
              <button
                type="button"
                onClick={() => setOpenId(openId === t.id ? null : t.id)}
                aria-expanded={openId === t.id}
                className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-[var(--surface-sunken)]"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <CodeChip label="folio">{t.code}</CodeChip>
                  <span className="text-[13px] text-[var(--foreground)]">
                    {t.from.code} → {t.to.code}
                  </span>
                  <span className="text-[11.5px] text-[var(--foreground-muted)]">
                    {t.itemCount} {t.itemCount === 1 ? 'pieza' : 'piezas'} · {t.units} u
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={t.status} />
                  <span className="text-[11px] text-[var(--foreground-muted)]">
                    {formatDate(t.createdAt)}
                  </span>
                </span>
              </button>
              {openId === t.id ? (
                <TransferDetail
                  id={t.id}
                  canTransfer={canTransfer}
                  onChanged={afterChange}
                  onClose={() => setOpenId(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: TransferStatusKey }) {
  const tone =
    status === 'RECIBIDO'
      ? 'text-[var(--color-stock-ok)] border-[color-mix(in_oklch,var(--color-stock-ok)_30%,transparent)]'
      : status === 'CANCELADO'
        ? 'text-[var(--foreground-muted)] border-[var(--border)]'
        : status === 'ENVIADO'
          ? 'text-[var(--color-copper-700)] border-[color-mix(in_oklch,var(--color-copper-600)_40%,transparent)]'
          : 'text-[var(--color-stock-low)] border-[color-mix(in_oklch,var(--color-stock-low)_35%,transparent)]';

  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {TRANSFER_STATUS_LABEL[status]}
    </span>
  );
}

function TransferDetail({
  id,
  canTransfer,
  onChanged,
  onClose,
}: {
  id: string;
  canTransfer: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [transfer, setTransfer] = useState<StockTransferDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    try {
      setTransfer(await api<StockTransferDetail>(`/api/inventory/transfers/${id}`));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<StockTransferDetail>(`/api/inventory/transfers/${id}/${path}`, {
        method: 'POST',
        body: body ?? {},
      });
      setTransfer(next);
      setReceived({});
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!transfer) {
    return (
      <div className="border-t border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-3 text-[12px] text-[var(--foreground-muted)]">
        {error ?? 'Cargando…'}
      </div>
    );
  }

  const action = nextTransferAction(transfer.status, transfer.pendingUnits);

  /**
   * Cantidades por línea: vacío = "llegó todo lo pendiente", que es el caso normal. Solo se manda la
   * línea que el bodeguero tocó, para no cerrar por error las que no revisó.
   */
  function receive() {
    const lines = Object.entries(received)
      .map(([itemId, raw]) => ({ itemId, quantity: Number(raw) }))
      .filter((l) => Number.isFinite(l.quantity) && l.quantity >= 0);
    void act('receive', { items: lines.length ? lines : undefined, notes: notes.trim() || undefined });
  }

  const pendingLines = transfer.items.filter((i) => i.pending > 0);

  return (
    <div className="space-y-3 border-t border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--foreground-muted)]">
        <span>
          Origen <strong className="text-[var(--foreground)]">{transfer.from.code}</strong> · destino{' '}
          <strong className="text-[var(--foreground)]">{transfer.to.code}</strong>
        </span>
        {transfer.createdByName ? <span>Creado por {transfer.createdByName}</span> : null}
        {transfer.sentAt ? <span>Despachado {formatDate(transfer.sentAt)}</span> : null}
        {transfer.receivedAt ? <span>Recibido {formatDate(transfer.receivedAt)}</span> : null}
        {transfer.pendingUnits > 0 && transfer.status === 'ENVIADO' ? (
          <span className="text-[var(--color-copper-700)]">{transfer.pendingUnits} u en tránsito</span>
        ) : null}
      </div>

      {transfer.notes ? (
        <p className="rounded-[var(--radius-xs)] bg-[var(--surface)] px-2 py-1.5 text-[12px] text-[var(--foreground-muted)]">
          {transfer.notes}
        </p>
      ) : null}

      <table className="w-full text-left">
        <thead>
          <tr>
            {['Pieza', 'Enviado', 'Recibido', 'Pendiente'].map((h) => (
              <th
                key={h}
                className="pb-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]"
              >
                {h}
              </th>
            ))}
            {transfer.status === 'ENVIADO' && canTransfer ? <th aria-label="A recibir" /> : null}
          </tr>
        </thead>
        <tbody>
          {transfer.items.map((item) => (
            <tr key={item.id} className="border-t border-[var(--border)]">
              <td className="py-1.5 pr-2">
                <span className="block text-[12.5px] text-[var(--foreground)]">{item.partName}</span>
                <span className="font-mono text-[10.5px] text-[var(--foreground-muted)]">{item.sku}</span>
              </td>
              <td className="partops-num py-1.5 pr-2 text-[12.5px] text-[var(--foreground)]">
                {item.quantity}
              </td>
              <td className="partops-num py-1.5 pr-2 text-[12.5px] text-[var(--foreground-muted)]">
                {item.receivedQty}
              </td>
              <td className="partops-num py-1.5 pr-2 text-[12.5px]">
                <span
                  className={
                    item.pending > 0 ? 'text-[var(--color-copper-700)]' : 'text-[var(--foreground-muted)]'
                  }
                >
                  {item.pending}
                </span>
              </td>
              {transfer.status === 'ENVIADO' && canTransfer ? (
                <td className="py-1.5">
                  <input
                    type="number"
                    min={0}
                    max={item.pending}
                    inputMode="numeric"
                    value={received[item.id] ?? ''}
                    onChange={(e) => setReceived((c) => ({ ...c, [item.id]: e.target.value }))}
                    placeholder={String(item.pending)}
                    aria-label={`Cantidad recibida de ${item.sku}`}
                    className="h-8 w-16 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--surface)] px-1.5 text-right text-[12.5px] text-[var(--foreground)]"
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {action && canTransfer ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
          {transfer.status === 'SOLICITADO' ? (
            <>
              <span className="text-[11px] text-[var(--foreground-muted)]">
                Nada ha salido todavía: la pieza sigue contada en {transfer.from.code}.
              </span>
              <Button size="sm" loading={busy} onClick={() => void act('send')}>
                {action.label}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void act('cancel', { reason: notes.trim() || undefined })}
              >
                Cancelar traslado
              </Button>
              <span className="text-[11px] text-[var(--foreground-muted)]">
                Al despachar, la pieza sale del origen: deja de contar ahí aunque todavía no llegue.
              </span>
            </>
          ) : null}

          {transfer.status === 'ENVIADO' ? (
            <>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Nota de recepción (opcional)"
                maxLength={500}
                className="h-9 min-w-[200px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-[12.5px] text-[var(--foreground)]"
              />
              <Button size="sm" loading={busy} onClick={receive}>
                {action.label}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void act('cancel', { reason: notes.trim() || undefined })}
              >
                Cancelar
              </Button>
              {Object.keys(received).length ? (
                <span className="text-[11px] text-[var(--foreground-muted)]">
                  {pendingLines.length} líneas pendientes · lo que dejes en blanco se recibe completo
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onClose}
        className="text-[11.5px] text-[var(--foreground-muted)] hover:underline"
      >
        Cerrar detalle
      </button>
    </div>
  );
}

function TransferForm({
  warehouses,
  onClose,
  onSaved,
}: {
  warehouses: WarehouseOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [from, setFrom] = useState(warehouses.find((w) => w.isDefault)?.id ?? warehouses[0]?.id ?? '');
  const [to, setTo] = useState(warehouses.find((w) => w.id !== from)?.id ?? '');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<
    Array<{ variantId: string; sku: string; partName: string; title: string; quantity: string }>
  >([]);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<VariantOption[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Buscador con retardo: escribir seis letras no debe disparar seis consultas al pasillo.
  useEffect(() => {
    if (!from) return;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: search, warehouseId: from, limit: '20' });
        setOptions(await api<VariantOption[]>(`/api/inventory/variants?${params}`));
      } catch {
        setOptions([]);
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [search, from]);

  function add(option: VariantOption) {
    setLines((current) => {
      if (current.some((l) => l.variantId === option.variantId)) return current;
      return [
        ...current,
        {
          variantId: option.variantId,
          sku: option.sku,
          partName: option.partName,
          title: option.title,
          quantity: '1',
        },
      ];
    });
    setSearch('');
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api('/api/inventory/transfers', {
        method: 'POST',
        body: {
          fromWarehouseId: from,
          toWarehouseId: to,
          notes: notes.trim() || undefined,
          items: lines.map((l) => ({ variantId: l.variantId, quantity: Number(l.quantity) })),
        },
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const sameWarehouse = from && to && from === to;

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <span className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
            Desde
          </span>
          <Select
            aria-label="Bodega de origen"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-auto min-w-[140px] text-[13px]"
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </Select>
        </span>
        <span className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
            Hacia
          </span>
          <Select
            aria-label="Bodega de destino"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-auto min-w-[140px] text-[13px]"
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </Select>
        </span>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Nota para el que recibe (opcional)"
          maxLength={500}
          className="h-9 min-w-[180px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--foreground)]"
        />
      </div>

      {warehouses.length < 2 ? (
        <Alert tone="info" title="Solo hay una bodega">
          Para trasladar hace falta una segunda bodega activa. Créala en Configuración.
        </Alert>
      ) : null}

      <div className="relative">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar pieza para agregar (SKU, nombre u OEM)"
          spellCheck={false}
          autoComplete="off"
          aria-label="Buscar pieza para el traslado"
          className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--foreground)]"
        />
        {search.trim() && options.length ? (
          <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-sm">
            {options.map((option) => (
              <li key={option.variantId}>
                <button
                  type="button"
                  onClick={() => add(option)}
                  className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--surface-sunken)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] text-[var(--foreground)]">
                      {option.partName}
                      {option.title && option.title !== option.partName ? ` · ${option.title}` : ''}
                    </span>
                    <span className="font-mono text-[10.5px] text-[var(--foreground-muted)]">
                      {option.sku}
                    </span>
                  </span>
                  <span className="partops-num shrink-0 text-[11.5px] text-[var(--foreground-muted)]">
                    {Math.max(0, option.onHand - option.reserved)} disp
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {lines.length ? (
        <ul className="space-y-1">
          {lines.map((line) => (
            <li key={line.variantId} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--foreground)]">
                {line.partName}
                {line.title && line.title !== line.partName ? ` · ${line.title}` : ''}{' '}
                <span className="font-mono text-[10.5px] text-[var(--foreground-muted)]">{line.sku}</span>
              </span>
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={line.quantity}
                onChange={(e) =>
                  setLines((current) =>
                    current.map((l) =>
                      l.variantId === line.variantId ? { ...l, quantity: e.target.value } : l,
                    ),
                  )
                }
                aria-label={`Cantidad de ${line.sku}`}
                className="h-8 w-16 rounded-[var(--radius-xs)] border border-[var(--border-strong)] bg-[var(--surface)] px-1.5 text-right text-[12.5px] text-[var(--foreground)]"
              />
              <button
                type="button"
                onClick={() => setLines((c) => c.filter((l) => l.variantId !== line.variantId))}
                className="text-[11.5px] text-[var(--foreground-muted)] hover:underline"
              >
                quitar
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-[var(--foreground-muted)]">
          Sin piezas todavía. Agrega al menos una para solicitar el traslado.
        </p>
      )}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          type="submit"
          loading={pending}
          disabled={!lines.length || !from || !to || Boolean(sameWarehouse)}
        >
          Solicitar traslado
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        {sameWarehouse ? (
          <span className="text-[11.5px] text-[var(--color-stock-out)]">
            Origen y destino son la misma bodega
          </span>
        ) : (
          <span className="text-[11px] text-[var(--foreground-muted)]">
            Solicitar no mueve existencia: recién al despachar sale de{' '}
            {warehouses.find((w) => w.id === from)?.code ?? 'origen'}.
          </span>
        )}
      </div>
    </form>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-GT', { day: '2-digit', month: 'short' });
}
