import { z } from 'zod';
import type { DemandRow } from './search.js';

/**
 * Demanda: lo que la gente pidió y no había.
 *
 * La pregunta que responde esta pantalla es una sola —"¿qué compro en la próxima importación?"— y
 * todo lo demás (vehículo, categoría, evolución, conversión) existe para responderla sin que el
 * dueño tenga que cruzar dos reportes a mano.
 *
 * Dos decisiones que condicionan el resto:
 *
 *  - **Se mide sobre eventos, no sobre el rollup.** `demand_daily` existe para el histórico largo y
 *    para sobrevivir a la purga de eventos; el panel lee `search_event` en vivo porque un reporte
 *    que solo aparece "mañana" no se usa para comprar hoy.
 *  - **La retención borra eventos, nunca agregados.** A los 30 días el texto crudo de lo que buscó
 *    una persona deja de ser útil (y empieza a ser un dato personal que no hace falta guardar); el
 *    conteo por día y término se conserva para siempre.
 */

/** Ventana del panel. Treinta días cubre un ciclo de compra de una bodega sin arrastrar temporadas. */
export const DEMAND_WINDOW_DAYS = 30;

/** Lo que se guarda de cada búsqueda. Pasado esto, el agregado ya cuenta la historia. */
export const DEMAND_EVENT_RETENTION_DAYS = 30;

/** Días que recalcula el rollup en cada corrida: ayer y hoy, más el margen de una caída del cron. */
export const DEMAND_ROLLUP_DAYS = 3;

export interface DemandTotals {
  searches: number;
  withResults: number;
  missed: number;
  /** Sin resultado sobre el total, en puntos base (0–10000). */
  missedRateBps: number;
  /** Pedidos del catálogo en la ventana: el denominador honesto de la conversión. */
  catalogOrders: number;
  /** Pedidos por cada 100 búsquedas del catálogo, en puntos base. */
  conversionBps: number;
  /** Personas esperando que llegue algo. */
  watchers: number;
}

export interface DemandTimelineRow {
  /** `YYYY-MM-DD` en la zona del negocio, no en UTC. */
  day: string;
  searches: number;
  missed: number;
  orders: number;
}

export interface DemandVehicleRow {
  brand: string;
  model: string;
  year: number | null;
  searches: number;
  missed: number;
}

export interface DemandCategoryRow {
  /** Categoría del catálogo, o `Sin categoría` cuando el término no corresponde a ninguna. */
  category: string;
  searches: number;
  missed: number;
}

/**
 * Serie mensual del rollup.
 *
 * El detalle de los últimos 30 días sale de los eventos; lo de más atrás ya no existe como evento
 * —la retención lo borra— y solo se puede leer del agregado. Por eso el panel muestra las dos
 * cosas y no una: una serie diaria infinita sería una promesa que la base no puede cumplir.
 */
export interface DemandMonthRow {
  /** `YYYY-MM` en la zona del negocio. */
  month: string;
  searches: number;
  missed: number;
}

export interface DemandOverview {
  windowDays: number;
  totals: DemandTotals;
  topTerms: DemandRow[];
  byVehicle: DemandVehicleRow[];
  byCategory: DemandCategoryRow[];
  timeline: DemandTimelineRow[];
  months: DemandMonthRow[];
}

// ───────────────────────────── Avisos de llegada ─────────────────────────────

/**
 * "Avísame cuando llegue".
 *
 * El teléfono es obligatorio y el nombre también: una lista de avisos sin nombre es una lista de
 * números a la que nadie se atreve a escribir. El término se guarda aunque haya variante, porque
 * cuando la pieza llegue la persona no va a recordar el SKU que buscó.
 */
export const stockWatchSchema = z
  .object({
    name: z.string().trim().min(2, 'Escribe tu nombre').max(80, 'El nombre es demasiado largo'),
    phone: z.string().trim().min(8, 'Escribe tu teléfono').max(24, 'Teléfono demasiado largo'),
    variantId: z.string().uuid().optional(),
    partId: z.string().uuid().optional(),
    q: z.string().trim().max(120).optional(),
  })
  .refine((v) => Boolean(v.variantId || v.partId || (v.q && v.q.length >= 2)), {
    message: 'Dinos qué pieza buscas',
    path: ['q'],
  });

export type StockWatchInput = z.output<typeof stockWatchSchema>;

export interface StockWatchGroup {
  /** Clave estable del grupo: variante, pieza o término. */
  key: string;
  variantId: string | null;
  partId: string | null;
  term: string;
  partName: string | null;
  sku: string | null;
  pending: number;
  oldestAt: string;
  /** Existencia libre hoy en bodegas que venden en línea. */
  availableUnits: number;
  availableNow: boolean;
}

export interface StockWatchCustomer {
  id: string;
  name: string;
  phone: string;
  /** Enlace `wa.me` con el mensaje ya escrito. `null` si el teléfono no sirve para WhatsApp. */
  whatsappUrl: string | null;
  waitedSince: string;
}

export interface StockWatchNotification {
  group: StockWatchGroup;
  customers: StockWatchCustomer[];
  /** Texto único para copiar y pegar en un chat o en un estado de WhatsApp. */
  broadcastText: string;
}

/**
 * Mensaje al cliente que esperó.
 *
 * Corto y con la pieza adentro: quien recibe un WhatsApp de una bodega quiere saber dos cosas —qué
 * llegó y si todavía hay—, no leer un párrafo. El enlace al catálogo va al final por si quiere
 * apartarla antes de venir.
 */
export function stockArrivalMessage(input: {
  shopName: string;
  customerName: string;
  partName: string;
  sku?: string | null;
  catalogUrl: string;
}): string {
  return [
    `Hola ${input.customerName}, llegó lo que buscabas en ${input.shopName}.`,
    '',
    `${input.partName}${input.sku ? ` (${input.sku})` : ''}`,
    'Se aparta al pedirla desde el catálogo o por este chat.',
    '',
    input.catalogUrl,
  ].join('\n');
}

/** `wa.me` con el mensaje cargado. Solo dígitos: un número con guiones abre WhatsApp vacío. */
export function stockWatchWhatsAppUrl(phone: string, text: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * Lista para el estado o para pegar en un grupo.
 *
 * No lleva teléfonos ni nombres: es el texto que la bodega publica ("ya llegaron los capós del
 * Corolla"), no un volcado de datos de clientes en un chat compartido.
 */
export function stockArrivalBroadcast(input: {
  shopName: string;
  partName: string;
  sku?: string | null;
  catalogUrl: string;
  count: number;
}): string {
  return [
    `Llegó: ${input.partName}${input.sku ? ` · ${input.sku}` : ''}`,
    `${input.shopName} · ${input.count} ${input.count === 1 ? 'persona' : 'personas'} lo estaban esperando.`,
    input.catalogUrl,
  ].join('\n');
}
