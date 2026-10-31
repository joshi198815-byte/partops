'use client';

import { formatMoney } from '@partops/contracts';
import { Alert } from '@partops/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSubmit } from '@/lib/use-submit';
import { StepActions, StepHeading } from '../_components/step';

/**
 * Paso 3 — impuestos.
 *
 * Una sola pregunta, y es la que arruina reportes si se contesta mal: si el precio que escribes
 * ya lleva IVA o se le suma al cobrar. Se explica con un ejemplo en quetzales en vez de con la
 * palabra "base imponible": el dueño de la bodega no tiene por qué saber qué es eso.
 *
 * Los precios en Guatemala se publican con IVA incluido; la opción por defecto es esa.
 */
const RATES = [
  { bps: 1200, label: '12 %', hint: 'IVA general' },
  { bps: 500, label: '5 %', hint: 'Tasa reducida' },
  { bps: 0, label: 'Exento', hint: 'Sin IVA' },
] as const;

export default function ImpuestosPage() {
  const router = useRouter();
  const { pending, error, run } = useSubmit();

  const [pricesIncludeTax, setPricesIncludeTax] = useState(true);
  const [taxRateBps, setTaxRateBps] = useState<number>(1200);

  // Ejemplo con Q 100.00 de base: si el precio ya lleva IVA, el estante dice Q 112.00 y el recibo
  // desglosa hacia atrás; si no, el estante dice Q 100.00 y el IVA se suma al cobrar.
  const base = 10_000;
  const tax = Math.round((base * taxRateBps) / 10_000);
  const shownPrice = pricesIncludeTax ? base + tax : base;

  async function save() {
    const ok = await run(async () => {
      await api('/api/onboarding/impuestos', {
        method: 'POST',
        body: { pricesIncludeTax, taxRateBps },
      });
    });
    if (!ok) return;
    router.push('/onboarding/equipo');
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
    >
      <StepHeading
        step="Paso 3"
        title="¿Cómo manejas el IVA?"
        body="Se pregunta una sola vez porque de esto depende que todos los precios y reportes cuadren. Si te equivocas, se cambia después en Configuración."
      />

      {error ? (
        <Alert tone="error" className="mb-5">
          {error}
        </Alert>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
          Los precios que escribo…
        </legend>

        <RadioCard
          checked={pricesIncludeTax}
          onChange={() => setPricesIncludeTax(true)}
          title="Ya incluyen IVA"
          body="Escribo Q 112 y el cliente paga Q 112. Es lo normal en Guatemala y lo que dice la etiqueta del estante."
        />
        <RadioCard
          checked={!pricesIncludeTax}
          onChange={() => setPricesIncludeTax(false)}
          title="Van sin IVA"
          body="Escribo Q 100 y al cobrar se le suma el IVA. Se usa cuando trabajas con facturación a empresas."
        />
      </fieldset>

      <fieldset className="mt-5 space-y-3">
        <legend className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
          Tasa
        </legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {RATES.map((r) => (
            <label
              key={r.bps}
              className={`cursor-pointer rounded-[var(--radius-sm)] border p-3 transition-colors ${
                taxRateBps === r.bps
                  ? 'border-[var(--color-copper-600)] bg-[var(--color-copper-100)]/40'
                  : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]'
              }`}
            >
              <input
                type="radio"
                name="rate"
                className="sr-only"
                checked={taxRateBps === r.bps}
                onChange={() => setTaxRateBps(r.bps)}
              />
              <span className="partops-num block font-[family-name:var(--font-display)] text-[18px] font-bold text-[var(--foreground)]">
                {r.label}
              </span>
              <span className="mt-0.5 block text-[11.5px] text-[var(--foreground-muted)]">{r.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]">
          Así se verá en el recibo
        </p>
        <dl className="partops-num mt-2 space-y-1 font-mono text-[12.5px]">
          <div className="flex justify-between">
            <dt className="text-[var(--foreground-muted)]">Mercadería</dt>
            <dd>{formatMoney(base)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--foreground-muted)]">IVA {(taxRateBps / 100).toFixed(0)} %</dt>
            <dd>{formatMoney(tax)}</dd>
          </div>
          <div className="flex justify-between border-t border-[var(--border)] pt-1 font-semibold">
            <dt>Precio en el estante</dt>
            <dd>{formatMoney(shownPrice)}</dd>
          </div>
        </dl>
      </div>

      <StepActions pending={pending} label="Guardar y seguir" />
    </form>
  );
}

function RadioCard({
  checked,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-[var(--radius-sm)] border p-3.5 transition-colors ${
        checked
          ? 'border-[var(--color-copper-600)] bg-[var(--color-copper-100)]/35'
          : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]'
      }`}
    >
      <input
        type="radio"
        name="includes"
        className="mt-0.5 size-4 accent-[var(--primary)]"
        checked={checked}
        onChange={onChange}
      />
      <span>
        <span className="block text-[13.5px] font-semibold text-[var(--foreground)]">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-[var(--foreground-muted)]">{body}</span>
      </span>
    </label>
  );
}
