'use client';

import { normalizeQuery, type ParsedQuery, parsePartQuery, type VehicleVocabulary } from '@partops/contracts';
import { useState } from 'react';

/**
 * El demo del hero: el parser real, corriendo en el navegador.
 *
 * Esto no es una captura ni un texto fijo. Es `parsePartQuery` —la misma función que usa la API
 * para partir «capo toyota corola 2009» en pieza, marca, modelo y año— ejecutándose sobre lo que el
 * visitante escribe. Por eso convence: no promete un resultado, lo enseña con la jerga del
 * mostrador guatemalteco («cubierta», «focos», «balatas»).
 *
 * Cuando la tabla curada no carga, se usa una lista corta local y **se dice**. Fingir que el parser
 * acertó con un vocabulario inventado sería exactamente el tipo de demo que este producto no hace.
 */

/** Solo si la API no responde. Seis marcas, doce modelos: lo mínimo para que el campo no quede muerto. */
const FALLBACK: VehicleVocabulary = {
  brands: ['Toyota', 'Nissan', 'Honda', 'Mitsubishi', 'Hyundai', 'Kia'],
  models: [
    { name: 'Corolla', brand: 'Toyota' },
    { name: 'Hilux', brand: 'Toyota' },
    { name: 'Sentra', brand: 'Nissan' },
    { name: 'Frontier', brand: 'Nissan' },
    { name: 'Civic', brand: 'Honda' },
    { name: 'CR-V', brand: 'Honda' },
    { name: 'L200', brand: 'Mitsubishi' },
    { name: 'Montero', brand: 'Mitsubishi' },
    { name: 'Accent', brand: 'Hyundai' },
    { name: 'Tucson', brand: 'Hyundai' },
    { name: 'Sportage', brand: 'Kia' },
    { name: 'Rio', brand: 'Kia' },
  ],
};

const EXAMPLES = ['cubierta corola 2009', 'balatas sentra', 'faro hilux 2015', 'amortiguador delantero'];

export function ParseDemo({ vocabulary }: { vocabulary: VehicleVocabulary | null }) {
  const vocab = vocabulary ?? FALLBACK;
  const [value, setValue] = useState('cubierta corola 2009');
  const parsed = parsePartQuery(value, vocab);

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
      <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
          Así lo interpreta PartOps
        </p>
        {vocabulary ? null : (
          <p className="text-[11px] text-[var(--color-copper-700)]">sin la tabla de referencia</p>
        )}
      </div>

      <div className="p-4">
        <label htmlFor="demo-query" className="sr-only">
          Escribe lo que diría el cliente en el mostrador
        </label>
        <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--background)] px-3 py-2.5 focus-within:border-[var(--accent)]">
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="size-4 shrink-0 text-[var(--foreground-muted)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" strokeLinecap="round" />
          </svg>
          <input
            id="demo-query"
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, 80))}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="cubierta corola 2009"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--foreground)] outline-none placeholder:text-[var(--foreground-muted)]"
          />
          {value ? (
            <button
              type="button"
              onClick={() => setValue('')}
              className="shrink-0 text-[11px] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
            >
              Borrar
            </button>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setValue(example)}
              className="rounded-[var(--radius-xs)] border border-[var(--border)] px-2 py-0.5 text-[11.5px] text-[var(--foreground-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
            >
              {example}
            </button>
          ))}
        </div>

        <Parsed parsed={parsed} empty={normalizeQuery(value) === ''} />
      </div>
    </div>
  );
}

/** Las cuatro piezas en que el parser parte la frase. Vacío no es error: es «todavía no hay nada». */
function Parsed({ parsed, empty }: { parsed: ParsedQuery; empty: boolean }) {
  if (empty) {
    return (
      <p className="mt-4 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-strong)] px-3 py-4 text-[12.5px] text-[var(--foreground-muted)]">
        Escribe una pieza y un vehículo. Aquí aparece cómo se separa.
      </p>
    );
  }

  const chips = [
    { label: 'busca', value: parsed.term || '—', title: parsed.term },
    { label: 'marca', value: parsed.brand ?? '—' },
    { label: 'modelo', value: parsed.model ?? '—' },
    { label: 'año', value: parsed.year ? String(parsed.year) : '—' },
  ];

  return (
    <div className="mt-4">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {chips.map((chip) => (
          <div
            key={chip.label}
            className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-2"
          >
            <dt className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
              {chip.label}
            </dt>
            <dd
              className={`partops-num mt-0.5 truncate font-mono text-[12.5px] ${
                chip.value === '—' ? 'text-[var(--foreground-muted)]' : 'text-[var(--foreground)]'
              }`}
              title={chip.title ?? chip.value}
            >
              {chip.value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-2.5 text-[12px] leading-relaxed text-[var(--foreground-muted)]">
        {parsed.termFromSynonym ? (
          <>
            Lo que escribiste no es el nombre de la pieza: el diccionario del mostrador lo lleva a{' '}
            <span className="font-medium text-[var(--foreground)]">«{parsed.term}»</span> y busca con ese
            término.
          </>
        ) : (
          <>
            El año se separa aunque venga al principio o pegado. Si sobra una palabra rara, se usa como texto
            libre en vez de descartarse.
          </>
        )}
      </p>

      {parsed.suggestions.length ? (
        <p className="mt-1.5 text-[12px] text-[var(--foreground-muted)]">
          ¿Quisiste decir{' '}
          <span className="font-medium text-[var(--foreground)]">{parsed.suggestions.join(' o ')}</span>? Se
          corrige solo sin cambiar lo que escribiste.
        </p>
      ) : null}
    </div>
  );
}
