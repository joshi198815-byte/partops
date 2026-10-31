import { z } from 'zod';
import { LINE_STATUS_LABEL, type LineStatus, type OrderStatus } from './orders.js';

/**
 * Despacho en bodega: escaneo, cola offline y eventos en vivo.
 *
 * La bodega no es una oficina. Hay poca luz, la señal se cae entre estanterías, el teléfono se usa
 * con una mano y el guante puesto. Todo lo de este archivo existe por eso:
 *
 *  - **El escaneo manda.** Marcar una línea "lista" sin haber leído el código de la pieza es
 *    exactamente cómo sale la pieza equivocada del estante. El servidor vuelve a comprobar el
 *    código aunque el cliente ya lo haya hecho.
 *  - **La cola sobrevive sin señal.** Un cambio de estado se guarda en el teléfono y se reintenta;
 *    cada operación lleva un `opId` propio para que el reintento no aplique el cambio dos veces.
 *  - **El orden de la caminata importa.** Las líneas se ordenan por pasillo y estante, no por como
 *    las capturó el vendedor: el bodeguero da una vuelta, no diez.
 */

// ───────────────────────────── Catálogo de códigos ─────────────────────────────

export interface ScanCandidate {
  sku: string;
  barcode?: string | null;
  partNumber?: string | null;
  oemNumbers?: readonly string[] | null;
}

/**
 * Normaliza un código leído.
 *
 * El mismo tornillo llega como `90080-17187`, `9008017187` o `90080 17187` según quién lo imprimió.
 * Se comparan solo letras y dígitos en mayúscula: si la normalización fuera estricta, el escáner
 * del fabricante y el SKU interno nunca coincidirían y el bodeguero aprendería a saltarse el
 * escaneo, que es justo lo que hay que evitar.
 */
export function normalizeScanCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export type ScanVerdict = 'VACIO' | 'COINCIDE' | 'NO_COINCIDE';

/**
 * ¿El código leído corresponde a esta línea?
 *
 * Se acepta cualquiera de los códigos impresos en la pieza: SKU interno, código de barras, número
 * de parte u OEM. Rechazar el OEM porque "no es nuestro SKU" obliga a teclear y vuelve el escaneo
 * inútil. Lo que NO se acepta es un código de otra pieza, ni siquiera del mismo modelo.
 */
export function scanVerdict(line: ScanCandidate, scanned: string): ScanVerdict {
  const code = normalizeScanCode(scanned);
  if (!code) return 'VACIO';

  const candidates = [line.sku, line.barcode ?? '', line.partNumber ?? '', ...(line.oemNumbers ?? [])];
  for (const candidate of candidates) {
    if (candidate && normalizeScanCode(candidate) === code) return 'COINCIDE';
  }
  return 'NO_COINCIDE';
}

/** Solo lo que se puede despachar desde la lista. `CANCELADO` y `ENTREGADO` no se tocan. */
export const DISPATCH_QUEUE_STATUSES: readonly LineStatus[] = ['PENDIENTE', 'EN_PREPARACION', 'LISTO'];

// ───────────────────────────── Cola de preparación ─────────────────────────────

export interface DispatchLine {
  itemId: string;
  variantId: string;
  sku: string;
  barcode: string | null;
  partNumber: string | null;
  oemNumbers: string[];
  name: string;
  variantTitle: string;
  unit: string;
  quantity: number;
  status: LineStatus;
  /** Pasillo/estante. `null` cuando nunca se ubicó: el bodeguero lo ve al final, no revuelto. */
  binLocation: string | null;
  warehouseId: string;
  warehouseCode: string;
  reservedUntil: string | null;
}

export interface DispatchOrder {
  orderId: string;
  code: string;
  status: OrderStatus;
  channel: string;
  customerName: string;
  customerPhone: string | null;
  warehouseId: string;
  warehouseCode: string;
  /** Minutos desde que se creó. La lista se ordena por esto: lo viejo primero. */
  ageMinutes: number;
  createdAt: string;
  lines: DispatchLine[];
  /** Piezas todavía por preparar en este pedido. */
  pendingUnits: number;
  /** Piezas ya escaneadas y listas. */
  readyUnits: number;
  priority: boolean;
}

export interface DispatchQueueResponse {
  orders: DispatchOrder[];
  pendingUnits: number;
  readyUnits: number;
  /** Hora del servidor: con el reloj del teléfono desfasado, la antigüedad se calcularía mal. */
  serverTime: string;
}

export const dispatchQueueQuerySchema = z.object({
  warehouseId: z.string().uuid().optional(),
  /** `true` deja solo pedidos con algo por preparar. */
  onlyActionable: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  q: z.string().trim().max(120).default(''),
});
export type DispatchQueueQuery = z.output<typeof dispatchQueueQuerySchema>;

/**
 * Orden de la caminata.
 *
 * Pasillo primero, y dentro del pasillo el nombre de la pieza: dos líneas del mismo estante se
 * toman juntas. Las líneas sin ubicación van al final, porque obligan a buscar y no deben
 * interrumpir el recorrido. Empate por `itemId` para que el orden sea estable entre llamadas —una
 * lista que cambia de orden en cada recarga hace dudar de si ya se tomó la pieza.
 */
export function sortByBinWalk<T extends { binLocation: string | null; name: string; itemId: string }>(
  lines: readonly T[],
): T[] {
  return [...lines].sort((a, b) => {
    const binA = a.binLocation?.trim() ?? '';
    const binB = b.binLocation?.trim() ?? '';
    if (binA !== binB) {
      if (!binA) return 1;
      if (!binB) return -1;
      // Comparación natural: "A-2" antes que "A-10", que con orden alfabético quedaría al revés.
      return binA.localeCompare(binB, 'es', { numeric: true, sensitivity: 'base' });
    }
    const byName = a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    return byName !== 0 ? byName : a.itemId.localeCompare(b.itemId);
  });
}

/** FIFO por antigüedad: el cliente que llegó primero no puede ser el último en salir. */
export function sortDispatchOrders<T extends { createdAt: string; priority: boolean; orderId: string }>(
  orders: readonly T[],
): T[] {
  return [...orders].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return diff !== 0 ? diff : a.orderId.localeCompare(b.orderId);
  });
}

/**
 * Un pedido lleva prisa cuando ya pasó el tiempo que el cliente tarda en llegar.
 *
 * No es una alarma de sistema: es el criterio con el que el bodeguero decide qué preparar primero
 * cuando la lista tiene diez pedidos y él está solo.
 */
export const DISPATCH_PRIORITY_MINUTES = 20;

export function isPriority(ageMinutes: number, pendingUnits: number): boolean {
  return pendingUnits > 0 && ageMinutes >= DISPATCH_PRIORITY_MINUTES;
}

// ───────────────────────────── Escaneo ─────────────────────────────

/**
 * Transiciones que el teléfono puede encolar.
 *
 * `PENDIENTE` queda fuera: devolver una línea a pendiente lo hace el vendedor cuando llega la
 * pieza que faltaba, no el bodeguero desde el pasillo. `CANCELADO` también: cancelar libera
 * reservas y es una decisión comercial.
 */
export const DISPATCH_OFFLINE_STATUSES = ['EN_PREPARACION', 'LISTO', 'SIN_STOCK', 'ENTREGADO'] as const;
export type DispatchOfflineStatus = (typeof DISPATCH_OFFLINE_STATUSES)[number];

export const dispatchOpSchema = z.object({
  /** Identidad de la operación en el teléfono. Es lo que hace el reintento idempotente. */
  opId: z.string().uuid('Operación inválida'),
  orderId: z.string().uuid(),
  itemId: z.string().uuid(),
  status: z.enum(DISPATCH_OFFLINE_STATUSES),
  /** Lo que leyó el escáner. `null` cuando el bodeguero marcó "no está" sin escanear. */
  scannedCode: z.string().trim().max(64).nullish(),
  /** Hora del teléfono. Solo informativa: el servidor sella con su propio reloj. */
  clientAt: z.string().max(40).optional(),
});
export type DispatchOp = z.output<typeof dispatchOpSchema>;

export const dispatchSyncSchema = z.object({
  ops: z.array(dispatchOpSchema).min(1, 'No hay nada que sincronizar').max(60),
});
export type DispatchSyncData = z.output<typeof dispatchSyncSchema>;

export const dispatchScanSchema = z.object({
  code: z.string().trim().min(1, 'Escanea o escribe el código').max(64),
  /** `LISTO` por omisión: escanear es preparar. `SIN_STOCK` existe para "no lo encontré". */
  status: z.enum(['LISTO', 'SIN_STOCK']).default('LISTO'),
  opId: z.string().uuid().optional(),
});
export type DispatchScanData = z.output<typeof dispatchScanSchema>;

export type DispatchOpOutcome = 'APLICADO' | 'REPETIDO' | 'RECHAZADO';

export interface DispatchOpResult {
  opId: string;
  outcome: DispatchOpOutcome;
  orderId: string;
  itemId: string;
  /** Estado en el que quedó la línea, cuando se pudo aplicar. */
  status: LineStatus | null;
  code?: string;
  message?: string;
}

export interface DispatchSyncResponse {
  results: DispatchOpResult[];
  /** Lista recalculada tras aplicar: el teléfono no necesita una segunda llamada. */
  queue: DispatchQueueResponse;
}

/**
 * Deja solo la última operación de cada línea.
 *
 * Sin esto, un teléfono que estuvo media hora sin señal manda "en preparación", "listo" y "sin
 * stock" de la misma pieza en un solo lote y la última gana por casualidad del orden de llegada.
 * Compactar en el cliente hace que el lote diga la verdad sobre dónde quedó la pieza.
 */
export function compactOps(ops: readonly DispatchOp[]): DispatchOp[] {
  const lastByLine = new Map<string, number>();
  ops.forEach((op, index) => {
    lastByLine.set(`${op.orderId}:${op.itemId}`, index);
  });
  return ops.filter((op, index) => lastByLine.get(`${op.orderId}:${op.itemId}`) === index);
}

// ───────────────────────────── Eventos en vivo ─────────────────────────────

/**
 * Pista para el teléfono. No es decoración: en bodega el bodeguero no está mirando la pantalla,
 * está con las manos en el estante. Un tono distinto por evento le dice qué pasó sin leer.
 */
export type DispatchCue = 'NUEVO' | 'LISTO' | 'ENTREGADO' | 'CANCELADO' | 'SIN_STOCK' | 'NINGUNA';

export function cueFor(status: OrderStatus, line: LineStatus | null): DispatchCue {
  if (status === 'CANCELADO') return 'CANCELADO';
  if (line === 'SIN_STOCK') return 'SIN_STOCK';
  if (status === 'ENTREGADO') return 'ENTREGADO';
  if (status === 'LISTO') return 'LISTO';
  return 'NINGUNA';
}

export interface DispatchUpdate {
  orderId: string;
  code: string;
  status: OrderStatus;
  warehouseId: string;
  line: { itemId: string; sku: string; status: LineStatus } | null;
  actorName: string | null;
  /** `CREADO` no tiene línea: el pedido acaba de entrar a la cola. */
  kind: 'CREADO' | 'LINEA' | 'CANCELADO' | 'ENTREGADO';
  at: string;
}

/** Lo que se guarda en `order_event.detail` para deduplicar reintentos. */
export const DISPATCH_OP_EVENT = 'DESPACHO_OP';

export interface DispatchUpdateEvent {
  type: 'dispatch:update';
  update: DispatchUpdate;
}

export interface DispatchNoticeEvent {
  type: 'dispatch:notice';
  title: string;
  body: string;
  orderId: string | null;
  at: string;
}

export type RealtimeEvent = DispatchUpdateEvent | DispatchNoticeEvent;

/** Etiqueta corta de una línea para la lista y el aviso. */
export function dispatchLineLabel(line: { sku: string; name: string }): string {
  return `${line.sku} · ${line.name}`;
}

/** Texto del aviso de llegada: dice qué preparar y para quién, no "tienes un pedido". */
export function newOrderNotice(args: { code: string; customerName: string; pendingUnits: number }): {
  title: string;
  body: string;
} {
  const piezas = args.pendingUnits === 1 ? '1 pieza' : `${args.pendingUnits} piezas`;
  return {
    title: `Pedido ${args.code} en bodega`,
    body: `${piezas} para ${args.customerName}. Toca para prepararlo.`,
  };
}

export { LINE_STATUS_LABEL };

// ───────────────────────────── Avisos push ─────────────────────────────

/**
 * Suscripción de Web Push.
 *
 * `endpoint` es la dirección del servicio de notificaciones del navegador (Chrome, Firefox, Safari)
 * y las dos claves son el material con el que el servidor cifra el contenido. Sin `p256dh` y
 * `auth` el push no se entrega, así que se aceptan pero se guardan como nulos: el servidor no
 * inventa una suscripción a medias.
 */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url('Suscripción inválida').max(1200),
  keys: z
    .object({
      p256dh: z.string().max(200).optional(),
      auth: z.string().max(100).optional(),
    })
    .optional(),
  /**
   * Transporte del aparato. `web` es la PWA con Web Push; `fcm` es el APK, que necesita Firebase
   * para despertar con la app cerrada. Por defecto `web`: una suscripción vieja sin este campo
   * sigue funcionando igual que antes.
   *
   * Un token de FCM es largo (~150–200 caracteres) pero no es una URL, así que el cliente nativo
   * llama a este mismo endpoint con `endpoint: <token>` para no duplicar contrato.
   */
  platform: z.enum(['web', 'fcm']).default('web'),
});
export type PushSubscribeData = z.output<typeof pushSubscribeSchema>;

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().max(1200) });
export type PushUnsubscribeData = z.output<typeof pushUnsubscribeSchema>;

/** Lo que devuelve `/api/realtime/ticket`. */
export interface RealtimeTicket {
  ticket: string;
  path: string;
  expiresIn: number;
  connected: boolean;
}
