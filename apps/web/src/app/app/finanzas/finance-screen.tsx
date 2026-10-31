'use client';

import { type FinanceOverview, financeProfit, formatMoney, toCents } from '@partops/contracts';
import { Alert, Button, Field, Input, Select, StatTile, TextArea } from '@partops/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useSubmit } from '@/lib/use-submit';

/**
 * Finanzas.
 *
 * Una sola pregunta manda el orden de la pantalla: **¿cuánto me quedó?** Por eso los tres números
 * que se ven primero son ventas, utilidad bruta y utilidad neta, y no una gráfica. El desglose
 * (vendedor, bodega, forma de pago) existe para responder "de dónde", y el gasto se captura en el
 * mismo lugar donde se ve su efecto: bajar el número al instante es lo que hace que la gente lo
 * capture el mismo día en vez de a fin de mes.
 *
 * Dos reglas de honestidad que se ven en la interfaz:
 *
 *  - Sin `finance.cost.view` los márgenes muestran una raya y dicen por qué. Nunca un cero: un cero
 *    es un dato y aquí sería una mentira.
 *  - Un periodo sin ventas no pinta barras vacías: dice qué pasó.
 */
export function FinanceScreen({
  canManageExpenses,
  canExport,
  canSeeCost,
  from,
  to,
}: {
  canManageExpenses: boolean;
  canExport: boolean;
  canSeeCost: boolean;
  from: string;
  to: string;
}) {
  const [period, setPeriod] = useState({ from, to });
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (range: { from: string; to: string }) => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api<FinanceOverview>(
          `/api/finance?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const currency = data?.currency ?? 'GTQ';

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em]">
            Finanzas
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-snug text-[var(--foreground-muted)]">
            La venta se cuenta cuando la pieza sale del estante y con el costo que tenía ese día. Así el mes
            pasado no cambia cuando sube el proveedor.
          </p>
        </div>
        <PeriodPicker value={period} busy={loading} onChange={(next) => setPeriod(next)} />
      </header>

      {error ? (
        <Alert tone="error" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {!data ? (
        <p className="text-[13px] text-[var(--foreground-muted)]">
          {loading ? 'Calculando el periodo…' : 'Sin datos para el periodo.'}
        </p>
      ) : (
        <>
          <section className="grid gap-px overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Ventas"
              value={formatMoney(data.totals.salesCents, currency)}
              hint={`${data.totals.ordersCount} ${data.totals.ordersCount === 1 ? 'pedido entregado' : 'pedidos entregados'} · ${data.totals.itemsCount} piezas`}
              className="rounded-none border-0"
            />
            <StatTile
              label="Utilidad bruta"
              value={costsOrDash(data.totals.grossProfitCents, currency)}
              hint={
                data.costsVisible
                  ? `Margen ${pct(data.totals.grossMarginBps ?? 0)} sobre ventas`
                  : 'Falta el permiso de ver costos'
              }
              className="rounded-none border-0"
            />
            <StatTile
              label="Gastos"
              value={formatMoney(data.totals.expensesCents, currency)}
              hint={`${data.expenses.length} ${data.expenses.length === 1 ? 'gasto registrado' : 'gastos registrados'}`}
              className="rounded-none border-0"
            />
            <StatTile
              label="Utilidad neta"
              value={costsOrDash(data.totals.netProfitCents, currency)}
              hint={
                data.costsVisible
                  ? `Ticket promedio ${formatMoney(data.totals.ticketAvgCents, currency)}`
                  : 'Falta el permiso de ver costos'
              }
              className="rounded-none border-0"
            />
          </section>

          <p className="mt-2 text-[11.5px] text-[var(--foreground-muted)]">
            De las ventas, {formatMoney(data.totals.taxCents, currency)} es IVA que se le debe al Estado: no
            es ganancia y por eso no se resta como gasto.
          </p>

          <section className="mt-6" aria-labelledby="diaria">
            <div className="mb-2 flex items-end justify-between gap-3">
              <h2
                id="diaria"
                className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
              >
                Día a día
              </h2>
              <div className="flex items-center gap-3 text-[11px] text-[var(--foreground-muted)]">
                <Legend className="bg-[var(--color-steel-700)]" label="Ventas" />
                <Legend className="bg-[var(--color-copper-500)]" label="Gastos" />
                {data.costsVisible ? (
                  <Legend className="bg-[var(--color-stock-ok)]" label="Utilidad" />
                ) : null}
              </div>
            </div>
            <DayBars days={data.days} />
            {data.costsVisible ? <PeriodStrip days={data.days} currency={currency} /> : null}
          </section>

          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <BreakdownTable
              title="Por vendedor"
              firstColumn="Vendedor"
              rows={data.bySeller}
              currency={currency}
              empty="Ningún pedido tiene vendedor asignado en el periodo."
            />
            <BreakdownTable
              title="Por bodega"
              firstColumn="Bodega"
              rows={data.byWarehouse}
              currency={currency}
              empty="Todavía no hay ventas entregadas desde una bodega."
            />
          </section>

          <section className="mt-6 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
                Cómo entró el dinero
              </h2>
              {data.byPaymentMethod.length ? (
                <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                  {data.byPaymentMethod.map((row) => (
                    <li
                      key={row.method}
                      className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[12.5px] last:border-b-0"
                    >
                      <span>
                        {row.label}
                        <span className="ml-1.5 text-[11px] text-[var(--foreground-muted)]">
                          {row.count} {row.count === 1 ? 'cobro' : 'cobros'}
                        </span>
                      </span>
                      <span className="partops-num font-medium">
                        {formatMoney(row.amountCents, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-[var(--radius-md)] border border-[var(--border)] px-4 py-6 text-center text-[12.5px] text-[var(--foreground-muted)]">
                  Nadie registró un cobro en este periodo. Un pedido entregado sin pago aparece en ventas,
                  pero no aquí.
                </p>
              )}

              <h2 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
                Gastos por categoría
              </h2>
              {data.expensesByCategory.length ? (
                <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                  {data.expensesByCategory.map((row) => (
                    <li
                      key={row.id}
                      className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12.5px] last:border-b-0"
                    >
                      <span className="truncate">{row.name}</span>
                      <span className="partops-num text-[var(--foreground-muted)]">
                        {formatMoney(row.expensesCents, currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-[var(--foreground-muted)]">
                  Sin gastos registrados en el periodo.
                </p>
              )}
            </div>

            <div>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
                Gastos del periodo
              </h2>
              {data.expenses.length ? (
                <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
                  {data.expenses.map((expense) => (
                    <li
                      key={expense.id}
                      className="flex items-start gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{expense.title}</p>
                        <p className="mt-0.5 text-[11.5px] text-[var(--foreground-muted)]">
                          {shortDate(expense.paidAt)}
                          {expense.categoryName ? ` · ${expense.categoryName}` : ' · Sin categoría'}
                          {expense.notes ? ` · ${expense.notes}` : ''}
                        </p>
                      </div>
                      <span className="partops-num shrink-0 text-[12.5px] font-medium">
                        {formatMoney(expense.amountCents, currency)}
                      </span>
                      {canManageExpenses ? (
                        <button
                          type="button"
                          className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11px] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]"
                          onClick={async () => {
                            if (!confirm(`¿Borrar el gasto "${expense.title}"?`)) return;
                            try {
                              await api(`/api/finance/expenses/${expense.id}`, { method: 'DELETE' });
                              await load(period);
                            } catch (err) {
                              setError(errorMessage(err));
                            }
                          }}
                        >
                          Borrar
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-[var(--radius-md)] border border-[var(--border)] px-4 py-6 text-center text-[12.5px] text-[var(--foreground-muted)]">
                  Ningún gasto en el periodo. La utilidad neta de arriba es la bruta.
                </p>
              )}
            </div>
          </section>

          {canManageExpenses ? (
            <section className="mt-6 grid gap-4 lg:grid-cols-2">
              <ExpenseForm
                categories={data.categories}
                defaultDay={period.to}
                currency={currency}
                onSaved={() => void load(period)}
              />
              <RecurringPanel
                recurring={data.recurring}
                categories={data.categories}
                currency={currency}
                onSaved={() => void load(period)}
              />
            </section>
          ) : null}

          <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
            <p className="text-[11.5px] text-[var(--foreground-muted)]">
              {canExport
                ? 'El archivo lleva exactamente los mismos números de esta pantalla.'
                : 'Para descargar el reporte necesitas el permiso de exportar finanzas.'}
            </p>
            {canExport ? (
              <div className="flex gap-2">
                <a
                  href={`/api/finance/export?from=${period.from}&to=${period.to}&format=xlsx`}
                  className="inline-flex h-9 items-center rounded-[var(--radius-sm)] bg-[var(--primary)] px-3 text-[13px] font-medium text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]"
                >
                  Excel
                </a>
                <a
                  href={`/api/finance/export?from=${period.from}&to=${period.to}&format=csv`}
                  className="inline-flex h-9 items-center rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 text-[13px] font-medium hover:bg-[var(--surface-sunken)]"
                >
                  CSV
                </a>
              </div>
            ) : null}
          </footer>

          {/* El costo es opcional en la respuesta; si no se ve, se dice una vez y no por fila. */}
          {!canSeeCost ? (
            <p className="mt-3 text-[11.5px] text-[var(--foreground-muted)]">
              Tu rol ve ventas y gastos, pero no el costo de compra ni el margen.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

// ───────────────────────────── Periodo ─────────────────────────────

/** Atajos que se usan de verdad: el mes en curso, el anterior y el día de hoy. */
const PRESETS: Array<{ key: string; label: string; range: (today: string) => { from: string; to: string } }> =
  [
    { key: 'mes', label: 'Este mes', range: (today) => ({ from: `${today.slice(0, 7)}-01`, to: today }) },
    {
      key: 'anterior',
      label: 'Mes pasado',
      range: (today) => {
        const [y, m] = today.split('-').map(Number) as [number, number];
        const prevY = m === 1 ? y - 1 : y;
        const prevM = m === 1 ? 12 : m - 1;
        const last = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
        const key = `${prevY}-${String(prevM).padStart(2, '0')}`;
        return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
      },
    },
    { key: 'hoy', label: 'Hoy', range: (today) => ({ from: today, to: today }) },
  ];

function PeriodPicker({
  value,
  busy,
  onChange,
}: {
  value: { from: string; to: string };
  busy: boolean;
  onChange: (next: { from: string; to: string }) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            disabled={busy}
            onClick={() => onChange(preset.range(value.to))}
            className="rounded-[var(--radius-xs)] border border-[var(--border)] px-2 py-1.5 text-[11.5px] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-[var(--foreground-muted)]">
        <label htmlFor="finance-from" className="sr-only">
          Desde
        </label>
        <Input
          id="finance-from"
          type="date"
          value={draft.from}
          max={draft.to}
          onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
          className="h-9 w-[140px] text-[12.5px]"
        />
      </div>
      <div className="text-[11px] text-[var(--foreground-muted)]">
        <label htmlFor="finance-to" className="sr-only">
          Hasta
        </label>
        <Input
          id="finance-to"
          type="date"
          value={draft.to}
          min={draft.from}
          onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
          className="h-9 w-[140px] text-[12.5px]"
        />
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || (draft.from === value.from && draft.to === value.to)}
        onClick={() => onChange(draft)}
      >
        Ver
      </Button>
    </div>
  );
}

// ───────────────────────────── Gastos ─────────────────────────────

function ExpenseForm({
  categories,
  defaultDay,
  currency,
  onSaved,
}: {
  categories: FinanceOverview['categories'];
  defaultDay: string;
  currency: string;
  onSaved: () => void;
}) {
  const { pending, error, issues, run, setError } = useSubmit();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [paidAt, setPaidAt] = useState(defaultDay);
  const [notes, setNotes] = useState('');

  useEffect(() => setPaidAt(defaultDay), [defaultDay]);

  const cents = toCents(amount);
  const valid = title.trim().length >= 2 && Number.isFinite(cents) && cents > 0;

  return (
    <form
      className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) {
          setError(!Number.isFinite(cents) || cents <= 0 ? 'Escribe un monto mayor que cero' : null);
          return;
        }
        void run(async () => {
          await api('/api/finance/expenses', {
            method: 'POST',
            body: {
              title: title.trim(),
              amountCents: cents,
              ...(categoryId ? { categoryId } : {}),
              paidAt,
              ...(notes.trim() ? { notes: notes.trim() } : {}),
            },
          });
          setTitle('');
          setAmount('');
          setNotes('');
          onSaved();
        });
      }}
    >
      <h2 className="text-[13px] font-semibold">Registrar un gasto</h2>
      <p className="mt-0.5 text-[11.5px] text-[var(--foreground-muted)]">
        Alquiler, planilla, flete, servicios. Se descuenta de la utilidad del día que lo pagaste.
      </p>

      {error ? (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      ) : null}

      <div className="mt-3 space-y-3">
        <Field label="Qué fue" htmlFor="expense-title" error={issues.title} required>
          <Input
            id="expense-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Alquiler de marzo"
            invalid={Boolean(issues.title)}
            maxLength={120}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Monto"
            htmlFor="expense-amount"
            error={issues.amountCents}
            hint={Number.isFinite(cents) && cents > 0 ? formatMoney(cents, currency) : undefined}
            required
          >
            <Input
              id="expense-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="1,250.00"
              invalid={Boolean(issues.amountCents)}
            />
          </Field>
          <Field label="Fecha" htmlFor="expense-date" error={issues.paidAt} required>
            <Input
              id="expense-date"
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              invalid={Boolean(issues.paidAt)}
            />
          </Field>
        </div>

        <Field label="Categoría" htmlFor="expense-category" error={issues.categoryId}>
          <Select id="expense-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Sin categoría</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Nota" htmlFor="expense-notes" hint="Opcional" error={issues.notes}>
          <TextArea
            id="expense-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Factura 0451, pagado por transferencia"
            className="min-h-[60px]"
            maxLength={500}
          />
        </Field>
      </div>

      <Button type="submit" className="mt-3 w-full" loading={pending} disabled={!valid}>
        Guardar gasto
      </Button>
    </form>
  );
}

/**
 * Gastos fijos.
 *
 * Se registran una vez y el mantenimiento crea el del mes solo. Es la única forma de que la
 * utilidad de un mes con el alquiler incluido no dependa de que alguien se acuerde de capturarlo.
 */
function RecurringPanel({
  recurring,
  categories,
  currency,
  onSaved,
}: {
  recurring: FinanceOverview['recurring'];
  categories: FinanceOverview['categories'];
  currency: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { pending, error, issues, run, setError } = useSubmit();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [day, setDay] = useState('1');

  const cents = toCents(amount);
  const valid = title.trim().length >= 2 && Number.isFinite(cents) && cents > 0;

  const total = useMemo(
    () => recurring.filter((r) => r.active).reduce((n, r) => n + r.amountCents, 0),
    [recurring],
  );

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold">Gastos fijos</h2>
          <p className="mt-0.5 text-[11.5px] text-[var(--foreground-muted)]">
            Se registran solos cada mes. Activos: {formatMoney(total, currency)} al mes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-[var(--radius-xs)] border border-[var(--border-strong)] px-2 py-1 text-[11.5px] font-medium"
        >
          {open ? 'Cerrar' : 'Agregar'}
        </button>
      </div>

      {open ? (
        <form
          className="mt-3 space-y-3 border-t border-[var(--border)] pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) {
              setError('Escribe el nombre y un monto mayor que cero');
              return;
            }
            void run(async () => {
              await api('/api/finance/recurring', {
                method: 'POST',
                body: {
                  title: title.trim(),
                  amountCents: cents,
                  dayOfMonth: Math.min(28, Math.max(1, Number(day) || 1)),
                  active: true,
                  ...(categoryId ? { categoryId } : {}),
                },
              });
              setTitle('');
              setAmount('');
              setOpen(false);
              onSaved();
            });
          }}
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Field label="Qué es" htmlFor="recurring-title" error={issues.title} required>
            <Input
              id="recurring-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Alquiler"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Monto" htmlFor="recurring-amount" error={issues.amountCents} required>
              <Input
                id="recurring-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="3,500.00"
              />
            </Field>
            <Field label="Día del mes" htmlFor="recurring-day" hint="1 a 28" error={issues.dayOfMonth}>
              <Input
                id="recurring-day"
                type="number"
                min={1}
                max={28}
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Categoría" htmlFor="recurring-category" error={issues.categoryId}>
            <Select
              id="recurring-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Sin categoría</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" className="w-full" loading={pending} disabled={!valid}>
            Guardar gasto fijo
          </Button>
        </form>
      ) : null}

      {recurring.length ? (
        <ul className="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {recurring.map((item) => (
            <li key={item.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium">
                  {item.title}
                  {!item.active ? (
                    <span className="ml-1.5 text-[11px] font-normal text-[var(--foreground-muted)]">
                      (pausado)
                    </span>
                  ) : null}
                </p>
                <p className="text-[11px] text-[var(--foreground-muted)]">
                  Día {item.dayOfMonth}
                  {item.categoryName ? ` · ${item.categoryName}` : ''}
                  {item.lastRunMonth ? ` · último: ${item.lastRunMonth}` : ' · sin generar'}
                </p>
              </div>
              <span className="partops-num shrink-0 text-[12px]">
                {formatMoney(item.amountCents, currency)}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11px] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)]"
                onClick={async () => {
                  try {
                    await api(`/api/finance/recurring/${item.id}`, {
                      method: 'PATCH',
                      body: { active: !item.active },
                    });
                    onSaved();
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                {item.active ? 'Pausar' : 'Activar'}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[12px] leading-snug text-[var(--foreground-muted)]">
          Sin gastos fijos. Registrar el alquiler aquí evita que un mes se quede sin él en el reporte.
        </p>
      )}
    </div>
  );
}

// ───────────────────────────── Piezas de pantalla ─────────────────────────────

function BreakdownTable({
  title,
  firstColumn,
  rows,
  currency,
  empty,
}: {
  title: string;
  firstColumn: string;
  rows: FinanceOverview['bySeller'];
  currency: string;
  empty: string;
}) {
  return (
    <div>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
        {title}
      </h2>
      {rows.length ? (
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)]">
          <table className="w-full text-left">
            <thead className="bg-[var(--surface-sunken)]">
              <tr>
                <th className="px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                  {firstColumn}
                </th>
                <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                  Ventas
                </th>
                <th className="px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
                  Utilidad
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-[var(--border)] bg-[var(--surface)]">
                  <td className="max-w-[220px] truncate px-3 py-2 text-[12.5px]">{row.label}</td>
                  <td className="partops-num px-3 py-2 text-right text-[12.5px]">
                    {formatMoney(row.salesCents, currency)}
                  </td>
                  <td className="partops-num px-3 py-2 text-right text-[12.5px]">
                    {row.profitCents === null ? dash() : formatMoney(row.profitCents, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-[var(--radius-md)] border border-[var(--border)] px-4 py-6 text-center text-[12.5px] text-[var(--foreground-muted)]">
          {empty}
        </p>
      )}
    </div>
  );
}

/**
 * Barras del periodo.
 *
 * Se escala sobre el mayor de ventas y gastos, no sobre la utilidad: la utilidad puede ser negativa
 * y una barra negativa no se lee. Los días con pérdida se pintan en la tira de abajo, con el signo.
 */
function DayBars({ days }: { days: FinanceOverview['days'] }) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.salesCents, d.expensesCents)));
  if (!days.length) {
    return (
      <p className="rounded-[var(--radius-md)] border border-[var(--border)] px-4 py-6 text-center text-[12.5px] text-[var(--foreground-muted)]">
        El periodo no tiene días.
      </p>
    );
  }

  return (
    <div className="flex h-32 items-end gap-[2px] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-1.5 pb-1.5 pt-3">
      {days.map((day) => {
        const sales = Math.max(0, Math.round((day.salesCents / max) * 92));
        const expenses = Math.max(0, Math.round((day.expensesCents / max) * 92));
        const profit =
          day.netProfitCents === null ? 0 : Math.round((Math.abs(day.netProfitCents) / max) * 92);
        return (
          <div
            key={day.day}
            className="group relative flex flex-1 flex-col justify-end gap-px"
            title={`${day.day}: ventas ${formatMoney(day.salesCents)} · gastos ${formatMoney(
              day.expensesCents,
            )}${day.netProfitCents === null ? '' : ` · utilidad ${formatMoney(day.netProfitCents)}`}`}
          >
            {profit && day.netProfitCents !== null ? (
              <span
                aria-hidden
                className={`w-full rounded-t-[1px] ${
                  day.netProfitCents >= 0 ? 'bg-[var(--color-stock-ok)]' : 'bg-[var(--color-stock-out)]'
                }`}
                style={{ height: `${Math.max(2, profit)}px` }}
              />
            ) : null}
            <span
              aria-hidden
              className="w-full bg-[var(--color-steel-700)]"
              style={{ height: `${Math.max(0, sales - Math.min(sales, expenses))}px` }}
            />
            {expenses ? (
              <span
                aria-hidden
                className="w-full rounded-t-[1px] bg-[var(--color-copper-500)]"
                style={{ height: `${Math.max(2, expenses)}px` }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Tira de totales: la serie diaria se lee como barras, pero el número hace falta para cuadrar. */
function PeriodStrip({ days, currency }: { days: FinanceOverview['days']; currency: string }) {
  const totals = days.reduce(
    (acc, d) => ({
      sales: acc.sales + d.salesCents,
      cogs: acc.cogs + (d.cogsCents ?? 0),
      expenses: acc.expenses + d.expensesCents,
    }),
    { sales: 0, cogs: 0, expenses: 0 },
  );
  const profit = financeProfit(totals.sales, totals.cogs, totals.expenses);

  return (
    <dl className="mt-2 grid gap-px overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--border)] text-[12px] sm:grid-cols-4">
      <Pair label="Ventas" value={formatMoney(totals.sales, currency)} />
      <Pair label="Costo" value={formatMoney(totals.cogs, currency)} />
      <Pair label="Gastos" value={formatMoney(totals.expenses, currency)} />
      <Pair label="Utilidad" value={formatMoney(profit.netProfitCents, currency)} strong />
    </dl>
  );
}

function Pair({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="bg-[var(--surface)] px-3 py-2">
      <dt className="text-[10.5px] uppercase tracking-[0.05em] text-[var(--foreground-muted)]">{label}</dt>
      <dd className={`partops-num mt-0.5 ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
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

function costsOrDash(cents: number | null, currency: string): string {
  return cents === null ? dash() : formatMoney(cents, currency);
}

function dash(): string {
  return '—';
}

/** `2026-03-15` → `15 mar`. El año sobra cuando el periodo ya lo dice. */
function shortDate(day: string): string {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const [, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d} ${months[(m ?? 1) - 1]}`;
}

/** Puntos base → "18,4 %". Con coma decimal, que es como se escribe en Guatemala. */
function pct(bps: number): string {
  return `${(bps / 100).toFixed(1).replace('.', ',')} %`;
}
