'use client';

import type { DemandOverview, DemandRow, StockWatchGroup, StockWatchNotification } from '@partops/contracts';
import { Alert, EmptyState, StatTile } from '@partops/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/**
 * Panel de demanda.
 *
 * Tres preguntas, en el orden en que se hacen en una bodega:
 *
 *  1. **¿Qué compro?** La tabla de faltantes, ordenada por lo que más veces se buscó y no había.
 *     Cada fila trae el botón de WhatsApp de la bandeja cuando hay gente esperando esa pieza.
 *  2. **¿A quién le aviso?** La bandeja de "avísame cuando llegue", agrupada por pieza, con la
 *     existencia de hoy. Un grupo con existencia es una llamada pendiente, no un dato.
 *  3. **¿Está mejorando?** La serie diaria y la conversión: sin esto, la lista de faltantes crece
 *     para siempre y nadie sabe si el catálogo está sirviendo.
 *
 * El panel no pide nada que no pueda mostrar: si no hay `demand.watch.manage` los botones de envío
 * no existen, no se ven deshabilitados. Un botón apagado que nunca se va a encender es ruido.
 */
export function DemandScreen({
  canNotify,
  shopSlug,
}: {
  canNotify: boolean;
  canSeeCost: boolean;
  shopSlug: string;
}) {
  const [data, setData] = useState<DemandOverview | null>(null);
  const [tray, setTray] = useState<{ groups: StockWatchGroup[]; pending: number; ready: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<StockWatchNotification | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [overview, watches] = await Promise.all([
        api<DemandOverview>('/api/demand'),
        api<{ groups: StockWatchGroup[]; pending: number; ready: number }>('/api/demand/watch'),
      ]);
      setData(overview);
      setTray(watches);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openGroup(key: string) {
    setBusy(true);
    try {
      const url = `/api/demand/watch/${encodeURIComponent(key)}?catalogo=${encodeURIComponent(
        `${window.location.origin}/c/${shopSlug}`,
      )}`;
      setOpen(await api<StockWatchNotification>(url));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function markSent(notification: StockWatchNotification) {
    if (!canNotify) return;
    setBusy(true);
    try {
      await api('/api/demand/watch/notified', {
        method: 'POST',
        body: { ids: notification.customers.map((c) => c.id) },
      });
      setOpen(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(notification: StockWatchNotification) {
    setBusy(true);
    try {
      await api('/api/demand/watch', {
        method: 'DELETE',
        body: { ids: notification.customers.map((c) => c.id) },
      });
      setOpen(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <div className="mx-auto max-w-5xl">
        <Alert tone="error">{error}</Alert>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 py-2 text-[13px] font-medium"
        >
          Reintentar
        </button>
      </div>
    );
  }

  if (!data || !tray) {
    return <p className="text-[13px] text-[var(--foreground-muted)]">Cargando demanda…</p>;
  }

  const { totals, topTerms, byVehicle, byCategory, timeline, months } = data;
  const hasHistory = totals.searches > 0;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em]">
          Demanda
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-snug text-[var(--foreground-muted)]">
          Lo que la gente buscó y no había, en los últimos {data.windowDays} días. La primera columna es la
          lista de compras; la segunda, los clientes a los que hay que escribirles cuando llegue.
        </p>
      </header>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {!hasHistory ? (
        <EmptyState
          title="Todavía no hay búsquedas registradas"
          description="Cada búsqueda del mostrador y del catálogo en línea queda anotada con lo que se encontró. En cuanto alguien busque algo que no tengas, aparecerá aquí."
        />
      ) : (
        <>
          <section className="grid gap-px overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Búsquedas"
              value={String(totals.searches)}
              hint={`${data.windowDays} días`}
              className="rounded-none border-0"
            />
            <StatTile
              label="Sin resultado"
              value={String(totals.missed)}
              hint={`${formatPct(totals.missedRateBps)} de las búsquedas`}
              className="rounded-none border-0"
            />
            <StatTile
              label="Pedidos del catálogo"
              value={String(totals.catalogOrders)}
              hint={`${formatPct(totals.conversionBps)} de conversión`}
              className="rounded-none border-0"
            />
            <StatTile
              label="Esperando aviso"
              value={String(totals.watchers)}
              hint={tray.ready > 0 ? `${tray.ready} ya tienen existencia` : 'Ninguna pieza disponible aún'}
              className="rounded-none border-0"
            />
          </section>

          <section className="mt-6" aria-labelledby="faltantes">
            <h2
              id="faltantes"
              className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
            >
              Lo que no se encontró
            </h2>
            {topTerms.length ? (
              <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                <table className="w-full text-left">
                  <thead className="bg-[var(--surface-sunken)]">
                    <tr>
                      <Th>Se buscó</Th>
                      <Th>Vehículo</Th>
                      <Th align="right">Veces</Th>
                      <Th align="right">Sin resultado</Th>
                      <Th align="right">Última vez</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {topTerms.map((row) => (
                      <TermRow key={`${row.term}-${row.brand ?? ''}-${row.model ?? ''}`} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-[var(--radius-md)] border border-[var(--border)] px-4 py-6 text-center text-[12.5px] text-[var(--foreground-muted)]">
                Todo lo que se buscó en el periodo tuvo resultado.
              </p>
            )}
          </section>

          <section className="mt-6 grid gap-4 lg:grid-cols-2" aria-labelledby="bandeja">
            <div>
              <h2
                id="bandeja"
                className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
              >
                Avisar cuando llegue · {tray.pending} pendientes
              </h2>
              {tray.groups.length ? (
                <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                  {tray.groups.slice(0, 12).map((group) => (
                    <li key={group.key} className="flex items-center gap-3 bg-[var(--surface)] px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-[var(--foreground)]">
                          {group.term}
                        </p>
                        <p className="mt-0.5 text-[11.5px] text-[var(--foreground-muted)]">
                          {group.pending} {group.pending === 1 ? 'persona' : 'personas'} ·{' '}
                          {group.availableNow
                            ? `${group.availableUnits} disponibles`
                            : 'sin existencia todavía'}
                          {group.sku ? ` · ${group.sku}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void openGroup(group.key)}
                        disabled={busy}
                        className={
                          group.availableNow
                            ? 'shrink-0 rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 py-1.5 text-[12px] font-semibold text-[var(--primary-foreground)] disabled:opacity-50'
                            : 'shrink-0 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 py-1.5 text-[12px] font-medium disabled:opacity-50'
                        }
                      >
                        {group.availableNow ? 'Avisar' : 'Ver lista'}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-[var(--radius-md)] border border-[var(--border)] px-4 py-6 text-center text-[12.5px] text-[var(--foreground-muted)]">
                  Nadie pidió que le avisaran. La lista se llena sola desde la ficha de cada pieza agotada del
                  catálogo.
                </p>
              )}
            </div>

            <div>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
                Por vehículo
              </h2>
              {byVehicle.length ? (
                <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                  <table className="w-full text-left">
                    <thead className="bg-[var(--surface-sunken)]">
                      <tr>
                        <Th>Vehículo</Th>
                        <Th align="right">Búsquedas</Th>
                        <Th align="right">Faltantes</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {byVehicle.slice(0, 8).map((row) => (
                        <tr
                          key={`${row.brand}-${row.model}-${row.year ?? ''}`}
                          className="border-t border-[var(--border)]"
                        >
                          <Td>
                            <span className="font-medium">{row.brand}</span> {row.model}
                            {row.year ? ` ${row.year}` : ''}
                          </Td>
                          <Td align="right">{row.searches}</Td>
                          <Td align="right">{row.missed}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-[12.5px] text-[var(--foreground-muted)]">
                  Las búsquedas no mencionaron un vehículo.
                </p>
              )}
            </div>
          </section>

          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
                Por categoría
              </h2>
              {byCategory.length ? (
                <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                  {byCategory.slice(0, 8).map((row) => (
                    <li
                      key={row.category}
                      className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12.5px] last:border-b-0"
                    >
                      <span className="truncate">{row.category}</span>
                      <span className="partops-num shrink-0 text-[var(--foreground-muted)]">
                        {row.searches} · {row.missed} sin resultado
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-[var(--foreground-muted)]">
                  Sin categorías en el catálogo todavía.
                </p>
              )}
            </div>

            <div>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
                Evolución mensual
              </h2>
              {months.length ? (
                <MonthlyBars months={months} />
              ) : (
                <p className="text-[12.5px] text-[var(--foreground-muted)]">
                  El histórico mensual se arma con el cierre de cada día. Todavía no hay ningún día cerrado.
                </p>
              )}
            </div>
          </section>

          <section className="mt-6" aria-labelledby="diaria">
            <h2
              id="diaria"
              className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
            >
              Últimos {data.windowDays} días
            </h2>
            <DailyBars timeline={timeline} />
            <p className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-[var(--foreground-muted)]">
              <Legend className="bg-[var(--color-steel-700)]" label="Búsquedas" />
              <Legend className="bg-[var(--color-copper-500)]" label="Sin resultado" />
              <Legend className="bg-[var(--color-stock-ok)]" label="Pedidos del catálogo" />
            </p>
          </section>
        </>
      )}

      {open ? (
        <CustomerSheet
          notification={open}
          canNotify={canNotify}
          busy={busy}
          onClose={() => setOpen(null)}
          onSent={() => void markSent(open)}
          onDismiss={() => void dismiss(open)}
        />
      ) : null}
    </div>
  );
}

/**
 * Fila de faltante.
 *
 * Dice la última vez que se buscó en relativo ("hace 2 días"): una fecha exacta obliga a restar de
 * cabeza, y lo que importa es si el interés sigue vivo o es de hace un mes.
 */
function TermRow({ row }: { row: DemandRow }) {
  const vehicle = [row.brand, row.model, row.year].filter(Boolean).join(' ');
  return (
    <tr className="border-t border-[var(--border)] bg-[var(--surface)]">
      <Td>
        <span className="font-medium text-[var(--foreground)]">{row.term || '(vacío)'}</span>
      </Td>
      <Td>{vehicle || <span className="text-[var(--foreground-muted)]">—</span>}</Td>
      <Td align="right">{row.searches}</Td>
      <Td align="right">{row.missedCount}</Td>
      <Td align="right">
        <span className="text-[var(--foreground-muted)]">{relative(row.lastSeenAt)}</span>
      </Td>
    </tr>
  );
}

/**
 * Bandeja de clientes de una pieza.
 *
 * En móvil ocupa la pantalla completa y en escritorio un panel al costado: esta lista se usa de pie,
 * con el teléfono en la mano, y un modal centrado de 600 px obliga a hacer zoom para leer un número.
 */
function CustomerSheet({
  notification,
  canNotify,
  busy,
  onClose,
  onSent,
  onDismiss,
}: {
  notification: StockWatchNotification;
  canNotify: boolean;
  busy: boolean;
  onClose: () => void;
  onSent: () => void;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { group } = notification;

  const copy = useMemo(
    () => async () => {
      try {
        await navigator.clipboard.writeText(notification.broadcastText);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    },
    [notification.broadcastText],
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" role="dialog" aria-modal="true">
      <button type="button" aria-label="Cerrar" className="flex-1 cursor-default" onClick={onClose} />
      <div className="flex h-full w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--surface)]">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold">{group.partName ?? group.term}</p>
            <p className="mt-0.5 text-[11.5px] text-[var(--foreground-muted)]">
              {group.pending} {group.pending === 1 ? 'persona esperando' : 'personas esperando'}
              {group.sku ? ` · ${group.sku}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-sm)] px-2 py-1 text-[12px] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]"
          >
            Cerrar
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!group.availableNow ? (
            <Alert tone="info">
              Esta pieza todavía no tiene existencia en una bodega que venda en línea. Puedes avisar igual,
              pero el cliente vendrá a preguntar cuándo llega.
            </Alert>
          ) : null}

          <ul className="mt-2 divide-y divide-[var(--border)]">
            {notification.customers.map((customer) => (
              <li key={customer.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{customer.name}</p>
                  <p className="partops-num text-[11.5px] text-[var(--foreground-muted)]">
                    {customer.phone} · espera desde {relative(customer.waitedSince)}
                  </p>
                </div>
                {customer.whatsappUrl ? (
                  <a
                    href={customer.whatsappUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 py-1.5 text-[12px] font-semibold text-[var(--primary-foreground)]"
                  >
                    WhatsApp
                  </a>
                ) : (
                  <span className="shrink-0 text-[11px] text-[var(--foreground-muted)]">Sin WhatsApp</span>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-4 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5">
            <p className="whitespace-pre-line text-[12px] leading-relaxed">{notification.broadcastText}</p>
            <button
              type="button"
              onClick={() => void copy()}
              className="mt-2 rounded-[var(--radius-xs)] border border-[var(--border-strong)] px-2 py-1 text-[11.5px] font-medium"
            >
              {copied ? 'Copiado' : 'Copiar para el estado'}
            </button>
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-4 py-3">
          {canNotify ? (
            <button
              type="button"
              onClick={onSent}
              disabled={busy}
              className="h-10 flex-1 rounded-[var(--radius-sm)] bg-[var(--primary)] px-4 text-[13px] font-semibold text-[var(--primary-foreground)] disabled:opacity-50"
            >
              Marcar como avisados
            </button>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="h-10 rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 text-[12.5px] font-medium disabled:opacity-50"
          >
            Quitar de la lista
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Barras diarias.
 *
 * Altura proporcional sobre el máximo del periodo, con la serie de faltantes encima en cobre. Las
 * barras de menos de 2 px se dibujan de 2: un día con una sola búsqueda tiene que verse, porque
 * "nadie buscó" y "buscó uno" son noticias distintas.
 */
function DailyBars({ timeline }: { timeline: DemandOverview['timeline'] }) {
  const max = Math.max(1, ...timeline.map((d) => Math.max(d.searches, d.orders)));
  return (
    <div className="flex h-28 items-end gap-[2px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-1.5 pb-1.5 pt-3">
      {timeline.map((day) => {
        const total = Math.max(2, Math.round((day.searches / max) * 88));
        const missed = Math.max(0, Math.round((day.missed / max) * 88));
        const orders = Math.max(0, Math.round((day.orders / max) * 88));
        return (
          <div
            key={day.day}
            className="group relative flex flex-1 flex-col justify-end gap-px"
            title={`${day.day}: ${day.searches} búsquedas, ${day.missed} sin resultado, ${day.orders} pedidos`}
          >
            {orders ? (
              <span
                aria-hidden
                className="w-full rounded-t-[1px] bg-[var(--color-stock-ok)]"
                style={{ height: `${orders}px` }}
              />
            ) : null}
            <span
              aria-hidden
              className="w-full bg-[var(--color-steel-700)]"
              style={{ height: `${Math.max(0, total - missed)}px` }}
            />
            {missed ? (
              <span
                aria-hidden
                className="w-full rounded-t-[1px] bg-[var(--color-copper-500)]"
                style={{ height: `${missed}px` }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Mensual: número y barra, sin fechas. Doce filas se leen de arriba abajo como una lista. */
function MonthlyBars({ months }: { months: DemandOverview['months'] }) {
  const max = Math.max(1, ...months.map((m) => m.searches));
  return (
    <ul className="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3">
      {months.map((m) => (
        <li key={m.month} className="grid grid-cols-[64px_1fr_auto] items-center gap-2">
          <span className="partops-num font-mono text-[11px] text-[var(--foreground-muted)]">{m.month}</span>
          <span className="relative h-3 overflow-hidden rounded-[1px] bg-[var(--surface-sunken)]">
            <span
              className="absolute inset-y-0 left-0 bg-[var(--color-steel-700)]"
              style={{ width: `${Math.max(2, (m.searches / max) * 100)}%` }}
            />
            <span
              className="absolute inset-y-0 left-0 bg-[var(--color-copper-500)]"
              style={{ width: `${Math.max(0, (m.missed / max) * 100)}%` }}
            />
          </span>
          <span className="partops-num text-right text-[11.5px] text-[var(--foreground-muted)]">
            {m.searches} / {m.missed}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`size-2 rounded-[1px] ${className}`} />
      {label}
    </span>
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

/** Puntos base → "12,4 %". Con coma decimal, que es como se escribe en Guatemala. */
function formatPct(bps: number): string {
  return `${(bps / 100).toFixed(1).replace('.', ',')} %`;
}

/** Fecha relativa, sin librería: el panel solo muestra desde "hoy" hasta "hace un mes". */
function relative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 30) return `hace ${days} días`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'hace un mes' : `hace ${months} meses`;
}
