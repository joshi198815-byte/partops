/**
 * Catálogo de piezas: contrato entre la API y la web.
 *
 * Aquí vive lo que las dos partes tienen que entender igual: qué es un SKU válido, cuándo dos
 * códigos OEM son el mismo, qué se acepta como imagen y cómo se nombra una pieza en la URL.
 *
 * Dos decisiones que se notan en el mostrador:
 *
 *  1. **El SKU y el OEM se normalizan antes de comparar.** "04465-0K290", "04465 0k290" y
 *     "04465-0k290 " son el mismo código para cualquiera que lo esté dictando por teléfono. Si la
 *     base los guarda crudos, el catálogo acepta el mismo repuesto dos veces y el inventario se
 *     parte en dos.
 *  2. **El slug se deriva del nombre y nunca se reescribe solo.** Es la dirección de la ficha y,
 *     cuando exista el catálogo público, la del enlace que ya se mandó por WhatsApp.
 */

import { z } from 'zod';
import { toCents } from './money.js';

export const PART_CONDITIONS = ['NUEVO', 'USADO', 'REMANUFACTURADO'] as const;
export type PartConditionKey = (typeof PART_CONDITIONS)[number];

export const PART_STATUSES = ['ACTIVO', 'ARCHIVADO'] as const;
export type PartStatusKey = (typeof PART_STATUSES)[number];

/** Unidades que el mostrador usa de verdad. "UNIDAD" es la omisa y no se escribe en pantalla. */
export const PART_UNITS = ['UNIDAD', 'PAR', 'JUEGO', 'KIT', 'LITRO', 'METRO'] as const;
export type PartUnit = (typeof PART_UNITS)[number];

/**
 * Límites de imagen.
 *
 * 8 MB es lo que sube un teléfono moderno sin que nadie recuerde bajarle calidad; rechazar más
 * que eso no es tacañería, es evitar que el dueño suba 40 fotos de 12 MP a un plan gratuito.
 * 1400 px de lado es suficiente para ver una pieza en pantalla y para el catálogo público.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 1400;
export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
] as const;

export const MAX_VARIANTS_PER_PART = 40;
export const MAX_IMAGES_PER_PART = 8;

/**
 * Código comparable: sin signos, en mayúsculas.
 *
 * El guion y el espacio se descartan porque el mismo OEM se escribe de las dos formas en el mismo
 * mostrador, y comparar los textos crudos obliga a la persona a recordar cuál usó la última vez.
 */
export function normalizePartCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** SKU tal como se guarda: mayúsculas, espacios a guion, sin signos raros. */
export function normalizeSku(raw: string): string {
  return (
    raw
      .normalize('NFD')
      // "capó" se dicta igual que "capo": sin esto el acento se cae y queda "CAP0913".
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase()
      // Cualquier corrida de signos es un separador: "#", "·", un espacio de más en medio.
      .replace(/[^A-Z0-9._/-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
  );
}

/**
 * Lista de OEM lista para guardar: normalizada, sin repetidos y sin vacíos.
 *
 * Se descartan los códigos de menos de 4 caracteres porque en la práctica son "N/A" o "SIN CODIGO"
 * del Excel de la bodega, y ensucian el índice GIN que usa la búsqueda.
 */
export function normalizeOemList(input: string | readonly string[] | null | undefined): string[] {
  if (input === null || input === undefined) return [];
  const raw = typeof input === 'string' ? input.split(/[,;/|]+/) : [...input];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    const code = normalizePartCode(trimmed);
    if (code.length < 4) continue;
    // Se guarda con los signos que traía la persona (es lo que se dicta), pero se deduplica por la
    // forma comparable: "04465-0K290" y "044650K290" son el mismo código.
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(trimmed.toUpperCase().replace(/\s+/g, ''));
  }
  return out.slice(0, 20);
}

/** `Capó delantero derecho` → `capo-delantero-derecho`. */
export function partSlug(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || 'pieza';
}

/** Segundo intento en adelante: `capo-delantero-2`. */
export function partSlugCandidate(base: string, attempt: number): string {
  if (attempt <= 0) return base;
  const suffix = `-${attempt + 1}`;
  return `${base.slice(0, 60 - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

/** ¿Es una imagen que se puede procesar? El tamaño y el tipo se validan antes de leer el buffer. */
export function imageUploadProblem(file: { size: number; mimetype: string }): string | null {
  if (file.size <= 0) return 'El archivo está vacío';
  if (file.size > MAX_IMAGE_BYTES) {
    return `La imagen pesa ${(file.size / 1024 / 1024).toFixed(1)} MB. El máximo es 8 MB`;
  }
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.mimetype.toLowerCase())) {
    return 'Formato no soportado. Usa JPG, PNG, WebP o HEIC';
  }
  return null;
}

/** Dinero que llega del formulario como texto ("Q 1,250.50") y se guarda en centavos. */
const moneyInput = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const cents = toCents(value as string | number);
  if (!Number.isFinite(cents)) {
    ctx.addIssue({ code: 'custom', message: 'Escribe un monto válido' });
    return z.NEVER;
  }
  return cents;
});

const skuSchema = z
  .string()
  .trim()
  .min(1, 'Escribe el SKU')
  .max(40, 'Máximo 40 caracteres')
  .transform((v) => normalizeSku(v))
  .refine((v) => v.length > 0, 'El SKU no puede quedar vacío');

const oemSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => normalizeOemList(v))
  .refine((codes) => codes.length <= 20, 'Hasta 20 códigos OEM por variante');

export const partVariantInputSchema = z.object({
  sku: skuSchema,
  /** Lo que distingue esta variante: "Izquierdo", "1.8L", "Con ABS". */
  title: z.string().trim().max(120).optional(),
  partNumber: z.string().trim().max(60).optional(),
  oemNumbers: oemSchema.optional(),
  barcode: z.string().trim().max(60).optional(),
  price: moneyInput,
  cost: moneyInput.optional(),
});
export type PartVariantInput = z.input<typeof partVariantInputSchema>;
export type PartVariantData = z.output<typeof partVariantInputSchema>;

export const partVariantUpdateSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    partNumber: z.string().trim().max(60).nullable().optional(),
    oemNumbers: oemSchema.optional(),
    barcode: z.string().trim().max(60).nullable().optional(),
    price: moneyInput.optional(),
    cost: moneyInput.optional(),
    isActive: z.boolean().optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay cambios que guardar');

export const partCreateSchema = z.object({
  name: z.string().trim().min(2, 'Escribe el nombre de la pieza').max(120),
  brand: z.string().trim().max(60).optional(),
  categoryId: z.string().uuid().optional(),
  /** Categoría que aún no existe y se crea en el mismo paso. */
  categoryName: z.string().trim().max(60).optional(),
  condition: z.enum(PART_CONDITIONS).default('NUEVO'),
  unit: z.enum(PART_UNITS).default('UNIDAD'),
  warrantyDays: z.number().int().min(0).max(3650).optional(),
  description: z.string().trim().max(2000).optional(),
  isUniversal: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(30)).max(15).default([]),
  /**
   * Al menos una variante: una pieza sin precio no se puede vender y en el catálogo aparece como
   * una fila que nadie puede cobrar. Es preferible pedir el precio ahora que descubrirlo en caja.
   */
  variants: z.array(partVariantInputSchema).min(1, 'Agrega al menos una variante').max(MAX_VARIANTS_PER_PART),
  /** Aplicaciones ya existentes en la referencia global. */
  vehicleIds: z.array(z.string().uuid()).max(500).default([]),
});
/** Lo que manda el formulario. */
export type PartCreateInput = z.input<typeof partCreateSchema>;
/** Lo que ya validó el servidor: dinero en centavos, OEM como arreglo. Es lo que recibe el servicio. */
export type PartCreateData = z.output<typeof partCreateSchema>;

export const partUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    brand: z.string().trim().max(60).nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    categoryName: z.string().trim().max(60).optional(),
    condition: z.enum(PART_CONDITIONS).optional(),
    unit: z.enum(PART_UNITS).optional(),
    warrantyDays: z.number().int().min(0).max(3650).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    isUniversal: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(15).optional(),
    status: z.enum(PART_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay cambios que guardar');
export type PartUpdateInput = z.input<typeof partUpdateSchema>;
export type PartUpdateData = z.output<typeof partUpdateSchema>;

/**
 * Aplicaciones por rango de años.
 *
 * Se piden marca y modelo, no un `vehicleId`, porque así piensa el bodeguero: "este capó va en
 * Corolla 2009 a 2013". Si la aplicación exacta no existe en la referencia, se crea; si existe, se
 * reutiliza. La nota es para lo que no cabe en el rango ("con ABS", "solo 1.8L").
 */
export const compatibilityRangeSchema = z
  .object({
    brand: z.string().trim().min(1, 'Elige la marca').max(60),
    model: z.string().trim().min(1, 'Elige el modelo').max(60),
    yearStart: z.number().int().min(1950).max(2100),
    yearEnd: z.number().int().min(1950).max(2100),
    engine: z.string().trim().max(40).optional(),
    bodyStyle: z.string().trim().max(40).optional(),
    notes: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.yearStart <= v.yearEnd, 'El año inicial no puede ser mayor que el final');
export type CompatibilityRangeInput = z.input<typeof compatibilityRangeSchema>;
export type CompatibilityRangeData = z.output<typeof compatibilityRangeSchema>;

export const compatibilityIdsSchema = z.object({
  vehicleIds: z.array(z.string().uuid()).min(1, 'Elige al menos un vehículo').max(500),
});

export const BULK_ACTIONS = ['ARCHIVAR', 'ACTIVAR', 'CATEGORIA'] as const;

export const bulkPartsSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1, 'Elige al menos una pieza').max(200),
    action: z.enum(BULK_ACTIONS),
    categoryId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.action !== 'CATEGORIA' || Boolean(v.categoryId), {
    message: 'Elige la categoría de destino',
    path: ['categoryId'],
  });
export type BulkPartsInput = z.input<typeof bulkPartsSchema>;
export type BulkPartsData = z.output<typeof bulkPartsSchema>;

export const STOCK_FILTERS = ['TODOS', 'CON', 'BAJO', 'AGOTADO'] as const;
export const PART_SORTS = ['NOMBRE', 'RECIENTES', 'PRECIO'] as const;

export const catalogListQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  categoryId: z.string().uuid().optional(),
  brand: z.string().trim().max(60).optional(),
  condition: z.enum(PART_CONDITIONS).optional(),
  status: z.enum(['ACTIVO', 'ARCHIVADO', 'TODOS']).default('ACTIVO'),
  stock: z.enum(STOCK_FILTERS).default('TODOS'),
  sort: z.enum(PART_SORTS).default('NOMBRE'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});
/** Filtros ya normalizados: qué recibe el servicio, con los valores por omisión puestos. */
export type CatalogListQuery = z.output<typeof catalogListQuerySchema>;

/**
 * Filtros tal como los maneja la pantalla: todo opcional y con tipos reales.
 *
 * No se usa `z.input` porque `z.coerce.number()` infiere la entrada como `unknown`: la pantalla
 * terminaría con `limit: {}` y sin poder sumar la paginación. El esquema sigue validando al enviar.
 */
export interface CatalogListQueryInput {
  q?: string;
  categoryId?: string;
  brand?: string;
  condition?: PartConditionKey;
  status?: PartStatusKey | 'TODOS';
  stock?: (typeof STOCK_FILTERS)[number];
  sort?: (typeof PART_SORTS)[number];
  limit?: number;
  offset?: number;
}

export const categoryInputSchema = z.object({
  name: z.string().trim().min(2, 'Ponle nombre a la categoría').max(60),
});

export const stockAdjustSchema = z.object({
  warehouseId: z.string().uuid(),
  /** Existencia objetivo, no delta: la persona escribe "quedan 4", no "resta 2". */
  onHand: z.number().int().min(0).max(1_000_000),
  reason: z.string().trim().max(200).optional(),
});

export const imageOrderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_IMAGES_PER_PART),
});

// ───────────────────── Contrato de las respuestas (API → web) ─────────────────────

export interface CatalogStockRow {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderPoint: number | null;
  binLocation: string | null;
}

export interface CatalogVariant {
  id: string;
  sku: string;
  title: string;
  partNumber: string | null;
  oemNumbers: string[];
  barcode: string | null;
  priceCents: number;
  /** `null` sin permiso de costo: no se manda, no se oculta en el cliente. */
  costCents: number | null;
  isActive: boolean;
  position: number;
  onHand: number;
  reserved: number;
  stock: CatalogStockRow[];
}

export interface CatalogPartImage {
  id: string;
  url: string;
  alt: string | null;
  position: number;
}

export interface CatalogCompatibility {
  id: string;
  vehicleId: string;
  brand: string;
  model: string;
  yearStart: number;
  yearEnd: number;
  engine: string | null;
  bodyStyle: string | null;
  notes: string | null;
}

export interface CatalogMovement {
  id: string;
  createdAt: string;
  type: string;
  delta: number;
  balanceAfter: number;
  warehouseCode: string;
  reason: string | null;
  userName: string | null;
}

export interface CatalogPartSummary {
  id: string;
  name: string;
  slug: string;
  sku: string;
  brand: string | null;
  category: string | null;
  categoryId: string | null;
  condition: PartConditionKey;
  unit: string;
  warrantyDays: number | null;
  status: PartStatusKey;
  imageUrl: string | null;
  variantCount: number;
  priceMin: number;
  priceMax: number;
  onHand: number;
  reserved: number;
  /** Alguna variante quedó en o por debajo de su punto de reorden. */
  lowStock: boolean;
  outOfStock: boolean;
  updatedAt: string;
}

export interface CatalogPartDetail extends CatalogPartSummary {
  description: string | null;
  isUniversal: boolean;
  tags: string[];
  variants: CatalogVariant[];
  images: CatalogPartImage[];
  vehicles: CatalogCompatibility[];
  movements: CatalogMovement[];
}

export interface CatalogFacet {
  name: string;
  count: number;
}

export interface CatalogListResponse {
  items: CatalogPartSummary[];
  total: number;
  limit: number;
  offset: number;
  facets: {
    categories: Array<CatalogFacet & { id: string }>;
    brands: CatalogFacet[];
  };
}

export interface VehicleOption {
  id: string;
  brand: string;
  model: string;
  yearStart: number;
  yearEnd: number;
  engine: string | null;
  bodyStyle: string | null;
  /** Cuántas piezas del negocio ya aplican a esta aplicación. */
  parts: number;
}

/**
 * Bodega donde se puede ajustar existencia.
 *
 * No es `Warehouse` completo a propósito: la pantalla de la pieza solo necesita saber a qué
 * bodega escribir, y mandar dirección y teléfono sería contexto que nadie usa.
 */
export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}
