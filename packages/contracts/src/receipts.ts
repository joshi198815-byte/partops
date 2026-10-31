/**
 * Recibos.
 *
 * Un recibo no es una vista del pedido: es una **foto** del pedido tomada el día que se emitió.
 * Por eso el `snapshot` se congela en la base y el PDF se genera una sola vez. Si mañana alguien
 * corrige un precio, cambia el nombre del negocio o borra una pieza, el recibo que el cliente ya
 * tiene en su WhatsApp sigue diciendo lo mismo. Un recibo que cambia después de entregado no es
 * un recibo: es una factura falsa esperando a que la SAT pregunte.
 */

import { formatMoney } from './money.js';

export const RECEIPT_FORMATS = ['carta', 'ticket'] as const;
export type ReceiptFormat = (typeof RECEIPT_FORMATS)[number];

export const RECEIPT_FORMAT_LABEL: Record<ReceiptFormat, string> = {
  carta: 'Hoja carta',
  ticket: 'Ticket 80 mm',
};

export interface ReceiptLineSnapshot {
  sku: string;
  name: string;
  variantTitle: string;
  unit: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  totalCents: number;
  /** Códigos OEM y vehículo: es lo que el mecánico busca cuando vuelve por otra pieza igual. */
  oem: string[];
  vehicle: string | null;
}

export interface ReceiptSnapshot {
  /** Versión del formato. Si el día de mañana cambia el layout, los viejos siguen legibles. */
  version: 1;
  orderId: string;
  /** Folio del recibo (`R-0001`). Vive en el snapshot para que el PDF y la página digan lo mismo. */
  folio: string;
  orderCode: string;
  orderNumber: number;
  issuedAt: string;
  channel: string;
  status: string;
  customer: { name: string; phone: string | null; taxId: string | null };
  sellerName: string;
  warehouseCode: string;
  tenant: {
    name: string;
    legalName: string | null;
    taxId: string | null;
    address: string | null;
    phone: string | null;
    slug: string;
    brandPrimary: string;
    brandAccent: string;
  };
  lines: ReceiptLineSnapshot[];
  totals: {
    subtotalCents: number;
    taxCents: number;
    discountCents: number;
    totalCents: number;
    paidCents: number;
    balanceCents: number;
  };
  payments: Array<{ method: string; amountCents: number; createdAt: string }>;
  taxRateBps: number;
  currency: string;
  notes: string | null;
}

/** Lo que ve un cliente sin cuenta al abrir `/r/<token>`. Nada más viaja al navegador. */
export interface ReceiptPublicView {
  folio: string;
  token: string;
  createdAt: string;
  totalCents: number;
  snapshot: ReceiptSnapshot;
  /** Ruta del PDF de carta, o `null` mientras se genera. */
  pdfUrl: string | null;
  /** Ruta del ticket de 80 mm, o `null` si no se generó. */
  ticketUrl: string | null;
}

/** Lo que ve el mostrador al emitir o reenviar. */
export interface ReceiptSummary {
  id: string;
  folio: string;
  token: string;
  createdAt: string;
  totalCents: number;
  publicUrl: string;
  pdfUrl: string;
  /** Ticket de 80 mm. `null` si el recibo se emitió antes de existir ese formato. */
  ticketUrl: string | null;
  whatsappUrl: string | null;
}

export interface ReceiptTokens {
  /** Enlace corto que se dicta o se manda por WhatsApp. */
  publicUrl: string;
  pdfUrl: string;
}

/**
 * Enlace que se comparte. La web es la que sirve `/r/<token>`, no la API: el cliente ve una página
 * con marca del negocio, no un JSON.
 */
export function receiptUrls(webUrl: string, token: string): ReceiptTokens {
  const base = webUrl.replace(/\/+$/, '');
  return {
    publicUrl: `${base}/r/${token}`,
    pdfUrl: `${base}/api/public/receipts/${token}/pdf`,
  };
}

/**
 * Texto del mensaje de WhatsApp.
 *
 * Se arma en el servidor y no en la pantalla porque el mismo texto va al botón del mostrador y al
 * reenvío diferido; dos plantillas acaban diciendo cosas distintas del mismo recibo.
 */
export function receiptWhatsAppMessage(input: {
  tenantName: string;
  customerName: string;
  folio: string;
  orderCode: string;
  totalCents: number;
  publicUrl: string;
  currency?: string;
}): string {
  // El espacio duro que mete `Intl` en "Q 68,000.00" viaja codificado como %C2%A0 en la URL y en
  // WhatsApp se ve como un hueco raro. Aquí va un espacio normal.
  const total = formatMoney(input.totalCents, input.currency ?? 'GTQ').replace(/\u00A0/g, ' ');
  return [
    `Hola ${input.customerName}, tu recibo de ${input.tenantName} está listo.`,
    '',
    `Pedido: ${input.orderCode}`,
    `Recibo: ${input.folio}`,
    `Total: ${total}`,
    '',
    input.publicUrl,
  ].join('\n');
}

/**
 * Enlace de WhatsApp con el mensaje prellenado.
 *
 * `wa.me` exige solo dígitos y país. Si el teléfono no está en E.164 se devuelve `null` en vez de
 * un enlace que abre WhatsApp con un número inválido: es peor que no ofrecer el botón.
 */
export function whatsappShareUrl(phoneE164: string | null | undefined, text: string): string | null {
  const digits = (phoneE164 ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// ───────────────────────────── Importe en letras ─────────────────────────────

const UNITS = [
  '',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const TENS = [
  '',
  '',
  'veinte',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

function below100(n: number): string {
  if (n < 30) return UNITS[n] ?? '';
  const tens = Math.floor(n / 10);
  const unit = n % 10;
  return unit === 0 ? (TENS[tens] ?? '') : `${TENS[tens]} y ${UNITS[unit] ?? ''}`;
}

function below1000(n: number): string {
  if (n === 100) return 'cien';
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return below100(rest);
  return rest === 0 ? (HUNDREDS[hundreds] ?? '') : `${HUNDREDS[hundreds]} ${below100(rest)}`;
}

/** `veintiuno` → `veintiún` cuando precede a `mil`: "veintiún mil", no "veintiuno mil". */
function apocope(word: string): string {
  return word.endsWith('veintiuno') ? `${word.slice(0, -9)}veintiún` : word;
}

/** Número entero a letras en español. Cubre hasta 999 999 999, de sobra para una bodega. */
export function numberToWords(n: number): string {
  const value = Math.floor(Math.abs(n));
  if (value === 0) return 'cero';
  if (value < 1000) return below1000(value);

  if (value < 1_000_000) {
    const thousands = Math.floor(value / 1000);
    const rest = value % 1000;
    const head = thousands === 1 ? 'mil' : `${apocope(below1000(thousands))} mil`;
    return rest === 0 ? head : `${head} ${below1000(rest)}`;
  }

  const millions = Math.floor(value / 1_000_000);
  const rest = value % 1_000_000;
  const head = millions === 1 ? 'un millón' : `${apocope(below1000(millions))} millones`;
  return rest === 0 ? head : `${head} ${numberToWords(rest)}`;
}

/**
 * `2100.00` → `DOS MIL CIEN QUETZALES CON 00/100`.
 *
 * Va en mayúsculas porque así se imprime en los recibos guatemaltecos y porque en el ticket de
 * 80 mm es la única forma de que el total en letras quepa y se lea.
 */
export function amountInWords(cents: number, currency = 'GTQ'): string {
  const safe = Math.max(0, Math.round(cents));
  const whole = Math.floor(safe / 100);
  const fraction = safe % 100;
  const currencyName = currency === 'GTQ' ? 'QUETZALES' : currency.toUpperCase();
  const words = `${numberToWords(whole)} ${currencyName}`.toUpperCase();
  return `${words} CON ${String(fraction).padStart(2, '0')}/100`;
}
