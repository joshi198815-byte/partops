'use client';

import type { PublicFacetModel } from '@partops/contracts';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { type StorefrontQuery, storefrontQueryString } from '@/lib/public-catalog';

/**
 * Selector de vehículo: marca → modelo → año.
 *
 * Es un formulario GET de verdad, no un widget con estado propio. Así el filtro queda en la URL
 * (`?brand=Toyota&model=Corolla&year=2009`), el enlace se puede mandar por WhatsApp y el botón
 * "atrás" del teléfono devuelve el filtro anterior en vez de sacar al cliente del catálogo.
 *
 * Con JavaScript, cambiar un campo envía solo; sin JavaScript, queda el botón "Ver piezas". La
 * vitrina no puede depender de que hidrate un bundle para funcionar.
 */
export function VehicleSelector({
  shopSlug,
  query,
  brands,
  models,
}: {
  shopSlug: string;
  query: StorefrontQuery;
  brands: { name: string; count: number }[];
  models: PublicFacetModel[];
}) {
  const router = useRouter();
  const [brand, setBrand] = useState(query.brand ?? '');
  const [model, setModel] = useState(query.model ?? '');
  const [year, setYear] = useState(query.year ? String(query.year) : '');

  const modelsOfBrand = useMemo(
    () => models.filter((m) => !brand || m.brand.toLowerCase() === brand.toLowerCase()),
    [models, brand],
  );

  /**
   * Años del modelo elegido.
   *
   * El rango del modelo es la unión de los años de todas sus piezas, así que un año sin pieza
   * compatible puede aparecer en la lista. Es a propósito: esconderlo haría que el cliente creyera
   * que su carro no existe; al elegirlo, el catálogo dirá "no hay piezas para ese año" y ofrecerá
   * preguntar por WhatsApp.
   */
  const years = useMemo(() => {
    const scoped = brand && model ? modelsOfBrand.filter((m) => m.model === model) : modelsOfBrand;
    if (!scoped.length) return [];
    const start = Math.min(...scoped.map((m) => m.yearStart));
    const end = Math.max(...scoped.map((m) => m.yearEnd));
    const out: number[] = [];
    for (let y = end; y >= start; y -= 1) out.push(y);
    return out;
  }, [brand, model, modelsOfBrand]);

  function go(next: Partial<StorefrontQuery>) {
    router.push(
      `/c/${encodeURIComponent(shopSlug)}${storefrontQueryString({ ...query, ...next, page: 1 })}` as Route,
    );
  }

  function onBrand(value: string) {
    setBrand(value);
    // Cambiar de marca suelta el modelo: "Corolla" filtrado sobre Nissan no devuelve nada y el
    // cliente culpa al catálogo, no al filtro.
    setModel('');
    setYear('');
    go({ brand: value || null, model: null, year: null });
  }

  function onModel(value: string) {
    setModel(value);
    setYear('');
    go({ brand: brand || null, model: value || null, year: null });
  }

  function onYear(value: string) {
    setYear(value);
    go({ brand: brand || null, model: model || null, year: value ? Number(value) : null });
  }

  const active = Boolean(brand || model || year);

  return (
    <form
      className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        go({ brand: brand || null, model: model || null, year: year ? Number(year) : null });
      }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
          Buscar por vehículo
        </p>
        {active ? (
          <a
            href={storefrontQueryString({ ...query, brand: null, model: null, year: null }) || '#'}
            onClick={(e) => {
              e.preventDefault();
              setBrand('');
              setModel('');
              setYear('');
              go({ brand: null, model: null, year: null });
            }}
            className="text-[11.5px] text-[var(--foreground-muted)] underline hover:text-[var(--foreground)]"
          >
            Quitar filtro
          </a>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[11px] text-[var(--foreground-muted)]">Marca</span>
          <select
            name="brand"
            value={brand}
            onChange={(e) => onBrand(e.target.value)}
            className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[13.5px]"
          >
            <option value="">Todas</option>
            {brands.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} ({b.count})
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] text-[var(--foreground-muted)]">Modelo</span>
          <select
            name="model"
            value={model}
            disabled={!modelsOfBrand.length}
            onChange={(e) => onModel(e.target.value)}
            className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[13.5px] disabled:opacity-50"
          >
            <option value="">Todos</option>
            {[...new Set(modelsOfBrand.map((m) => m.model))].sort().map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] text-[var(--foreground-muted)]">Año</span>
          <select
            name="year"
            value={year}
            disabled={!years.length}
            onChange={(e) => onYear(e.target.value)}
            className="partops-num h-10 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-2 text-[13.5px] disabled:opacity-50"
          >
            <option value="">Todos</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      <noscript>
        <button
          type="submit"
          className="mt-2 h-10 w-full rounded-[var(--radius-sm)] bg-[var(--primary)] text-[13px] font-semibold text-[var(--primary-foreground)]"
        >
          Ver piezas
        </button>
      </noscript>
    </form>
  );
}
