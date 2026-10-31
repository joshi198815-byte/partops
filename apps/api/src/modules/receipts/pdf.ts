import { amountInWords, formatMoney, type ReceiptFormat, type ReceiptSnapshot } from '@partops/contracts';
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';

/**
 * PDF del recibo: hoja carta y ticket de 80 mm.
 *
 * Tres decisiones que no son de estilo:
 *
 *  1. **Nada de datos internos.** El layout se arma desde `ReceiptSnapshot`, que nunca guardó el
 *     costo. Esta función no acepta el pedido completo: si un día alguien quiere "solo agregar el
 *     margen", el tipo se lo impide en vez de confiar en que se acuerde.
 *  2. **Se genera una vez.** Aquí no hay fecha "de hoy" ni datos vivos: todo sale del snapshot, así
 *     que el mismo snapshot produce el mismo documento. Lo que importa es que no se vuelve a
 *     generar: el archivo guardado es el que el cliente recibió.
 *  3. **Ni una línea se cae.** Un recibo de carta largo continúa en otra hoja; nunca se omite una
 *     pieza porque no cupo. Un recibo que no lista todo lo vendido es peor que no tener recibo.
 */

/** 72 puntos por pulgada. El ticket de 80 mm son 226.77 pt de ancho. */
const MM = 72 / 25.4;
const TICKET_WIDTH = 80 * MM;
const LETTER: [number, number] = [612, 792];

interface Palette {
  primary: ReturnType<typeof rgb>;
  accent: ReturnType<typeof rgb>;
  ink: ReturnType<typeof rgb>;
  muted: ReturnType<typeof rgb>;
  line: ReturnType<typeof rgb>;
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return rgb(0.09, 0.2, 0.31);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function palette(snapshot: ReceiptSnapshot): Palette {
  return {
    primary: hexToRgb(snapshot.tenant.brandPrimary),
    accent: hexToRgb(snapshot.tenant.brandAccent),
    ink: rgb(0.08, 0.1, 0.12),
    muted: rgb(0.42, 0.45, 0.49),
    line: rgb(0.84, 0.86, 0.88),
  };
}

/**
 * WinAnsiEncoding cubre los acentos del español; el reemplazo existe porque un nombre de pieza con
 * un carácter fuera de Latin-1 (un emoji del proveedor, un símbolo raro) haría explotar `drawText`
 * y dejaría al cliente sin recibo. Mejor un `?` que un 500.
 */
function safe(text: string): string {
  // Un carácter fuera de Latin-1 (emoji, símbolo raro) rompe drawText con WinAnsi y deja al
  // cliente sin recibo. Se reemplaza por `?`; el espacio y los saltos se conservan con String.raw.
  return Array.from(text)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code <= 0xff ? ch : '?';
    })
    .join('');
}

function money(cents: number, currency: string): string {
  return formatMoney(cents, currency).replace(/\u00A0/g, ' ');
}

function dateLabel(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-GT', {
      timeZone: timezone,
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

/** Corta un texto al ancho disponible midiendo con la fuente real, no contando caracteres. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // Una palabra sola más ancha que la columna (un SKU largo) se parte a la fuerza.
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      let chunk = '';
      for (const char of word) {
        if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
      continue;
    }
    current = word;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

async function qrPng(url: string): Promise<Uint8Array> {
  // Nivel M: aguanta una mancha o un reflejo en la pantalla del cliente sin dejar de leerse.
  return QRCode.toBuffer(url, { type: 'png', margin: 0, width: 512, errorCorrectionLevel: 'M' });
}

export interface PdfInput {
  snapshot: ReceiptSnapshot;
  publicUrl: string;
  format: ReceiptFormat;
  timezone?: string;
}

export async function renderReceiptPdf(input: PdfInput): Promise<Uint8Array> {
  return input.format === 'ticket' ? renderTicket(input) : renderLetter(input);
}

// ───────────────────────────── Hoja carta ─────────────────────────────

interface Row {
  quantity: number;
  titleLines: string[];
  detailLines: string[];
  unitPriceCents: number;
  totalCents: number;
  height: number;
}

async function renderLetter({ snapshot, publicUrl, timezone = 'America/Guatemala' }: PdfInput) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const c = palette(snapshot);

  const width = LETTER[0];
  const height = LETTER[1];
  const margin = 48;
  const right = width - margin;
  const contentWidth = right - margin;
  const cols = {
    qty: margin,
    desc: margin + 30,
    price: margin + contentWidth - 150,
    total: right,
  };
  const descWidth = cols.price - cols.desc - 12;

  // La primera hoja la crea `newPage(false)`. Crear una aquí también dejaría una hoja en blanco al
  // frente del recibo, y el cliente la imprimiría sin darse cuenta.
  let page!: PDFPage;
  let y = 0;
  let pageNumber = 0;

  const drawText = (
    value: string,
    opts: {
      x?: number;
      size?: number;
      font?: PDFFont;
      color?: ReturnType<typeof rgb>;
      to?: PDFPage;
      at?: number;
    } = {},
  ) => {
    const size = opts.size ?? 9.5;
    const f = opts.font ?? font;
    (opts.to ?? page).drawText(safe(value), {
      x: opts.x ?? margin,
      y: opts.at ?? y,
      size,
      font: f,
      color: opts.color ?? c.ink,
    });
  };

  const rightText = (value: string, x: number, size: number, f: PDFFont, color = c.ink) => {
    const line = safe(value);
    page.drawText(line, { x: x - f.widthOfTextAtSize(line, size), y, size, font: f, color });
  };

  const footer = () => {
    const legal = snapshot.notes
      ? `Nota: ${snapshot.notes}`
      : 'Documento no fiscal. Comprobante de entrega y pago.';
    let fy = 46;
    for (const l of wrap(legal, font, 7.5, contentWidth - 60).slice(0, 2)) {
      page.drawText(l, { x: margin, y: fy, size: 7.5, font, color: c.muted });
      fy -= 9;
    }
    page.drawLine({
      start: { x: margin, y: 40 },
      end: { x: right, y: 40 },
      thickness: 0.4,
      color: c.line,
    });
    const label = `${snapshot.folio} · pág. ${pageNumber}`;
    page.drawText(safe(label), {
      x: right - font.widthOfTextAtSize(safe(label), 7),
      y: 30,
      size: 7,
      font,
      color: c.muted,
    });
  };

  const tableHeader = () => {
    page.drawRectangle({ x: margin, y: y - 4, width: contentWidth, height: 16, color: c.primary });
    const th = (label: string, x: number, align: 'left' | 'right' = 'left') => {
      page.drawText(label, {
        x: align === 'right' ? x - bold.widthOfTextAtSize(label, 7.5) : x,
        y: y + 1,
        size: 7.5,
        font: bold,
        color: rgb(1, 1, 1),
      });
    };
    y -= 4;
    th('CANT.', cols.qty);
    th('PIEZA', cols.desc);
    th('PRECIO', cols.price, 'right');
    th('IMPORTE', cols.total, 'right');
    y -= 16;
  };

  /** Hoja nueva. La continuación repite la identidad del negocio en pequeño: hojas sueltas se mezclan. */
  const newPage = (continuation: boolean) => {
    if (pageNumber > 0) footer();
    page = doc.addPage(LETTER);
    pageNumber += 1;
    page.drawRectangle({ x: 0, y: height - 6, width, height: 6, color: c.primary });
    y = height - margin - 6;

    if (continuation) {
      drawText(snapshot.tenant.name, { size: 11, font: bold, color: c.primary });
      rightText(`${snapshot.orderCode} · ${snapshot.folio}`, right, 9, font, c.muted);
      y -= 16;
      page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 0.6, color: c.accent });
      y -= 16;
      tableHeader();
      return;
    }

    drawText(snapshot.tenant.name, { size: 17, font: bold, color: c.primary });
    y -= 14;
    const identity = [
      snapshot.tenant.legalName && snapshot.tenant.legalName !== snapshot.tenant.name
        ? snapshot.tenant.legalName
        : null,
      snapshot.tenant.taxId ? `NIT ${snapshot.tenant.taxId}` : null,
      snapshot.tenant.address,
      snapshot.tenant.phone,
    ].filter(Boolean) as string[];
    for (const line of identity) {
      drawText(line, { size: 8.5, color: c.muted });
      y -= 10.5;
    }

    // Folio arriba a la derecha, en la misma banda vertical.
    const folioY = height - margin - 12;
    const code = safe(snapshot.orderCode);
    page.drawText(code, {
      x: right - bold.widthOfTextAtSize(code, 20),
      y: folioY,
      size: 20,
      font: bold,
      color: c.ink,
    });
    const receiptLabel = `Recibo ${snapshot.folio}`;
    page.drawText(safe(receiptLabel), {
      x: right - font.widthOfTextAtSize(safe(receiptLabel), 9),
      y: folioY - 13,
      size: 9,
      font,
      color: c.muted,
    });
    const issued = dateLabel(snapshot.issuedAt, timezone);
    page.drawText(safe(issued), {
      x: right - font.widthOfTextAtSize(safe(issued), 9),
      y: folioY - 25,
      size: 9,
      font,
      color: c.muted,
    });

    y = Math.min(y, folioY - 40);
    page.drawLine({ start: { x: margin, y }, end: { x: right, y }, thickness: 0.75, color: c.accent });
    y -= 20;

    const half = contentWidth / 2;
    const clientLines = [
      ['Cliente', snapshot.customer.name],
      snapshot.customer.taxId ? ['NIT', snapshot.customer.taxId] : null,
      snapshot.customer.phone ? ['Teléfono', snapshot.customer.phone] : null,
    ].filter(Boolean) as Array<[string, string]>;
    const saleLines: Array<[string, string]> = [
      ['Vendió', snapshot.sellerName],
      ['Bodega', snapshot.warehouseCode],
      ['Canal', snapshot.channel],
    ];

    const blockTop = y;
    for (const [label, value] of clientLines) {
      drawText(label.toUpperCase(), { size: 7, font: bold, color: c.muted });
      y -= 11;
      drawText(value, { size: 10 });
      y -= 14;
    }
    const clientBottom = y;

    y = blockTop;
    for (const [label, value] of saleLines) {
      drawText(label.toUpperCase(), { size: 7, font: bold, color: c.muted, x: margin + half });
      y -= 11;
      drawText(value, { size: 10, x: margin + half });
      y -= 14;
    }

    y = Math.min(y, clientBottom) - 4;
    tableHeader();
  };

  const rows: Row[] = snapshot.lines.map((line) => {
    const titleLines = wrap(line.name, font, 9.5, descWidth);
    const detailParts = [
      line.variantTitle && line.variantTitle !== line.name ? line.variantTitle : null,
      `SKU ${line.sku}`,
      line.oem.length ? `OEM ${line.oem.join(', ')}` : null,
      line.vehicle,
    ].filter(Boolean) as string[];
    const detailLines = detailParts.length ? wrap(detailParts.join('  ·  '), font, 7.5, descWidth) : [];
    return {
      quantity: line.quantity,
      titleLines,
      detailLines,
      unitPriceCents: line.unitPriceCents,
      totalCents: line.totalCents,
      height: titleLines.length * 11.5 + detailLines.length * 9 + 12,
    };
  });

  newPage(false);

  // Zona inferior reservada: el pie siempre, los totales solo en la última hoja.
  const FOOTER_ZONE = 74;
  const TOTALS_ZONE = 210;

  rows.forEach((row, index) => {
    const reserve = FOOTER_ZONE + (index === rows.length - 1 ? TOTALS_ZONE : 0);
    if (y - row.height < reserve) {
      newPage(true);
    }

    let ty = y;
    for (const l of row.titleLines) {
      page.drawText(l, { x: cols.desc, y: ty, size: 9.5, font, color: c.ink });
      ty -= 11.5;
    }
    for (const l of row.detailLines) {
      page.drawText(l, { x: cols.desc, y: ty, size: 7.5, font, color: c.muted });
      ty -= 9;
    }
    page.drawText(String(row.quantity), { x: cols.qty, y, size: 9.5, font: mono, color: c.ink });

    const price = money(row.unitPriceCents, snapshot.currency);
    page.drawText(price, {
      x: cols.price - mono.widthOfTextAtSize(price, 9),
      y,
      size: 9,
      font: mono,
      color: c.ink,
    });
    const amount = money(row.totalCents, snapshot.currency);
    page.drawText(amount, {
      x: cols.total - bold.widthOfTextAtSize(amount, 9.5),
      y,
      size: 9.5,
      font: bold,
      color: c.ink,
    });

    y = ty - 5;
    page.drawLine({
      start: { x: margin, y: y + 2 },
      end: { x: right, y: y + 2 },
      thickness: 0.4,
      color: c.line,
    });
    y -= 6;
  });

  // Totales, importe en letras y QR. Si no caben, hoja nueva: recortarlos es peor que una hoja más.
  if (y - TOTALS_ZONE < FOOTER_ZONE) newPage(true);

  const totalsX = margin + contentWidth - 210;
  let ty = y - 14;

  const totalRow = (label: string, value: string, strong = false) => {
    page.drawText(safe(label), {
      x: totalsX,
      y: ty,
      size: strong ? 10.5 : 9,
      font: strong ? bold : font,
      color: strong ? c.ink : c.muted,
    });
    page.drawText(safe(value), {
      x: right - (strong ? bold : mono).widthOfTextAtSize(safe(value), strong ? 11 : 9),
      y: ty + (strong ? 0 : 0.5),
      size: strong ? 11 : 9,
      font: strong ? bold : mono,
      color: c.ink,
    });
    ty -= strong ? 16 : 13;
  };

  totalRow('Subtotal', money(snapshot.totals.subtotalCents, snapshot.currency));
  if (snapshot.totals.discountCents > 0) {
    totalRow('Descuento', `-${money(snapshot.totals.discountCents, snapshot.currency)}`);
  }
  totalRow(
    `IVA ${(snapshot.taxRateBps / 100).toFixed(2)}% incluido`,
    money(snapshot.totals.taxCents, snapshot.currency),
  );
  page.drawLine({
    start: { x: totalsX, y: ty + 8 },
    end: { x: right, y: ty + 8 },
    thickness: 0.6,
    color: c.line,
  });
  totalRow('Total', money(snapshot.totals.totalCents, snapshot.currency), true);
  totalRow('Pagado', money(snapshot.totals.paidCents, snapshot.currency));
  if (snapshot.totals.balanceCents !== 0) {
    totalRow(
      snapshot.totals.balanceCents > 0 ? 'Saldo' : 'Cambio',
      money(Math.abs(snapshot.totals.balanceCents), snapshot.currency),
    );
  }

  // Importe en letras + QR del recibo público.
  const leftWidth = totalsX - margin - 16;
  let ly = Math.min(y - 6, 250) + 4;
  page.drawText('IMPORTE EN LETRAS', { x: margin, y: ly, size: 7, font: bold, color: c.muted });
  ly -= 12;
  for (const l of wrap(amountInWords(snapshot.totals.totalCents, snapshot.currency), font, 8, leftWidth)) {
    page.drawText(l, { x: margin, y: ly, size: 8, font, color: c.ink });
    ly -= 10;
  }

  const qr = await doc.embedPng(await qrPng(publicUrl));
  const qrSize = 74;
  const qrY = Math.max(FOOTER_ZONE + 4, ly - qrSize - 14);
  page.drawImage(qr, { x: margin, y: qrY, width: qrSize, height: qrSize });

  let qx = qrY + qrSize - 8;
  for (const l of wrap('Escanea para ver el recibo en línea', font, 7, leftWidth - qrSize - 10)) {
    page.drawText(l, { x: margin + qrSize + 10, y: qx, size: 7, font, color: c.muted });
    qx -= 9;
  }
  page.drawText(safe(shortUrl(publicUrl)), {
    x: margin + qrSize + 10,
    y: qx - 2,
    size: 7,
    font,
    color: c.accent,
  });

  footer();

  doc.setTitle(`Recibo ${snapshot.folio} · ${snapshot.orderCode}`);
  doc.setAuthor(safe(snapshot.tenant.name));
  doc.setCreator('PartOps');
  doc.setCreationDate(new Date(snapshot.issuedAt));
  doc.setModificationDate(new Date(snapshot.issuedAt));
  doc.setSubject('Comprobante de venta');

  return doc.save();
}

// ───────────────────────────── Ticket 80 mm ─────────────────────────────

async function renderTicket({ snapshot, publicUrl, timezone = 'America/Guatemala' }: PdfInput) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const c = palette(snapshot);

  const margin = 7 * MM;
  const width = TICKET_WIDTH;
  const content = width - margin * 2;

  /**
   * Altura exacta, no estimada.
   *
   * Un ticket térmico no pagina: si el contenido no cabe, la impresora corta y el pie con el QR
   * desaparece sin que nadie lo note. Por eso la altura se suma bloque por bloque usando los
   * mismos `wrap` que después se dibujan; así no hay dos cálculos que puedan discrepar.
   */
  const qrSize = 34 * MM;
  const nameLines = wrap(snapshot.tenant.name, bold, 11, content).length;
  const identity = [
    snapshot.tenant.taxId ? `NIT ${snapshot.tenant.taxId}` : null,
    snapshot.tenant.address,
    snapshot.tenant.phone,
  ].filter(Boolean) as string[];
  const identityLines = identity.flatMap((l) => wrap(l, font, 7, content)).length;
  const clientLines = wrap(`Cliente: ${snapshot.customer.name}`, font, 8, content).length;
  const taxLines = snapshot.customer.taxId
    ? wrap(`NIT: ${snapshot.customer.taxId}`, font, 8, content).length
    : 0;
  const staffLines = wrap(
    `Atendió: ${snapshot.sellerName} · ${snapshot.warehouseCode}`,
    font,
    7,
    content,
  ).length;

  const itemsHeight = snapshot.lines.reduce((acc, line) => {
    const meta = [line.oem.length ? `OEM ${line.oem.join('/')}` : null, line.sku].filter(Boolean).join(' · ');
    return (
      acc +
      10 +
      wrap(line.name, font, 8, content).length * 9.5 +
      (meta ? wrap(meta, font, 6.5, content).length * 8 : 0) +
      3
    );
  }, 0);

  const totalsHeight =
    10 +
    10 +
    (snapshot.totals.discountCents > 0 ? 10 : 0) +
    14 +
    (snapshot.totals.balanceCents !== 0 ? 10 : 0);
  const wordsHeight =
    wrap(amountInWords(snapshot.totals.totalCents, snapshot.currency), font, 6.5, content).length * 8;
  const scanHeight = wrap('Escanea para ver tu recibo', font, 7, content).length * 8;
  const urlHeight = wrap(shortUrl(publicUrl), font, 6.5, content).length * 8;

  const body =
    nameLines * 13 +
    identityLines * 8.5 +
    15 + // separación y filete bajo la identidad
    11 + // RECIBO
    8 + // fecha en su propia línea: compartida con el folio se encimaba
    10 + // PEDIDO
    clientLines * 9 +
    taxLines * 9 +
    staffLines * 9 +
    16 + // filete
    itemsHeight +
    11 + // filete punteado
    totalsHeight +
    snapshot.payments.length * 9 +
    3 +
    wordsHeight +
    6 +
    qrSize +
    9 +
    scanHeight +
    urlHeight +
    2 +
    7;

  // Margen arriba y abajo más la franja de marca. Sin recortes: si sobra papel, sobra papel.
  const height = Math.ceil(margin * 2 + 4 + body + 6);

  const page = doc.addPage([width, height]);
  let y = height - margin - 4;

  const put = (
    value: string,
    opts: {
      size?: number;
      font?: PDFFont;
      color?: ReturnType<typeof rgb>;
      align?: 'center' | 'right' | 'left';
    } = {},
  ) => {
    const size = opts.size ?? 8;
    const f = opts.font ?? font;
    const line = safe(value);
    const lineWidth = f.widthOfTextAtSize(line, size);
    const x =
      opts.align === 'center'
        ? (width - lineWidth) / 2
        : opts.align === 'right'
          ? width - margin - lineWidth
          : margin;
    page.drawText(line, { x, y, size, font: f, color: opts.color ?? c.ink });
  };

  const rule = (dashed = false) => {
    if (dashed) {
      let x = margin;
      while (x < width - margin) {
        page.drawLine({
          start: { x, y },
          end: { x: Math.min(x + 2, width - margin), y },
          thickness: 0.4,
          color: c.line,
        });
        x += 4;
      }
    } else {
      page.drawLine({
        start: { x: margin, y },
        end: { x: width - margin, y },
        thickness: 0.4,
        color: c.line,
      });
    }
  };

  page.drawRectangle({ x: 0, y: height - 4, width, height: 4, color: c.primary });

  for (const l of wrap(snapshot.tenant.name, bold, 11, content)) {
    put(l, { size: 11, font: bold, align: 'center', color: c.primary });
    y -= 13;
  }
  for (const line of identity) {
    for (const l of wrap(line, font, 7, content)) {
      put(l, { size: 7, align: 'center', color: c.muted });
      y -= 8.5;
    }
  }

  y -= 4;
  rule();
  y -= 11;

  // Folio y fecha en líneas separadas: en 80 mm no caben lado a lado sin pisarse.
  put(`RECIBO ${snapshot.folio}`, { size: 9, font: bold, align: 'center' });
  y -= 8;
  put(dateLabel(snapshot.issuedAt, timezone), { size: 7, align: 'center', color: c.muted });
  y -= 10;
  put(`PEDIDO ${snapshot.orderCode}`, { size: 8, font: mono });
  y -= 10;
  for (const l of wrap(`Cliente: ${snapshot.customer.name}`, font, 8, content)) {
    put(l, { size: 8 });
    y -= 9;
  }
  if (snapshot.customer.taxId) {
    put(`NIT: ${snapshot.customer.taxId}`, { size: 8 });
    y -= 9;
  }
  put(`Atendió: ${snapshot.sellerName} · ${snapshot.warehouseCode}`, { size: 7, color: c.muted });
  y -= 6;
  rule();
  y -= 10;

  for (const line of snapshot.lines) {
    put(money(line.totalCents, snapshot.currency), { size: 8.5, font: bold, align: 'right' });
    put(`${line.quantity} x ${money(line.unitPriceCents, snapshot.currency)}`, {
      size: 7.5,
      font: mono,
      color: c.muted,
    });
    y -= 10;
    for (const l of wrap(line.name, font, 8, content)) {
      put(l, { size: 8 });
      y -= 9.5;
    }
    const meta = [line.oem.length ? `OEM ${line.oem.join('/')}` : null, line.sku].filter(Boolean).join(' · ');
    if (meta) {
      for (const l of wrap(meta, font, 6.5, content)) {
        put(l, { size: 6.5, color: c.muted });
        y -= 8;
      }
    }
    y -= 3;
  }

  rule(true);
  y -= 11;

  const totalRow = (label: string, value: string, strong = false) => {
    put(label, {
      size: strong ? 10 : 8,
      font: strong ? bold : font,
      color: strong ? c.ink : c.muted,
    });
    put(value, { size: strong ? 10 : 8, font: strong ? bold : mono, align: 'right' });
    y -= strong ? 14 : 10;
  };
  totalRow('Subtotal', money(snapshot.totals.subtotalCents, snapshot.currency));
  if (snapshot.totals.discountCents > 0) {
    totalRow('Descuento', `-${money(snapshot.totals.discountCents, snapshot.currency)}`);
  }
  totalRow(
    `IVA ${(snapshot.taxRateBps / 100).toFixed(2)}%`,
    money(snapshot.totals.taxCents, snapshot.currency),
  );
  totalRow('TOTAL', money(snapshot.totals.totalCents, snapshot.currency), true);
  if (snapshot.totals.balanceCents !== 0) {
    totalRow(
      snapshot.totals.balanceCents > 0 ? 'SALDO' : 'CAMBIO',
      money(Math.abs(snapshot.totals.balanceCents), snapshot.currency),
    );
  }

  for (const p of snapshot.payments) {
    put(`Pago ${p.method.toLowerCase()}`, { size: 7, color: c.muted });
    put(money(p.amountCents, snapshot.currency), { size: 7, align: 'right', color: c.muted });
    y -= 9;
  }

  y -= 3;
  for (const l of wrap(amountInWords(snapshot.totals.totalCents, snapshot.currency), font, 6.5, content)) {
    put(l, { size: 6.5, color: c.muted });
    y -= 8;
  }

  y -= 6;
  const qr = await doc.embedPng(await qrPng(publicUrl));
  page.drawImage(qr, { x: (width - qrSize) / 2, y: y - qrSize, width: qrSize, height: qrSize });
  y -= qrSize + 9;

  for (const l of wrap('Escanea para ver tu recibo', font, 7, content)) {
    put(l, { size: 7, align: 'center', color: c.muted });
    y -= 8;
  }
  for (const l of wrap(shortUrl(publicUrl), font, 6.5, content)) {
    put(l, { size: 6.5, align: 'center', color: c.accent });
    y -= 8;
  }
  y -= 2;
  put('Documento no fiscal', { size: 6.5, align: 'center', color: c.muted });

  doc.setTitle(`Recibo ${snapshot.folio} · ticket`);
  doc.setAuthor(safe(snapshot.tenant.name));
  doc.setCreator('PartOps');
  doc.setCreationDate(new Date(snapshot.issuedAt));
  doc.setModificationDate(new Date(snapshot.issuedAt));

  return doc.save();
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
