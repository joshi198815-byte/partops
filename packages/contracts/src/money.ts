/**
 * Todo el dinero del sistema vive en centavos enteros. Ningún cálculo monetario toca decimales:
 * sumar, restar, descontar e impuestos se hacen en `number` entero y se formatean al pintar.
 */

export const DEFAULT_CURRENCY = 'GTQ';
export const DEFAULT_LOCALE = 'es-GT';
/** IVA Guatemala 12%, en puntos base para no usar floats. */
export const DEFAULT_TAX_RATE_BPS = 1200;

const formatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(
  cents: number,
  currency: string = DEFAULT_CURRENCY,
  locale = DEFAULT_LOCALE,
): string {
  const key = `${locale}:${currency}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    formatters.set(key, fmt);
  }
  return fmt.format(Math.round(cents) / 100);
}

/**
 * Convierte lo que escribe una persona ("Q 1,250.50", "1250,5", 1250.5) a centavos.
 * Devuelve NaN cuando no se puede interpretar, para que el llamador decida el mensaje.
 */
export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN;
  const cleaned = value.replace(/[^\d.,-]/g, '');
  if (!cleaned) return Number.NaN;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  // "1.250,50" (formato GT/EU) contra "1,250.50" (formato US). El último separador manda.
  const normalized =
    lastComma > lastDot ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Reparte `total` proporcionalmente a `weights` sin perder ni inventar un centavo:
 * el residuo del redondeo se asigna de mayor a menor. Es lo que garantiza que las líneas
 * de una factura sumen exactamente el total, incluido el IVA incluido en precio.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

/**
 * Desglosa un total con impuesto incluido. El IVA nunca se calcula con `total * 0.12`: eso
 * deja centavos sueltos. Se obtiene por diferencia para que `base + tax === total` siempre.
 */
export function splitTaxIncluded(totalCents: number, taxRateBps: number = DEFAULT_TAX_RATE_BPS) {
  if (taxRateBps <= 0) return { subtotal: totalCents, tax: 0, total: totalCents };
  const base = Math.round((totalCents * 10_000) / (10_000 + taxRateBps));
  return { subtotal: base, tax: totalCents - base, total: totalCents };
}

/** Utilidad bruta de una línea: precio congelado menos costo congelado, por cantidad. */
export function lineProfitCents(unitPriceCents: number, unitCostCents: number, quantity: number): number {
  return (unitPriceCents - unitCostCents) * quantity;
}

/** Margen sobre precio de venta, en puntos base (0–10000). Sin venta no hay margen: 0. */
export function marginBps(unitPriceCents: number, unitCostCents: number): number {
  if (unitPriceCents <= 0) return 0;
  return Math.round(((unitPriceCents - unitCostCents) * 10_000) / unitPriceCents);
}
