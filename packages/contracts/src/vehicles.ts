/**
 * Vehículos: marca → modelo → aplicación.
 *
 * Se normaliza porque el catálogo necesita facetas Marca›Modelo›Año y porque "Toyota Corolla 2009"
 * repetido en cada fila de Excel es la forma más rápida de tener un catálogo que nadie puede filtrar.
 * La aplicación (`vehicle`) guarda el rango de años, el motor y la carrocería: una pieza de Corolla
 * 2003–2008 1.8L no es la misma que la de 2009–2013 1.8L, y mezclarlas hace que el vendedor venda
 * una pieza que no entra.
 */

export interface VehicleApplication {
  brand: string;
  model: string;
  yearStart: number;
  yearEnd: number;
  engine?: string | null;
  bodyStyle?: string | null;
  /** Nombre comercial cuando difiere del global ("Hilux Vigo", "L200 Triton"). */
  trim?: string | null;
}

/** Clave estable marca|modelo|años|motor|carrocería, para deduplicar sin consultar a la base. */
export function applicationKey(v: VehicleApplication): string {
  return [
    v.brand.trim().toLowerCase(),
    v.model.trim().toLowerCase(),
    v.yearStart,
    v.yearEnd,
    (v.engine ?? '').trim().toLowerCase(),
    (v.bodyStyle ?? '').trim().toLowerCase(),
  ].join('|');
}

/** Etiqueta legible y corta, la que ve el vendedor: "Toyota Corolla 2009–2013 1.8L". */
export function formatApplication(v: VehicleApplication): string {
  const years = v.yearStart === v.yearEnd ? `${v.yearStart}` : `${v.yearStart}–${v.yearEnd}`;
  return [v.brand, v.model, years, v.engine].filter(Boolean).join(' ');
}

/**
 * ¿La aplicación cubre el año consultado? Fuera de rango devuelve false: es preferible no mostrar
 * una pieza dudosa que vender una que no entra.
 */
export function coversYear(v: VehicleApplication, year: number): boolean {
  return year >= v.yearStart && year <= v.yearEnd;
}

/**
 * Sanea el rango que viene de un Excel, donde "2008-2012" llega como un solo texto o los años vienen
 * invertidos. Devuelve `null` cuando no hay forma de salvarlo: basura no entra al catálogo.
 */
export function parseYearRange(
  raw: string | number | null | undefined,
): { start: number; end: number } | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const found = text.match(/\d{4}|\d{2}/g) ?? [];
  const years = found
    .map((t) => {
      if (t.length === 4) return Number(t);
      const y = Number(t);
      return y >= 80 ? 1900 + y : 2000 + y;
    })
    .filter((y) => y >= 1950 && y <= new Date().getFullYear() + 1);
  if (!years.length) return null;
  const start = Math.min(...years);
  const end = years.length > 1 ? Math.max(...years) : start;
  return { start, end };
}
