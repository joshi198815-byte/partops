import { BadRequestException } from '@nestjs/common';
import { autoMapColumns, type ColumnMapping, MAX_IMPORT_ROWS } from '@partops/contracts';
import ExcelJS from 'exceljs';

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string | number | null>[];
  mapping: ColumnMapping;
  unmapped: string[];
  rowCount: number;
  truncated: boolean;
  sheetName: string;
}

/**
 * Lector de hojas de cálculo.
 *
 * Se lee con ExcelJS y no con una librería de CSV porque el archivo real de una bodega es `.xlsx`
 * con celdas combinadas en el encabezado, formato de moneda y filas en blanco al final. Pedirles
 * que lo conviertan a CSV es pedirles que arreglen el archivo antes de poder usarlo, y ahí se
 * pierde el cliente.
 *
 * Tres decisiones que no son de estilo:
 *
 *  1. **La hoja con más datos gana.** Los libros traen "Hoja1", "Hoja2" y una hoja de notas; elegir
 *     la primera a ciegas importa la hoja vacía y el usuario jura que subió bien el archivo.
 *  2. **Las filas totalmente vacías se descartan.** Un Excel "hasta la fila 1048576" con formato
 *     aplicado llega con un millón de filas vacías; sin esto la vista previa diría "1.048.000 filas".
 *  3. **Se corta en `MAX_IMPORT_ROWS` y se avisa.** Truncar en silencio deja piezas sin cargar que
 *     nadie echa de menos hasta que falta una en el mostrador.
 */
export async function parseImportFile(file: { buffer: Buffer; originalname: string }): Promise<ParsedSheet> {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.csv')) return parseCsv(file.buffer);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException({
      code: 'UNREADABLE_FILE',
      message: 'No se pudo abrir el archivo. Si está abierto en Excel, guárdalo y vuelve a subirlo.',
    });
  }

  const sheets = workbook.worksheets.filter((ws) => ws.rowCount > 1);
  if (!sheets.length) {
    throw new BadRequestException({
      code: 'EMPTY_FILE',
      message: 'El archivo no tiene filas de datos. La primera fila debe ser el encabezado.',
    });
  }
  // La hoja con más filas con contenido, no la primera: ver nota de arriba.
  const sheet = sheets.reduce((best, ws) => (ws.rowCount > best.rowCount ? ws : best), sheets[0]!);

  const matrix: (string | number | null)[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: (string | number | null)[] = [];
    // `row.values` es 1-based y el índice 0 viene vacío.
    const raw = row.values as unknown[];
    for (let i = 1; i < raw.length; i += 1) values.push(cellValue(raw[i]));
    matrix.push(values);
  });

  return buildSheet(matrix, sheet.name);
}

function cellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (value instanceof Date) {
    // Excel convierte "2009" en fecha cuando la columna tiene formato de fecha. Se devuelve el año
    // como texto porque es lo que significa en una columna de años.
    return String(value.getUTCFullYear());
  }
  if (typeof value === 'object') {
    const obj = value as {
      text?: string;
      result?: unknown;
      richText?: { text: string }[];
      hyperlink?: string;
      error?: string;
    };
    // Fórmula sin valor calculado: Excel no guarda el resultado si nunca se abrió el libro.
    if (obj.error) return null;
    if (obj.richText)
      return (
        obj.richText
          .map((r) => r.text)
          .join('')
          .trim() || null
      );
    if (obj.text !== undefined) return obj.text.trim() || null;
    if (obj.result !== undefined && obj.result !== null) return cellValue(obj.result);
    if (obj.hyperlink) return obj.hyperlink;
  }
  return String(value).trim() || null;
}

/**
 * CSV con separador detectado.
 *
 * Guatemala mezcla la coma decimal con el punto: "1,250.00" es mil doscientos cincuenta, pero un
 * archivo exportado de un sistema europeo trae "1.250,00". No se adivina por el contenido de cada
 * celda —eso rompe `toCents` más adelante—: se detecta el separador de columnas contando comas y
 * punto y coma en la primera línea, que es donde el archivo lo declara de hecho.
 */
function parseCsv(buffer: Buffer): ParsedSheet {
  // BOM de Excel: sin quitarlo, el primer encabezado se llama "\uFEFFSKU" y no mapea.
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const delimiter = semicolons > commas ? ';' : ',';

  const matrix = parseDelimited(text, delimiter);
  return buildSheet(matrix, 'CSV');
}

/** Parser RFC 4180 mínimo: comillas dobles, comillas escapadas y saltos de línea dentro de celda. */
function parseDelimited(text: string, delimiter: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = '';
  let quoted = false;

  const pushField = () => {
    const value = field.trim();
    row.push(value === '' ? null : value);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Una fila de puros vacíos es relleno del exportador, no un dato.
    if (row.some((c) => c !== null)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === '\n') {
      pushRow();
    } else if (char === '\r') {
      // Se ignora: el salto lo marca el \n siguiente.
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}

/**
 * Convierte la matriz en encabezados + filas.
 *
 * Los encabezados repetidos se desambiguan con sufijo (`Precio`, `Precio (2)`) en vez de
 * descartarse: un archivo con dos columnas "Precio" —mayorista y público— es común, y perder la
 * segunda en silencio importa el precio equivocado.
 */
function buildSheet(matrix: (string | number | null)[][], sheetName: string): ParsedSheet {
  const headerRow = matrix[0] ?? [];
  const headers: string[] = [];
  const used = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i += 1) {
    const base = String(headerRow[i] ?? '').trim() || `Columna ${i + 1}`;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    headers.push(count === 0 ? base : `${base} (${count + 1})`);
  }

  const body = matrix.slice(1).filter((r) => r.some((c) => c !== null && String(c).trim() !== ''));
  const truncated = body.length > MAX_IMPORT_ROWS;
  const rows = body.slice(0, MAX_IMPORT_ROWS).map((cells) => {
    const record: Record<string, string | number | null> = {};
    for (let i = 0; i < headers.length; i += 1) {
      record[headers[i]!] = cells[i] ?? null;
    }
    return record;
  });

  const { mapping, unmapped } = autoMapColumns(headers);
  return {
    headers,
    rows,
    mapping,
    unmapped,
    rowCount: body.length,
    truncated,
    sheetName,
  };
}
