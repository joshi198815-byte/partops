'use client';

import {
  type AdminJobRow,
  type AdminOverview,
  type AdminTenantRow,
  PLAN_TIERS,
  type PlanTier,
  planActive,
  planLabel,
} from '@partops/contracts';
import { CodeChip, EmptyState } from '@partops/ui';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/**
 * Panel de plataforma.
 *
 * No es la pantalla de un cliente: es la mesa donde se decide quién sigue vendiendo con PartOps.
 * Por eso cada fila pesa —nombre, uso real de los últimos treinta días, plan vigente— y no un
 * selector de configuración genérico.
 *
 * Dos cosas se hacen aquí y ninguna se hace a ciegas:
 *
 *  - **Conceder un plan** deja una fila nueva en `plan_grant` y un renglón en la bitácora del
 *    negocio. El dueño puede ver en `/app/auditoria` el día que le cambiaron el plan.
 *  - **Suspender** no borra nada; corta el acceso. El botón se llama «Suspender» y pide confirmar
 *    porque es la única acción de esta pantalla que un cliente siente de inmediato: al siguiente
 *    clic no puede entrar a trabajar.
 */
export function AdminScreen() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<AdminOverview>('/api/platform/overview'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, run: () => Promise<unknown>, message: string) {
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await run();
      setNotice(message);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) {
    return <p className="text-[13px] text-[var(--color-stock-out)]">{error}</p>;
  }
  if (!data) return <p className="text-[13px] text-[var(--foreground-muted)]">Cargando…</p>;

  const suspended = data.tenants.filter((t) => t.suspended).length;
  const failedJobs = data.jobs.filter((j) => j.status === 'FAILED');
  const missRate =
    data.demand.searches30d > 0 ? Math.round((data.demand.missed30d / data.demand.searches30d) * 100) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em]">
            Plataforma
          </h1>
          <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">
            {data.tenants.length} negocios · {suspended} suspendidos
          </p>
        </div>
        <CodeChip tone="muted" label="Ruta">
          /api/platform
        </CodeChip>
      </div>

      {notice ? (
        <p className="mb-4 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-[12.5px]">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="mb-4 rounded-[var(--radius-sm)] border border-[var(--color-stock-out)] px-3 py-2 text-[12.5px] text-[var(--color-stock-out)]">
          {error}
        </p>
      ) : null}

      {/* Cifras de plataforma antes de la tabla: si el número de búsquedas sin respuesta sube, eso
          es lo que decide qué pieza buscar y qué negocio necesita ayuda. */}
      <section aria-labelledby="pulso" className="mb-7">
        <h2
          id="pulso"
          className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
        >
          Últimos 30 días
        </h2>
        <div className="grid gap-px overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Búsquedas" value={String(data.demand.searches30d)} />
          <Metric
            label="Sin resultado"
            value={String(data.demand.missed30d)}
            hint={missRate === null ? 'Sin búsquedas todavía' : `${missRate}% del total`}
            alert={(missRate ?? 0) >= 30}
          />
          <Metric label="Marcas" value={String(data.reference.brands)} hint="Referencia vehicular" />
          <Metric
            label="Vehículos"
            value={String(data.reference.vehicles)}
            hint={`${data.reference.models} modelos`}
          />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section aria-labelledby="negocios">
          <h2
            id="negocios"
            className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
          >
            Negocios
          </h2>
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border)]">
            <table className="w-full border-collapse text-[12.5px]">
              <caption className="sr-only">Negocios de la plataforma</caption>
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-sunken)] text-left">
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Negocio
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Plan
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Equipo
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Piezas
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Pedidos 30d
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((tenant) => (
                  <TenantTr
                    key={tenant.id}
                    tenant={tenant}
                    busy={busy}
                    editing={editing === tenant.id}
                    onEdit={() => setEditing((prev) => (prev === tenant.id ? null : tenant.id))}
                    onGrant={(tier, expiresAt, note) =>
                      act(
                        `plan:${tenant.id}`,
                        () =>
                          api(`/api/platform/tenants/${tenant.id}/plan`, {
                            method: 'POST',
                            body: { tier, expiresAt, note },
                          }),
                        `Plan ${tier} concedido a ${tenant.name}`,
                      ).then(() => setEditing(null))
                    }
                    onToggleSuspend={() => {
                      // Suspender es irreversible para el cliente hasta que alguien lo reactive: se
                      // confirma. Reactivar no se pregunta, porque devuelve el acceso.
                      if (
                        !tenant.suspended &&
                        !window.confirm(
                          `¿Suspender ${tenant.name}? Dejará de poder entrar hasta que lo reactives.`,
                        )
                      ) {
                        return;
                      }
                      return act(
                        `susp:${tenant.id}`,
                        () =>
                          api(
                            `/api/platform/tenants/${tenant.id}/${tenant.suspended ? 'resume' : 'suspend'}`,
                            { method: 'POST' },
                          ),
                        tenant.suspended ? `${tenant.name} reactivado` : `${tenant.name} suspendido`,
                      );
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {data.tenants.length === 0 ? (
            <EmptyState
              title="Todavía no hay negocios"
              description="Aparecerán aquí en cuanto alguien termine el asistente de configuración."
            />
          ) : null}
        </section>

        <div className="space-y-6">
          <section aria-labelledby="trabajos">
            <h2
              id="trabajos"
              className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
            >
              Trabajos
            </h2>
            {data.jobs.length === 0 ? (
              <p className="rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-4 text-[12.5px] text-[var(--foreground-muted)]">
                Sin corridas registradas. El mantenimiento diario escribe aquí su primera fila.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {data.jobs.slice(0, 8).map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
            {failedJobs.length ? (
              <p className="mt-2 text-[11.5px] text-[var(--color-stock-out)]">
                {failedJobs.length === 1
                  ? '1 trabajo falló. Revisa el último error antes de que se note en los reportes.'
                  : `${failedJobs.length} trabajos fallaron. Revisa el último error de cada uno.`}
              </p>
            ) : null}
          </section>

          <section aria-labelledby="terminos">
            <h2
              id="terminos"
              className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
            >
              Qué buscaron sin encontrar
            </h2>
            {data.demand.topTerms.length === 0 ? (
              <p className="text-[12.5px] text-[var(--foreground-muted)]">Sin búsquedas todavía.</p>
            ) : (
              <ol className="space-y-1">
                {data.demand.topTerms.map((term) => (
                  <li
                    key={term.term}
                    className="flex items-baseline justify-between gap-2 border-b border-[var(--border)] pb-1 text-[12.5px] last:border-b-0"
                  >
                    <span className="truncate">{term.term}</span>
                    <span className="partops-num font-mono text-[11.5px] text-[var(--foreground-muted)]">
                      {term.count}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  alert,
}: {
  label: string;
  value: string;
  hint?: string;
  alert?: boolean;
}) {
  return (
    <div className="bg-[var(--surface)] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
        {label}
      </p>
      <p
        className={`partops-num mt-1.5 font-[family-name:var(--font-display)] text-[24px] font-bold leading-none ${
          alert ? 'text-[var(--color-stock-out)]' : 'text-[var(--foreground)]'
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-[11.5px] text-[var(--foreground-muted)]">{hint}</p> : null}
    </div>
  );
}

function TenantTr({
  tenant,
  busy,
  editing,
  onEdit,
  onGrant,
  onToggleSuspend,
}: {
  tenant: AdminTenantRow;
  busy: string | null;
  editing: boolean;
  onEdit: () => void;
  onGrant: (tier: PlanTier, expiresAt: string | null, note: string) => void;
  onToggleSuspend: () => void;
}) {
  const [tier, setTier] = useState<PlanTier>('PRO');
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');

  const vigente = planActive(tenant.planExpiresAt);

  return (
    <>
      <tr className="border-b border-[var(--border)] last:border-b-0">
        <td className="px-3 py-2">
          <span className="block font-medium text-[var(--foreground)]">{tenant.name}</span>
          <span className="block font-mono text-[10.5px] text-[var(--foreground-muted)]">{tenant.slug}</span>
        </td>
        <td className="px-3 py-2">
          {tenant.suspended ? (
            <span className="text-[11.5px] font-medium text-[var(--color-stock-out)]">Suspendido</span>
          ) : (
            <>
              <span className={vigente ? 'text-[var(--foreground)]' : 'text-[var(--foreground-muted)]'}>
                {planLabel(tenant.planTier)}
              </span>
              {tenant.planExpiresAt ? (
                <span className="block font-mono text-[10.5px] text-[var(--foreground-muted)]">
                  vence {sliceDay(tenant.planExpiresAt)}
                </span>
              ) : null}
            </>
          )}
        </td>
        <td className="partops-num px-3 py-2 text-right font-mono">{tenant.members}</td>
        <td className="partops-num px-3 py-2 text-right font-mono">{tenant.parts}</td>
        <td className="partops-num px-3 py-2 text-right font-mono">{tenant.orders30d}</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onEdit}
              aria-expanded={editing}
              className="text-[11.5px] font-medium text-[var(--color-copper-700)] hover:underline"
            >
              {editing ? 'Cerrar' : 'Conceder plan'}
            </button>
            <button
              type="button"
              onClick={onToggleSuspend}
              disabled={busy === `susp:${tenant.id}`}
              className={`text-[11.5px] font-medium hover:underline disabled:opacity-40 ${
                tenant.suspended ? 'text-[var(--foreground)]' : 'text-[var(--color-stock-out)]'
              }`}
            >
              {tenant.suspended ? 'Reactivar' : 'Suspender'}
            </button>
          </div>
        </td>
      </tr>
      {editing ? (
        <tr className="border-b border-[var(--border)] bg-[var(--surface-sunken)]">
          <td colSpan={6} className="px-3 py-3">
            <form
              className="grid items-end gap-2 sm:grid-cols-[120px_180px_1fr_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                onGrant(tier, expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null, note);
              }}
            >
              <label className="block">
                <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                  Nivel
                </span>
                <select
                  value={tier}
                  onChange={(event) => setTier(event.target.value as PlanTier)}
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12.5px]"
                >
                  {PLAN_TIERS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                  Vence
                </span>
                <input
                  type="date"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12.5px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                  Nota
                </span>
                <input
                  type="text"
                  value={note}
                  maxLength={300}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Acordado por teléfono con la dueña"
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[12.5px]"
                />
              </label>
              <button
                type="submit"
                disabled={busy === `plan:${tenant.id}`}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] font-semibold hover:bg-[var(--surface-sunken)] disabled:opacity-40"
              >
                {busy === `plan:${tenant.id}` ? 'Guardando…' : 'Guardar plan'}
              </button>
            </form>
            <p className="mt-1.5 text-[11px] text-[var(--foreground-muted)]">
              Sin fecha, el plan no vence. Cada concesión queda en la bitácora del negocio.
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function JobRow({ job }: { job: AdminJobRow }) {
  const failed = job.status === 'FAILED';
  const tone = failed
    ? 'text-[var(--color-stock-out)]'
    : job.status === 'RUNNING'
      ? 'text-[var(--color-stock-low)]'
      : 'text-[var(--foreground-muted)]';
  return (
    <li className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] font-medium">{job.queue}</span>
        <span className={`font-mono text-[10.5px] uppercase ${tone}`}>{job.status}</span>
      </div>
      <p className="font-mono text-[10.5px] text-[var(--foreground-muted)]">
        {sliceStamp(job.runAt)} · intento {job.attempts}
      </p>
      {job.lastError ? (
        <p className="mt-1 line-clamp-3 text-[11px] text-[var(--color-stock-out)]">{job.lastError}</p>
      ) : null}
    </li>
  );
}

/** `2026-10-31T05:00:00.000Z` → `31 oct` en hora de Guatemala. La plataforma opera ahí. */
function sliceDay(iso: string): string {
  return new Intl.DateTimeFormat('es-GT', {
    timeZone: 'America/Guatemala',
    day: '2-digit',
    month: 'short',
  }).format(new Date(iso));
}

function sliceStamp(iso: string): string {
  return new Intl.DateTimeFormat('es-GT', {
    timeZone: 'America/Guatemala',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
