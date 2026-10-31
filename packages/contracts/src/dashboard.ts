import type { Permission } from './permissions.js';

/**
 * Tablero «Hoy».
 *
 * Lo que el dueño necesita saber al abrir la aplicación por la mañana: cuánto se vendió desde que
 * abrió la bodega, qué falta por sacar del estante, qué se agotó y qué buscaron los clientes que no
 * encontramos. Todo en una llamada.
 *
 * Dos decisiones que se ven en pantalla:
 *
 *  1. **Ventas en `null`, no en cero, cuando falta `finance.view`.** Un cero es un dato —"vendí y
 *     no gané nada"— y aquí sería una mentira: el vendedor vería que el negocio no vendió nada
 *     cuando en realidad vendió y él no tiene por qué saber cuánto. La pantalla pinta una raya y
 *     dice qué permiso hace falta.
 *  2. **El día es el del negocio, no el de UTC.** A las 18:00 de Guatemala ya es mañana en UTC; un
 *     corte en UTC cerraría el día seis horas antes de que el dueño cuente la caja.
 */
export interface DashboardToday {
  /** `YYYY-MM-DD` en la zona del negocio. */
  day: string;
  /** `null` sin `finance.view`. */
  salesCents: number | null;
  /** Pedidos con al menos una línea entregada hoy. `null` sin `finance.view`. */
  ordersTodayCount: number | null;
  /** Unidades por preparar en las bodegas visibles. */
  pendingUnits: number;
  /** Unidades ya preparadas esperando entrega. */
  readyUnits: number;
  lowStock: number;
  outOfStock: number;
  missedSearches: number;
  /** Pedidos abiertos o en preparación, para saber cuánta cola hay. */
  openOrders: number;
}

/** ¿Esta persona puede ver los importes del día? */
export function canSeeSales(permissions: readonly string[]): boolean {
  return permissions.includes('finance.view' satisfies Permission);
}
