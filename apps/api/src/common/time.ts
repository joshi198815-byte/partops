import { Prisma } from '@partops/db';

/**
 * Días del negocio, no días de UTC.
 *
 * `createdAt` y `deliveredAt` son `timestamp` sin zona y guardan el reloj de UTC. En Guatemala el
 * día cierra a las 18:00 UTC: un reporte en UTC partiría la venta del sábado por la tarde en dos
 * días y el dueño vería un sábado flojo y un domingo que no abrió.
 *
 * Hay que pasar por las dos conversiones. Primero se declara que el valor es UTC y después se lleva
 * a la zona del negocio. Con una sola (`"createdAt" AT TIME ZONE tz`) Postgres interpreta el valor
 * como si ya fuera hora local, y el corte se corre seis horas.
 *
 * Vive en `common` y no dentro de un módulo porque demanda y finanzas tienen que partir el día
 * exactamente igual: dos copias de esta función es la forma más silenciosa de que dos reportes del
 * mismo día no cuadren.
 */
export function localDay(column: string, timezone: string): Prisma.Sql {
  return Prisma.sql`((${Prisma.raw(column)} AT TIME ZONE 'UTC') AT TIME ZONE ${timezone})::date`;
}

/** Medianoche local de `day` expresada en el reloj UTC, para comparar contra una columna `timestamp`. */
export function localBoundary(day: string, timezone: string): Prisma.Sql {
  return Prisma.sql`((${day}::date::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC')`;
}

export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

/** Suma días a un `YYYY-MM-DD` sin cruzar zonas: la fecha ya está localizada. */
export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function nextDay(day: string): string {
  return shiftDay(day, 1);
}

/** `YYYY-MM-DD` de hace N días, en UTC: solo se usa como límite de una fecha ya localizada. */
export function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

/** Todas las fechas de un rango, inclusive. Un mes son 30–31 cadenas, no treinta consultas. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = nextDay(day)) out.push(day);
  return out;
}

/** `YYYY-MM` de un día local. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}
