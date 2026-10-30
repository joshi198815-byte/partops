/**
 * Estado de pedido por LÍNEA, no por cabecera.
 *
 * Una venta de 5 piezas puede salir de dos bodegas: 3 se despachan hoy y 2 esperan traslado desde
 * la central. Con un solo estado en la cabecera, el bodeguero no puede cerrar su parte y el pedido
 * queda "en preparación" para siempre. Por eso el estado vive en la línea y la cabecera se DERIVA.
 */

export const LINE_STATUSES = [
  'PENDIENTE',
  'EN_PREPARACION',
  'LISTO',
  'ENTREGADO',
  'SIN_STOCK',
  'CANCELADO',
] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const ORDER_STATUSES = [
  'ABIERTO',
  'EN_PREPARACION',
  'LISTO',
  'ENTREGADO',
  'PARCIAL',
  'CANCELADO',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_CHANNELS = ['MOSTRADOR', 'TELEFONO', 'WHATSAPP', 'CATALOGO', 'MOVIL'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

export const PAYMENT_METHODS = ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'CREDITO', 'MIXTO'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Transiciones legales por línea. Cualquier otra combinación es un error del cliente o un
 * intento de saltarse el flujo (entregar sin preparar, cancelar lo ya entregado).
 */
const LINE_TRANSITIONS: Record<LineStatus, readonly LineStatus[]> = {
  PENDIENTE: ['EN_PREPARACION', 'SIN_STOCK', 'CANCELADO'],
  EN_PREPARACION: ['LISTO', 'SIN_STOCK', 'CANCELADO'],
  LISTO: ['ENTREGADO', 'CANCELADO'],
  ENTREGADO: [],
  SIN_STOCK: ['PENDIENTE', 'CANCELADO'],
  CANCELADO: [],
};

export function canTransitionLine(from: LineStatus, to: LineStatus): boolean {
  return LINE_TRANSITIONS[from].includes(to);
}

export interface LineLike {
  status: LineStatus;
  quantity: number;
}

/**
 * Estado de la cabecera derivado de sus líneas.
 *
 * Reglas, en orden:
 *  - todas canceladas → CANCELADO
 *  - alguna pendiente/en preparación → EN_PREPARACION (hay trabajo en bodega)
 *  - hay entregadas y hay canceladas/sin stock → PARCIAL
 *  - todas entregadas → ENTREGADO
 *  - todas listas (o listas + canceladas) → LISTO
 *  - todo sin stock → ABIERTO (falta comprar, nadie lo está preparando)
 */
export function deriveOrderStatus(lines: LineLike[]): OrderStatus {
  if (!lines.length) return 'ABIERTO';
  const alive = lines.filter((l) => l.status !== 'CANCELADO');
  if (!alive.length) return 'CANCELADO';

  const has = (s: LineStatus) => alive.some((l) => l.status === s);
  if (has('PENDIENTE') || has('EN_PREPARACION')) return 'EN_PREPARACION';
  if (has('SIN_STOCK')) return alive.some((l) => l.status === 'ENTREGADO') ? 'PARCIAL' : 'ABIERTO';
  if (alive.every((l) => l.status === 'ENTREGADO')) {
    return lines.length !== alive.length ? 'PARCIAL' : 'ENTREGADO';
  }
  if (alive.some((l) => l.status === 'ENTREGADO')) return 'PARCIAL';
  return 'LISTO';
}

/** Un pedido cerrado no admite más cambios: ni líneas, ni pagos, ni despacho. */
export function isOrderClosed(status: OrderStatus): boolean {
  return status === 'ENTREGADO' || status === 'CANCELADO';
}

/**
 * Siguiente acción que el sistema debe sugerir, en español y accionable.
 * La UI no decide el flujo: lo lee de aquí, así la app móvil y la web dicen lo mismo.
 */
export function nextAction(status: OrderStatus): { label: string; permission: string } | null {
  switch (status) {
    case 'ABIERTO':
      return { label: 'Buscar existencia en otra bodega', permission: 'inventory.transfer' };
    case 'EN_PREPARACION':
      return { label: 'Preparar en bodega', permission: 'orders.dispatch' };
    case 'LISTO':
      return { label: 'Marcar entregado', permission: 'orders.dispatch' };
    case 'PARCIAL':
      return { label: 'Completar lo pendiente', permission: 'orders.dispatch' };
    default:
      return null;
  }
}
