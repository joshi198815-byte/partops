import { z } from 'zod';
import { PART_CONDITIONS, type PartConditionKey } from './catalog.js';
import { formatMoney } from './money.js';

/**
 * Catálogo público: la vitrina del negocio en `partops.autos/c/<slug>`.
 *
 * Es la única superficie del producto que ve alguien que no trabaja en la bodega, y por eso las
 * reglas son distintas a las del mostrador:
 *
 *  - **La existencia se publica como disponibilidad, no como número.** "3 disponibles" le dice a
 *    la competencia cuánto inventario hay y le promete al cliente una pieza que otra persona puede
 *    estar comprando en ese instante. "Hay" / "Últimas" / "Agotado" es lo mismo para quien compra.
 *  - **Sin existencia no hay pedido.** El botón se apaga antes de enviar; el servidor lo vuelve a
 *    comprobar porque el navegador pudo tener la página abierta desde ayer.
 *  - **El costo nunca viaja.** No hay un campo que lo lleve, ni siquiera en `null`: un campo que
 *    existe con `null` termina serializado por accidente en el siguiente refactor.
 *  - **Pedir no requiere cuenta.** El cliente deja nombre y teléfono; el pedido entra a la misma
 *    cola de bodega que una venta de mostrador, con canal `CATALOGO`.
 */

// ───────────────────────────── Disponibilidad ─────────────────────────────

export const AVAILABILITY_BUCKETS = ['AGOTADO', 'POCAS', 'HAY'] as const;
export type AvailabilityBucket = (typeof AVAILABILITY_BUCKETS)[number];

/** Dos o menos es "últimas": es donde el cliente decide hoy en vez de la semana que viene. */
export const SCARCE_THRESHOLD = 2;

export function availabilityBucket(available: number): AvailabilityBucket {
  if (available <= 0) return 'AGOTADO';
  return available <= SCARCE_THRESHOLD ? 'POCAS' : 'HAY';
}

export const AVAILABILITY_LABEL: Record<AvailabilityBucket, string> = {
  HAY: 'Hay existencia',
  POCAS: 'Últimas unidades',
  AGOTADO: 'Agotado',
};

// ───────────────────────────── Negocio y piezas ─────────────────────────────

export interface PublicShop {
  slug: string;
  name: string;
  tagline: string | null;
  address: string | null;
  phone: string | null;
  /** E.164 sin signos, listo para `wa.me`. `null` si el negocio no publicó WhatsApp. */
  whatsappE164: string | null;
  logoUrl: string | null;
  brandPrimary: string;
  brandAccent: string;
  currency: string;
  /** Los precios publicados ya incluyen IVA (`pricesIncludeTax`): se dice para que no sorprenda. */
  pricesIncludeTax: boolean;
  taxRateBps: number;
}

export interface PublicAvailability {
  warehouseName: string;
  bucket: AvailabilityBucket;
}

export interface PublicVariant {
  /** Se usa para armar el pedido; es el único identificador que viaja en el carrito. */
  id: string;
  sku: string;
  title: string;
  partNumber: string | null;
  oemNumbers: string[];
  priceCents: number;
  availability: PublicAvailability[];
  /** Falso cuando ninguna bodega en línea tiene existencia: la tarjeta no ofrece "Pedir". */
  purchasable: boolean;
}

export interface PublicVehicle {
  brand: string;
  model: string;
  yearStart: number;
  yearEnd: number;
  engine: string | null;
}

export interface PublicCatalogItem {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  category: string | null;
  condition: PartConditionKey;
  unit: string;
  warrantyDays: number | null;
  imageUrl: string | null;
  imageFallbackUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  priceMinCents: number;
  priceMaxCents: number;
  availability: AvailabilityBucket;
  vehicles: PublicVehicle[];
  variants: PublicVariant[];
}

export interface PublicPart extends PublicCatalogItem {
  description: string | null;
}

export interface PublicFacet {
  name: string;
  count: number;
}

export interface PublicFacetModel {
  brand: string;
  model: string;
  yearStart: number;
  yearEnd: number;
  count: number;
}

export interface PublicCatalogFilters {
  q: string;
  brand: string | null;
  model: string | null;
  year: number | null;
}

export interface PublicCatalogResponse {
  shop: PublicShop;
  filters: PublicCatalogFilters;
  items: PublicCatalogItem[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    brands: PublicFacet[];
    categories: PublicFacet[];
    vehicles: { brands: PublicFacet[]; models: PublicFacetModel[] };
  };
  turnstile: { required: boolean; siteKey: string | null };
}

export interface PublicPartResponse {
  shop: PublicShop;
  part: PublicPart;
  turnstile: { required: boolean; siteKey: string | null };
}

// ───────────────────────────── Consultas y pedido ─────────────────────────────

export const PUBLIC_PAGE_SIZE = 20;

export const publicCatalogQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  brand: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  page: z.coerce.number().int().min(1).max(200).default(1),
});
export type PublicCatalogQuery = z.output<typeof publicCatalogQuerySchema>;

export const PUBLIC_ORDER_MAX_ITEMS = 10;
export const PUBLIC_ORDER_MAX_QUANTITY = 20;

export const publicOrderItemSchema = z.object({
  variantId: z.string().uuid('Elige una pieza del catálogo'),
  quantity: z
    .number()
    .int()
    .min(1, 'La cantidad mínima es 1')
    .max(PUBLIC_ORDER_MAX_QUANTITY, `Máximo ${PUBLIC_ORDER_MAX_QUANTITY} por pieza`),
});

/**
 * Pedido de invitado.
 *
 * No pide NIT ni correo: cada campo extra en la vitrina cuesta pedidos. El teléfono es obligatorio
 * porque sin él no hay forma de avisar que la pieza está lista —y una pieza reservada para alguien
 * que no se puede localizar es inventario detenido.
 */
export const publicOrderSchema = z.object({
  customerName: z.string().trim().min(2, 'Escribe tu nombre').max(80, 'El nombre es demasiado largo'),
  customerPhone: z.string().trim().min(8, 'Escribe tu teléfono').max(24, 'Teléfono demasiado largo'),
  note: z.string().trim().max(300, 'La nota es demasiado larga').optional(),
  items: z
    .array(publicOrderItemSchema)
    .min(1, 'Agrega al menos una pieza')
    .max(PUBLIC_ORDER_MAX_ITEMS, `Máximo ${PUBLIC_ORDER_MAX_ITEMS} piezas por pedido`),
  /** Token de Turnstile. Obligatorio solo cuando el negocio tiene la protección configurada. */
  turnstileToken: z.string().trim().max(4096).optional(),
  /** Reintento del teléfono sin señal: la misma clave devuelve el mismo pedido, no dos. */
  idempotencyKey: z.string().trim().min(8).max(120),
});
export type PublicOrderData = z.output<typeof publicOrderSchema>;

export interface PublicOrderLine {
  name: string;
  variantTitle: string | null;
  sku: string;
  quantity: number;
  totalCents: number;
}

export interface PublicOrderResult {
  /** Folio legible (`PD-0042`). Es lo que el cliente dicta por teléfono. */
  code: string;
  totalCents: number;
  currency: string;
  status: string;
  /** `false` si alguna línea quedó `SIN_STOCK`: la bodega la consigue y avisa. */
  allAvailable: boolean;
  whatsappUrl: string | null;
  lines: PublicOrderLine[];
}

/**
 * Mensaje estructurado para el WhatsApp del negocio.
 *
 * Se arma en el servidor por la misma razón que el del recibo: el texto del botón de la vitrina y
 * el del reenvío tienen que decir lo mismo. Un pedido que llega como "hola, sí hay?" obliga a
 * reconstruir la conversación a mano; este llega con folio, piezas y total.
 */
export function publicOrderWhatsAppMessage(input: {
  shopName: string;
  orderCode: string;
  customerName: string;
  customerPhone: string;
  lines: PublicOrderLine[];
  totalCents: number;
  currency?: string;
  catalogUrl: string;
  note?: string | null;
}): string {
  const money = (cents: number) => formatMoney(cents, input.currency ?? 'GTQ').replace(/\u00A0/g, ' ');
  const items = input.lines.map(
    (line, i) =>
      `${i + 1}. ${line.name}${line.variantTitle ? ` (${line.variantTitle})` : ''} · ${line.sku} × ${line.quantity} — ${money(line.totalCents)}`,
  );
  return [
    `Hola ${input.shopName}, quiero confirmar este pedido del catálogo.`,
    '',
    `Pedido: ${input.orderCode}`,
    `A nombre de: ${input.customerName}`,
    `Teléfono: ${input.customerPhone}`,
    '',
    ...items,
    '',
    `Total: ${money(input.totalCents)}`,
    ...(input.note ? ['', `Nota: ${input.note}`] : []),
    '',
    input.catalogUrl,
  ].join('\n');
}

/** `wa.me` con el mensaje cargado. `null` si el negocio no tiene WhatsApp publicado. */
export function shopWhatsAppUrl(shop: Pick<PublicShop, 'whatsappE164'>, text: string): string | null {
  const digits = (shop.whatsappE164 ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Consulta libre desde la vitrina, para la pieza que no se encontró. */
export function catalogInquiryMessage(input: { shopName: string; query: string; catalogUrl: string }) {
  const term = input.query.trim();
  return [
    `Hola ${input.shopName}, busco ${term ? `"${term}"` : 'una pieza'} y no la encontré en el catálogo.`,
    '¿Me ayudan a conseguirla?',
    '',
    input.catalogUrl,
  ].join('\n');
}

export const PART_CONDITION_LABEL: Record<PartConditionKey, string> = {
  NUEVO: 'Nuevo',
  USADO: 'Usado',
  REMANUFACTURADO: 'Remanufacturado',
};

/** El estado tiene que ser uno de los conocidos: el catálogo no inventa condiciones. */
export const PUBLIC_CONDITIONS = PART_CONDITIONS;
