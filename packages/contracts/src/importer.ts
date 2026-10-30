/**
 * Importador de catálogo desde Excel/CSV.
 *
 * Dos propiedades que no se negocian:
 *
 *  1. **Nada se escribe sin vista previa.** El archivo se mapea, se valida fila por fila y se muestra
 *     qué se va a crear, actualizar o rechazar. El usuario corrige antes de tocar la base.
 *  2. **Una fila mala no tumba el lote.** El modo "omitir inválidas" procesa lo bueno y devuelve un
 *     reporte con la fila original de cada error, para que se pueda corregir en el mismo Excel.
 *
 * El formato de entrada no es rígido: se mapean columnas por nombre, porque cada bodega tiene su
 * propio Excel y pedirles que lo rehagan es la razón por la que no usan el sistema.
 */

import { toCents } from './money.js';
import { normalizeQuery } from './search.js';
import { parseYearRange } from './vehicles.js';

/** Claves válidas del importador. Se declara antes que `IMPORT_FIELDS` para no auto-referenciarse. */
export type ImportFieldKey =
  | 'sku'
  | 'name'
  | 'partNumber'
  | 'oemNumbers'
  | 'category'
  | 'brand'
  | 'condition'
  | 'unit'
  | 'warrantyDays'
  | 'cost'
  | 'price'
  | 'vehicleBrand'
  | 'vehicleModel'
  | 'vehicleYears'
  | 'vehicleEngine'
  | 'warehouse'
  | 'stock'
  | 'binLocation'
  | 'barcode';

/** Campos que el importador entiende. `required` solo lo es para crear una pieza desde cero. */
export interface ImportField {
  key: ImportFieldKey;
  label: string;
  required?: boolean;
  group: 'pieza' | 'vehiculo' | 'inventario';
  hint: string;
  /** Nombres alternativos que se reconocen automáticamente al mapear el encabezado. */
  aliases: string[];
}

export const IMPORT_FIELDS: readonly ImportField[] = [
  {
    key: 'sku',
    label: 'SKU',
    required: true,
    group: 'pieza',
    hint: 'Código interno. Si se repite, la fila actualiza esa variante en lugar de crear otra.',
    aliases: ['sku', 'codigo', 'código', 'codigo interno', 'clave', 'item'],
  },
  {
    key: 'name',
    label: 'Nombre de la pieza',
    required: true,
    group: 'pieza',
    hint: 'Lo que busca el vendedor: "Capó", "Faro delantero izquierdo".',
    aliases: ['nombre', 'descripcion', 'descripción', 'producto', 'pieza', 'repuesto'],
  },
  {
    key: 'partNumber',
    label: 'Número de parte',
    required: false,
    group: 'pieza',
    hint: 'Código del fabricante de la pieza (no el OEM del carro).',
    aliases: ['numero de parte', 'número de parte', 'part number', 'partnumber', 'no parte', 'codigo pieza'],
  },
  {
    key: 'oemNumbers',
    label: 'Códigos OEM',
    required: false,
    group: 'pieza',
    hint: 'Códigos del fabricante del vehículo. Separa varios con coma o barra.',
    aliases: ['oem', 'codigo oem', 'código oem', 'oem numbers', 'numeros oem', 'número oem'],
  },
  {
    key: 'category',
    label: 'Categoría',
    required: false,
    group: 'pieza',
    hint: 'Capó, Faro, Frenos, Suspensión. Si no existe, se crea.',
    aliases: ['categoria', 'categoría', 'grupo', 'familia', 'linea', 'línea'],
  },
  {
    key: 'brand',
    label: 'Marca de la pieza',
    required: false,
    group: 'pieza',
    hint: 'Fabricante de la pieza (Bosch, Denso, Genérico). No confundir con la marca del carro.',
    aliases: ['marca pieza', 'marca repuesto', 'fabricante', 'brand'],
  },
  {
    key: 'condition',
    label: 'Condición',
    required: false,
    group: 'pieza',
    hint: 'Nuevo, usado o remanufacturado. Vacío = nuevo.',
    aliases: ['condicion', 'condición', 'estado pieza', 'tipo pieza'],
  },
  {
    key: 'unit',
    label: 'Unidad',
    required: false,
    group: 'pieza',
    hint: 'Unidad, par, juego, litro. Vacío = unidad.',
    aliases: ['unidad', 'unidad de medida', 'medida', 'um'],
  },
  {
    key: 'warrantyDays',
    label: 'Garantía (días)',
    required: false,
    group: 'pieza',
    hint: 'Días de garantía que se imprimen en el recibo.',
    aliases: ['garantia', 'garantía', 'dias garantia', 'días garantía', 'warranty'],
  },
  {
    key: 'cost',
    label: 'Costo',
    required: false,
    group: 'pieza',
    hint: 'Lo que costó. Solo lo ve quien tiene permiso de costo.',
    aliases: ['costo', 'precio costo', 'compra', 'costo unitario'],
  },
  {
    key: 'price',
    label: 'Precio de venta',
    required: true,
    group: 'pieza',
    hint: 'Precio al público, con IVA incluido.',
    aliases: ['precio', 'precio venta', 'precio publico', 'precio público', 'pvp', 'price'],
  },
  {
    key: 'vehicleBrand',
    label: 'Marca del vehículo',
    required: false,
    group: 'vehiculo',
    hint: 'Toyota, Nissan, Mazda. Una fila puede generar varias compatibilidades.',
    aliases: ['marca vehiculo', 'marca vehículo', 'marca carro', 'marca auto', 'vehiculo marca'],
  },
  {
    key: 'vehicleModel',
    label: 'Modelo del vehículo',
    required: false,
    group: 'vehiculo',
    hint: 'Corolla, Sentra, Hilux.',
    aliases: ['modelo', 'modelo vehiculo', 'modelo vehículo', 'modelo carro', 'vehiculo modelo'],
  },
  {
    key: 'vehicleYears',
    label: 'Años',
    required: false,
    group: 'vehiculo',
    hint: '2009, 2009-2013. Separa varias aplicaciones con punto y coma.',
    aliases: ['año', 'años', 'anio', 'anios', 'year', 'years', 'años vehiculo', 'rango años'],
  },
  {
    key: 'vehicleEngine',
    label: 'Motor',
    required: false,
    group: 'vehiculo',
    hint: '1.8L, 2.0 Turbo, 2.4 Diesel. Opcional pero evita vender una pieza que no entra.',
    aliases: ['motor', 'cilindrada', 'engine', 'motor vehiculo'],
  },
  {
    key: 'warehouse',
    label: 'Código de bodega',
    required: false,
    group: 'inventario',
    hint: 'BODEGA-CENTRAL, TIENDA-Z4. Vacío = la bodega por defecto.',
    aliases: ['bodega', 'almacen', 'almacén', 'warehouse', 'sucursal'],
  },
  {
    key: 'stock',
    label: 'Existencia',
    required: false,
    group: 'inventario',
    hint: 'Cuántas hay en esa bodega. Vacío = 0.',
    aliases: ['existencia', 'stock', 'cantidad', 'qty', 'inventario'],
  },
  {
    key: 'binLocation',
    label: 'Pasillo / estante',
    required: false,
    group: 'inventario',
    hint: 'A-03-2. Es lo que el bodeguero necesita para encontrar la pieza.',
    aliases: ['ubicacion', 'ubicación', 'pasillo', 'estante', 'anaquel', 'bin', 'localizacion'],
  },
  {
    key: 'barcode',
    label: 'Código de barras',
    required: false,
    group: 'inventario',
    hint: 'EAN de la etiqueta. Si choca con otra pieza, la fila se rechaza.',
    aliases: ['codigo de barras', 'código de barras', 'barcode', 'ean', 'upc', 'codigo barras'],
  },
] as const;

export type ColumnMapping = Partial<Record<ImportFieldKey, string>>;

export function normalizeHeader(header: string): string {
  return normalizeQuery(header);
}

/**
 * Mapea encabezados reales a campos conocidos. Devuelve también los encabezados que no se
 * reconocieron, para que la UI los muestre en vez de ignorarlos en silencio.
 */
export function autoMapColumns(headers: string[]): {
  mapping: ColumnMapping;
  unmapped: string[];
} {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));

  // Primero los campos requeridos y los de nombre compuesto ("marca del vehiculo"), porque si se
  // asigna "marca" a la marca de la pieza, la del vehículo se queda sin columna.
  const ordered = [...IMPORT_FIELDS].sort((a, b) => {
    const score = (f: ImportField) => (f.required ? 2 : 0) + (f.key.startsWith('vehicle') ? 1 : 0);
    return score(b) - score(a);
  });

  for (const field of ordered) {
    const hit = normalized.find(
      (h) => !used.has(h.raw) && field.aliases.some((a) => normalizeHeader(a) === h.norm),
    );
    if (hit) {
      mapping[field.key] = hit.raw;
      used.add(hit.raw);
    }
  }
  return { mapping, unmapped: headers.filter((h) => !used.has(h)) };
}

export interface ImportRow {
  sku?: string;
  name: string;
  partNumber?: string | null;
  oemNumbers: string[];
  category?: string | null;
  brand?: string | null;
  condition?: string | null;
  unit?: string | null;
  warrantyDays?: number | null;
  costCents?: number | null;
  priceCents: number;
  vehicles: {
    brand?: string | null;
    model?: string | null;
    years: { start: number; end: number }[];
    engine?: string | null;
  }[];
  warehouseCode?: string | null;
  stock: number;
  binLocation?: string | null;
  barcode?: string | null;
}

export interface RowError {
  field: string;
  message: string;
}

export interface RowValidation {
  rowNumber: number;
  ok: boolean;
  data: ImportRow | null;
  errors: RowError[];
  warnings: RowError[];
}

const splitList = (value: string | number | null | undefined): string[] => {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(/[,;/|]/)
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Cantidades: entero o nada. "1,500" y "1.500" son mil quinientos (separador de miles); "2.5" es
 * una fracción y se rechaza en lugar de recortarla a 2 — recortar en silencio descuadra el
 * inventario sin que nadie lo note.
 */
export function parseQuantity(raw: string): number | null {
  const text = raw.replace(/\s/g, '');
  if (!text) return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(text)) return Number(text.replace(/[.,]/g, ''));
  return null;
}

const CONDITION_MAP: Record<string, string> = {
  nuevo: 'NUEVO',
  new: 'NUEVO',
  n: 'NUEVO',
  usado: 'USADO',
  use: 'USADO',
  u: 'USADO',
  remanufacturado: 'REMANUFACTURADO',
  reman: 'REMANUFACTURADO',
  reconstruido: 'REMANUFACTURADO',
};

/**
 * Valida una fila ya mapeada. `rowNumber` es el número real en el archivo (fila 1 = encabezado),
 * para que el reporte de errores diga la misma fila que el usuario ve en su Excel.
 */
export function validateImportRow(
  raw: Record<string, string | number | null>,
  rowNumber: number,
): RowValidation {
  const errors: RowError[] = [];
  const warnings: RowError[] = [];
  const str = (k: string): string | null => {
    const v = raw[k];
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s || null;
  };

  const name = str('name');
  if (!name) errors.push({ field: 'name', message: 'Falta el nombre de la pieza' });

  const skuRaw = str('sku');
  if (!skuRaw) errors.push({ field: 'sku', message: 'Falta el SKU' });
  const sku = skuRaw?.toUpperCase().replace(/\s+/g, '-') ?? null;

  const priceText = raw.price;
  const priceCents = toCents(priceText as string | number | null);
  if (!Number.isFinite(priceCents)) errors.push({ field: 'price', message: 'Precio inválido o vacío' });
  else if (priceCents <= 0) errors.push({ field: 'price', message: 'El precio debe ser mayor que cero' });

  const costRaw = raw.cost;
  const costCents =
    costRaw === null || costRaw === undefined || String(costRaw).trim() === ''
      ? null
      : toCents(costRaw as string | number);
  if (costCents !== null && !Number.isFinite(costCents)) {
    errors.push({ field: 'cost', message: 'Costo inválido' });
  }
  if (costCents !== null && Number.isFinite(costCents) && costCents > priceCents) {
    warnings.push({ field: 'cost', message: 'El costo es mayor que el precio: la venta daría pérdida' });
  }

  const stockText = raw.stock;
  const hasStock = stockText !== null && stockText !== undefined && String(stockText).trim() !== '';
  const stock = hasStock ? parseQuantity(String(stockText)) : 0;
  if (hasStock && stock === null) {
    errors.push({ field: 'stock', message: 'La existencia debe ser un número entero' });
  } else if (stock !== null && stock < 0) {
    errors.push({ field: 'stock', message: 'La existencia no puede ser negativa' });
  }

  const warrantyText = raw.warrantyDays;
  const warrantyDays =
    warrantyText === null || warrantyText === undefined || String(warrantyText).trim() === ''
      ? null
      : Number(String(warrantyText).replace(/[^\d]/g, ''));
  if (warrantyDays !== null && !Number.isFinite(warrantyDays)) {
    errors.push({ field: 'warrantyDays', message: 'Garantía inválida' });
  }

  // Vehículo: si viene marca o modelo, los años son obligatorios. Una compatibilidad sin años
  // aplica a todos los años del modelo, y eso no existe en repuestos.
  const vBrand = str('vehicleBrand');
  const vModel = str('vehicleModel');
  const yearsText = str('vehicleYears');
  const vehicleRows: ImportRow['vehicles'] = [];
  if (vBrand || vModel) {
    if (!vBrand) errors.push({ field: 'vehicleBrand', message: 'Falta la marca del vehículo' });
    if (!vModel) errors.push({ field: 'vehicleModel', message: 'Falta el modelo del vehículo' });
    if (!yearsText) {
      errors.push({ field: 'vehicleYears', message: 'Falta el año o rango de años del vehículo' });
    } else {
      const chunks = yearsText
        .split(/[;/|]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const years = chunks.map(parseYearRange);
      if (years.some((y) => y === null)) {
        errors.push({
          field: 'vehicleYears',
          message: `Año inválido: "${yearsText}". Usa 2009 o 2009-2013`,
        });
      } else {
        vehicleRows.push({
          brand: vBrand,
          model: vModel,
          years: years.filter((y): y is { start: number; end: number } => y !== null),
          engine: str('vehicleEngine'),
        });
      }
    }
  } else if (yearsText) {
    warnings.push({
      field: 'vehicleYears',
      message: 'Hay años pero no marca/modelo: se ignora la compatibilidad',
    });
  }

  const conditionRaw = normalizeQuery(str('condition') ?? '');
  const condition = conditionRaw ? (CONDITION_MAP[conditionRaw] ?? null) : null;
  if (conditionRaw && !condition) {
    warnings.push({ field: 'condition', message: `Condición desconocida "${conditionRaw}": se usará Nuevo` });
  }

  const ok = errors.length === 0;
  const data: ImportRow | null = ok
    ? {
        sku: sku ?? undefined,
        name: name as string,
        partNumber: str('partNumber'),
        oemNumbers: splitList(raw.oemNumbers).map((s) => s.toUpperCase()),
        category: str('category'),
        brand: str('brand'),
        condition: condition ?? 'NUEVO',
        unit: str('unit'),
        warrantyDays: warrantyDays === null ? null : Number(warrantyDays),
        costCents: costCents === null ? null : Number(costCents),
        priceCents: Number(priceCents),
        vehicles: vehicleRows,
        warehouseCode: str('warehouse'),
        stock: stock ?? 0,
        binLocation: str('binLocation'),
        barcode: str('barcode'),
      }
    : null;

  return { rowNumber, ok, data, errors, warnings };
}

/** Aplica el mapeo a una fila cruda del archivo. */
export function applyMapping(
  row: Record<string, string | number | null>,
  mapping: ColumnMapping,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [field, header] of Object.entries(mapping)) {
    if (!header) continue;
    out[field] = row[header] ?? null;
  }
  return out;
}

/**
 * Firma de duplicado dentro del mismo archivo. El SKU manda cuando existe; si la fila no lo trae
 * (compatibilidades de una pieza ya creada), la firma es pieza + aplicación, que es lo que
 * realmente se duplicaría en la base.
 */
export function rowSignature(row: ImportRow): string {
  const vehicle = row.vehicles
    .flatMap((v) =>
      v.years.map(
        (y) => `${normalizeQuery(v.brand ?? '')}|${normalizeQuery(v.model ?? '')}|${y.start}-${y.end}`,
      ),
    )
    .join(';');
  const base = row.sku ? `sku:${row.sku}` : `name:${normalizeQuery(row.name)}`;
  return vehicle ? `${base}|${vehicle}` : base;
}

export interface ImportPreview {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  /** Piezas distintas que se crearían (varias filas pueden ser variantes de la misma pieza). */
  parts: number;
  compatibilities: number;
  errors: { rowNumber: number; errors: RowError[] }[];
  warnings: { rowNumber: number; warnings: RowError[] }[];
  unmappedHeaders: string[];
}

/** Resumen para la vista previa: qué va a pasar si se confirma. No escribe nada. */
export function buildPreview(
  rows: Record<string, string | number | null>[],
  mapping: ColumnMapping,
  unmappedHeaders: string[] = [],
): ImportPreview {
  const validations = rows.map((r, i) => validateImportRow(applyMapping(r, mapping), i + 2));
  const seen = new Map<string, number>();
  let duplicateRows = 0;

  for (const v of validations) {
    if (!v.ok || !v.data) continue;
    const sig = rowSignature(v.data);
    const first = seen.get(sig);
    if (first !== undefined) {
      duplicateRows++;
      v.ok = false;
      v.errors.push({ field: 'sku', message: `SKU repetido en el archivo (ya aparece en la fila ${first})` });
    } else {
      seen.set(sig, v.rowNumber);
    }
  }

  const valid = validations.filter((v) => v.ok && v.data);
  const parts = new Set(valid.map((v) => normalizeQuery(v.data?.name ?? '')));
  // Una fila con "2003-2008;2009-2013" son dos aplicaciones reales, no una.
  const compatibilities = valid.reduce(
    (sum, v) => sum + (v.data?.vehicles.reduce((n, veh) => n + veh.years.length, 0) ?? 0),
    0,
  );

  return {
    totalRows: validations.length,
    validRows: valid.length,
    invalidRows: validations.length - valid.length,
    duplicateRows,
    parts: parts.size,
    compatibilities,
    errors: validations
      .filter((v) => !v.ok)
      .slice(0, 500)
      .map((v) => ({ rowNumber: v.rowNumber, errors: v.errors })),
    warnings: validations
      .filter((v) => v.warnings.length > 0)
      .slice(0, 200)
      .map((v) => ({ rowNumber: v.rowNumber, warnings: v.warnings })),
    unmappedHeaders,
  };
}
