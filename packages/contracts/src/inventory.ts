import { z } from 'zod';

/**
 * Inventario: existencias por bodega, ledger de movimientos y traslados entre bodegas.
 *
 * La regla que ordena todo el archivo: el saldo NUNCA se escribe desde aquí. Se pide un cambio
 * (delta) y el servidor lo aplica contra el ledger inmutable. Por eso no hay `onHand` en ningún
 * formulario salvo el ajuste, que habla en existencia final porque así piensa el bodeguero.
 */

// ───────────────────────────── Existencias ─────────────────────────────

export const INVENTORY_FILTERS = ['TODOS', 'CON', 'BAJO', 'AGOTADO', 'SIN_UBICACION'] as const;
export type InventoryFilter = (typeof INVENTORY_FILTERS)[number];

export const inventoryListQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  warehouseId: z.string().uuid().optional(),
  filter: z.enum(INVENTORY_FILTERS).default('TODOS'),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  offset: z.coerce.number().int().min(0).default(0),
});
export type InventoryListQuery = z.output<typeof inventoryListQuerySchema>;

/** Igual que en el catálogo: `z.input` convertiría los números en `unknown` y rompería la pantalla. */
export interface InventoryListQueryInput {
  q?: string;
  warehouseId?: string;
  filter?: InventoryFilter;
  limit?: number;
  offset?: number;
}

export interface InventoryRow {
  variantId: string;
  partId: string;
  partName: string;
  /** Variante: "Izquierdo 1.8L". Vacío cuando la pieza tiene una sola. */
  title: string;
  sku: string;
  partNumber: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  unit: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderPoint: number | null;
  binLocation: string | null;
  priceCents: number;
  updatedAt: string;
}

/** Totales del negocio, no del filtro: son los que van en las tarjetas de arriba. */
export interface InventorySummary {
  /** Variantes con existencia en alguna bodega visible. */
  variants: number;
  units: number;
  reserved: number;
  /** Variantes distintas por debajo de su punto de reorden (existencia > 0). */
  low: number;
  /** Variantes sin existencia en NINGUNA bodega visible: las que de verdad hay que comprar. */
  out: number;
  /** Variantes con existencia pero sin pasillo/estante asignado. */
  unlocated: number;
  openTransfers: number;
}

export interface InventoryListResponse {
  items: InventoryRow[];
  total: number;
  limit: number;
  offset: number;
}

export const reorderPointSchema = z.object({
  warehouseId: z.string().uuid(),
  /** `null` borra el mínimo: la variante deja de avisar. */
  reorderPoint: z.number().int().min(0).max(1_000_000).nullable(),
  binLocation: z.string().trim().max(40).nullable().optional(),
});
export type ReorderPointData = z.output<typeof reorderPointSchema>;

// ───────────────────────────── Ledger ─────────────────────────────

export const MOVEMENT_TYPES = [
  'COMPRA',
  'VENTA',
  'DEVOLUCION',
  'AJUSTE',
  'IMPORTACION',
  'TRASLADO_ENTRADA',
  'TRASLADO_SALIDA',
  'RESERVA',
  'LIBERACION',
  'INVENTARIO_FISICO',
] as const;
export type MovementTypeKey = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_TYPE_LABEL: Record<MovementTypeKey, string> = {
  COMPRA: 'Compra',
  VENTA: 'Venta',
  DEVOLUCION: 'Devolución',
  AJUSTE: 'Ajuste',
  IMPORTACION: 'Importación',
  TRASLADO_ENTRADA: 'Entrada por traslado',
  TRASLADO_SALIDA: 'Salida por traslado',
  RESERVA: 'Reserva',
  LIBERACION: 'Liberación',
  INVENTARIO_FISICO: 'Inventario físico',
};

export const movementQuerySchema = z.object({
  variantId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type MovementQuery = z.output<typeof movementQuerySchema>;

export interface InventoryMovementRow {
  id: string;
  createdAt: string;
  variantId: string;
  sku: string;
  partName: string;
  variantTitle: string;
  type: MovementTypeKey;
  delta: number;
  balanceAfter: number;
  warehouseCode: string;
  reason: string | null;
  userName: string | null;
  refType: string | null;
  refId: string | null;
}

export interface MovementListResponse {
  items: InventoryMovementRow[];
  total: number;
  limit: number;
  offset: number;
}

// ───────────────────────────── Traslados ─────────────────────────────

export const TRANSFER_STATUSES = ['SOLICITADO', 'ENVIADO', 'RECIBIDO', 'CANCELADO'] as const;
export type TransferStatusKey = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_STATUS_LABEL: Record<TransferStatusKey, string> = {
  SOLICITADO: 'Solicitado',
  ENVIADO: 'En tránsito',
  RECIBIDO: 'Recibido',
  CANCELADO: 'Cancelado',
};

/**
 * Transiciones legales de un traslado.
 *
 * `SOLICITADO → RECIBIDO` no existe a propósito: recibir sin haber despachado deja la pieza
 * contada dos veces (sale por el papel, no por el estante), y el descuadre aparece un mes después.
 */
const TRANSFER_TRANSITIONS: Record<TransferStatusKey, readonly TransferStatusKey[]> = {
  SOLICITADO: ['ENVIADO', 'CANCELADO'],
  ENVIADO: ['RECIBIDO', 'CANCELADO'],
  RECIBIDO: [],
  CANCELADO: [],
};

export function canTransitionTransfer(from: TransferStatusKey, to: TransferStatusKey): boolean {
  return TRANSFER_TRANSITIONS[from].includes(to);
}

export const transferItemSchema = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().min(1, 'La cantidad tiene que ser al menos 1').max(100_000),
});

export const transferCreateSchema = z
  .object({
    fromWarehouseId: z.string().uuid(),
    toWarehouseId: z.string().uuid(),
    notes: z.string().trim().max(500).optional(),
    items: z.array(transferItemSchema).min(1, 'Agrega al menos una pieza').max(200),
  })
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: 'El origen y el destino tienen que ser bodegas distintas',
    path: ['toWarehouseId'],
  })
  .refine((v) => new Set(v.items.map((i) => i.variantId)).size === v.items.length, {
    message: 'Hay una pieza repetida: junta las cantidades en una sola línea',
    path: ['items'],
  });
export type TransferCreateData = z.output<typeof transferCreateSchema>;

/**
 * Recepción, total o parcial.
 *
 * `items` vacío = "llegó todo", que es el caso normal y no debería obligar a teclear cantidades.
 * Con cantidades, cada línea puede recibir menos de lo enviado y lo pendiente queda en tránsito.
 */
export const transferReceiveSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.number().int().min(0).max(100_000),
      }),
    )
    .max(200)
    .optional(),
  notes: z.string().trim().max(500).optional(),
});
export type TransferReceiveData = z.output<typeof transferReceiveSchema>;

export interface TransferWarehouse {
  id: string;
  code: string;
  name: string;
}

export interface TransferItemRow {
  id: string;
  variantId: string;
  sku: string;
  partName: string;
  variantTitle: string;
  unit: string;
  quantity: number;
  receivedQty: number;
  pending: number;
}

export interface StockTransferSummary {
  id: string;
  number: number;
  /** `TR-0012`: lo que se dice por teléfono entre bodegas. */
  code: string;
  status: TransferStatusKey;
  from: TransferWarehouse;
  to: TransferWarehouse;
  itemCount: number;
  units: number;
  notes: string | null;
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  createdByName: string | null;
}

export interface StockTransferDetail extends StockTransferSummary {
  items: TransferItemRow[];
  /** Unidades que todavía no llegan: es lo que impide cerrar el traslado. */
  pendingUnits: number;
}

export interface TransferListResponse {
  items: StockTransferSummary[];
  total: number;
}

export const transferListQuerySchema = z.object({
  status: z.enum(TRANSFER_STATUSES).optional(),
  warehouseId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TransferListQuery = z.output<typeof transferListQuerySchema>;

/** Buscador de piezas para armar un traslado. Devuelve lo disponible en la bodega de origen. */
export const variantOptionQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  warehouseId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type VariantOptionQuery = z.output<typeof variantOptionQuerySchema>;

export interface VariantOption {
  variantId: string;
  partName: string;
  title: string;
  sku: string;
  unit: string;
  onHand: number;
  reserved: number;
  /** Pasillo/estante en la bodega consultada: lo que ahorra la caminata al armar el traslado. */
  binLocation: string | null;
}

/** `TR-0007`. Se calcula igual en el servidor y en la pantalla. */
export function transferCode(number: number): string {
  return `TR-${String(number).padStart(4, '0')}`;
}

/**
 * Qué toca hacer ahora, en español y con el permiso que lo habilita.
 * La web y el móvil leen lo mismo; ninguno decide el flujo por su cuenta.
 */
export function nextTransferAction(
  status: TransferStatusKey,
  pendingUnits = 0,
): { label: string; permission: string } | null {
  switch (status) {
    case 'SOLICITADO':
      return { label: 'Despachar desde origen', permission: 'inventory.transfer' };
    case 'ENVIADO':
      return pendingUnits > 0
        ? { label: 'Recibir lo que llegó', permission: 'inventory.transfer' }
        : { label: 'Confirmar recepción', permission: 'inventory.transfer' };
    default:
      return null;
  }
}
