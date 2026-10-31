'use client';

import { type AuditResponse, type AuditRow, actionLabel, entityLabel } from '@partops/contracts';
import { CodeChip, EmptyState } from '@partops/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/**
 * Bitácora de cambios.
 *
 * Se abre cuando algo no cuadra: un precio que cambió solo, un pedido cancelado, un rol que ya no
 * puede despachar. La pantalla no es un visor de logs técnicos; es la respuesta a «¿quién hizo
 * esto?» con fecha, persona y la diferencia concreta.
 *
 * Detalles de lectura:
 *
 *  - La hora se pinta en la zona del negocio. `createdAt` llega en UTC porque es lo que compara la
 *    base; convertir aquí evita discutir zonas en cada consulta.
 *  - La diferencia se abre en un desplegable y se enseña solo lo que cambió: volcar la fila entera
 *    obliga a buscar el campo movido entre veinte que no cambian.
 *  - Los valores nulos se muestran como «—» y no como «null»: la pantalla es en español.
 */
const PAGE = 50;

export function AuditScreen({ canSeeIp }: { canSeeIp: boolean }) {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [openRow, setOpenRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (entity) params.set('entity', entity);
    if (action) params.set('action', action);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', String(PAGE));
    params.set('offset', String(offset));

    try {
      setData(await api<AuditResponse>(`/api/audit?${params.toString()}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [entity, action, from, to, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const actions = useMemo(() => data?.actions ?? [], [data]);
  const entities = useMemo(() => data?.entities ?? [], [data]);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          Auditoría
        </h1>
        <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">
          Quién cambió qué y cuándo. Los cambios sensibles se registran en la misma transacción que los
          aplica: si algo se revierte, su registro también.
        </p>
      </header>

      <section aria-labelledby="filtros" className="mb-4">
        <h2 id="filtros" className="sr-only">
          Filtros
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto_auto]">
          <label className="block">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
              Entidad
            </span>
            <select
              value={entity}
              onChange={(event) => {
                setEntity(event.target.value);
                setOffset(0);
              }}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12.5px]"
            >
              <option value="">Todas</option>
              {entities.map((value) => (
                <option key={value} value={value}>
                  {entityLabel(value)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
              Acción
            </span>
            <select
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setOffset(0);
              }}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12.5px]"
            >
              <option value="">Todas</option>
              {actions.map((value) => (
                <option key={value} value={value}>
                  {actionLabel(value)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
              Desde
            </span>
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setOffset(0);
              }}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12.5px]"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
              Hasta
            </span>
            <input
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setOffset(0);
              }}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12.5px]"
            />
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={() => {
                setEntity('');
                setAction('');
                setFrom('');
                setTo('');
                setOffset(0);
              }}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-1.5 text-[12px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
            >
              Limpiar
            </button>
          </div>
        </div>
      </section>

      {error ? (
        <p className="mb-4 rounded-[var(--radius-sm)] border border-[var(--color-stock-out)] px-3 py-2 text-[12.5px] text-[var(--color-stock-out)]">
          {error}
        </p>
      ) : null}

      {loading && !data ? (
        <p className="text-[12.5px] text-[var(--foreground-muted)]">Cargando…</p>
      ) : data && data.items.length === 0 ? (
        <EmptyState
          title="Sin cambios en este filtro"
          description="Cuando alguien edite precios, ajuste existencias, cancele un pedido o cambie el equipo, aparece aquí."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border)]">
            <table className="w-full border-collapse text-[12.5px]">
              <caption className="sr-only">Cambios registrados</caption>
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-sunken)] text-left">
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Cuándo
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Quién
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Qué
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Entidad
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Detalle
                  </th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((row) => (
                  <AuditTr
                    key={row.id}
                    row={row}
                    canSeeIp={canSeeIp}
                    open={openRow === row.id}
                    onToggle={() => setOpenRow((prev) => (prev === row.id ? null : row.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between text-[12px] text-[var(--foreground-muted)]">
            <span>{data ? `${offset + 1}–${Math.min(offset + PAGE, data.total)} de ${data.total}` : ''}</span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset((prev) => Math.max(0, prev - PAGE))}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-1 disabled:opacity-40"
              >
                Anterior
              </button>
              <button
                type="button"
                disabled={!data || offset + PAGE >= data.total}
                onClick={() => setOffset((prev) => prev + PAGE)}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-1 disabled:opacity-40"
              >
                Siguiente
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AuditTr({
  row,
  canSeeIp,
  open,
  onToggle,
}: {
  row: AuditRow;
  canSeeIp: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const changed = row.after !== null || row.before !== null;
  return (
    <>
      <tr className="border-b border-[var(--border)] last:border-b-0">
        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-[var(--foreground-muted)]">
          {formatStamp(row.createdAt)}
        </td>
        <td className="px-3 py-2">
          <span className="block text-[var(--foreground)]">{row.actorName ?? 'Sistema'}</span>
          {row.actorEmail ? (
            <span className="block text-[11px] text-[var(--foreground-muted)]">{row.actorEmail}</span>
          ) : null}
        </td>
        <td className="px-3 py-2 text-[var(--foreground)]">{actionLabel(row.action)}</td>
        <td className="px-3 py-2">
          <CodeChip tone="muted">{entityLabel(row.entity)}</CodeChip>
        </td>
        <td className="px-3 py-2">
          {changed ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="text-[11.5px] font-medium text-[var(--color-copper-700)] hover:underline"
            >
              {open ? 'Ocultar' : 'Ver cambio'}
            </button>
          ) : (
            <span className="text-[11.5px] text-[var(--foreground-muted)]">—</span>
          )}
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-[var(--border)] bg-[var(--surface-sunken)]">
          <td colSpan={5} className="px-3 py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <DiffBlock title="Antes" value={row.before} />
              <DiffBlock title="Después" value={row.after} />
            </div>
            {canSeeIp && row.ip ? (
              <p className="mt-2 font-mono text-[10.5px] text-[var(--foreground-muted)]">IP {row.ip}</p>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function DiffBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
        {title}
      </p>
      {value === null || value === undefined ? (
        <p className="text-[12px] text-[var(--foreground-muted)]">—</p>
      ) : (
        <pre className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** `2026-10-30T18:05:00Z` → `30 oct 2026, 12:05` en la zona del negocio. */
function formatStamp(iso: string): string {
  return new Intl.DateTimeFormat('es-GT', {
    timeZone: 'America/Guatemala',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
