import { Injectable } from '@nestjs/common';
import { type FinanceOverview, fromCents, paymentMethodLabel } from '@partops/contracts';
import ExcelJS from 'exceljs';

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

/**
 * Exportación del reporte.
 *
 * El archivo sale de la MISMA estructura que pinta la pantalla (`FinanceOverview`), no de una
 * consulta aparte. Es la única forma de que "utilidad = ventas − costo − gastos" se cumpla también
 * en el archivo que el dueño le manda a su contador: dos consultas paralelas se desincronizan el
 * día que alguien toca una y no la otra, y entonces nadie sabe cuál de los dos números es el real.
 *
 * Dos formatos por una razón concreta:
 *
 *  - **CSV** abre en cualquier cosa, se pega en un correo y no depende de Excel instalado. Va con
 *    BOM porque sin él Excel en Windows lee `Q 1,250.00` como dos columnas y el acento de "Utilidad
 *    neta" sale como `?`. Los importes van como número, no como texto formateado, para que el
 *    contador pueda sumar la columna.
 *  - **XLSX** conserva una hoja por desglose. El contador no quiere diez archivos separados, y una
 *    sola hoja con seis tablas pegadas es imposible de ordenar.
 */
@Injectable()
export class FinanceExportService {
  async build(data: FinanceOverview, format: 'csv' | 'xlsx'): Promise<ExportFile> {
    const stem = `finanzas-${data.period.from}_${data.period.to}`;
    if (format === 'csv') {
      return {
        filename: `${stem}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: Buffer.from(this.csv(data), 'utf8'),
      };
    }

    const workbook = this.workbook(data);
    const body = await workbook.xlsx.writeBuffer();
    return {
      filename: `${stem}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: Buffer.from(body as ArrayBuffer),
    };
  }

  // ───────────────────────────── CSV ─────────────────────────────

  /**
   * Un solo archivo con secciones.
   *
   * Se separa con una línea en blanco y un título por bloque, no con seis archivos: el contador
   * pide "el mes" y recibe un archivo. Los importes van sin símbolo para que Excel los trate como
   * números; el símbolo en la cabecera ya dice la moneda.
   */
  private csv(data: FinanceOverview): string {
    const rows: (string | number | null)[][] = [];
    const money = (cents: number | null) => (cents === null ? null : fromCents(cents));

    rows.push(['Finanzas', `${data.period.from} a ${data.period.to}`, data.currency]);
    rows.push([]);
    rows.push(['Resumen']);
    rows.push(['Concepto', `Monto (${data.currency})`]);
    rows.push(['Ventas', money(data.totals.salesCents)]);
    rows.push(['IVA incluido', money(data.totals.taxCents)]);
    rows.push(['Costo de lo vendido', money(data.totals.cogsCents)]);
    rows.push(['Utilidad bruta', money(data.totals.grossProfitCents)]);
    rows.push(['Gastos', money(data.totals.expensesCents)]);
    rows.push(['Utilidad neta', money(data.totals.netProfitCents)]);
    rows.push(['Pedidos entregados', data.totals.ordersCount]);
    rows.push(['Piezas vendidas', data.totals.itemsCount]);
    rows.push(['Ticket promedio', money(data.totals.ticketAvgCents)]);

    rows.push([]);
    rows.push(['Día a día']);
    rows.push(['Fecha', 'Ventas', 'Costo', 'Gastos', 'Utilidad', 'Pedidos', 'Piezas']);
    for (const day of data.days) {
      rows.push([
        day.day,
        money(day.salesCents),
        money(day.cogsCents),
        money(day.expensesCents),
        money(day.netProfitCents),
        day.ordersCount,
        day.itemsCount,
      ]);
    }

    rows.push([]);
    rows.push(['Por vendedor']);
    rows.push(['Vendedor', 'Ventas', 'Costo', 'Utilidad', 'Pedidos', 'Piezas']);
    for (const row of data.bySeller) {
      rows.push([
        row.label,
        money(row.salesCents),
        money(row.cogsCents),
        money(row.profitCents),
        row.ordersCount,
        row.itemsCount,
      ]);
    }

    rows.push([]);
    rows.push(['Por bodega']);
    rows.push(['Bodega', 'Ventas', 'Costo', 'Utilidad', 'Pedidos', 'Piezas']);
    for (const row of data.byWarehouse) {
      rows.push([
        row.label,
        money(row.salesCents),
        money(row.cogsCents),
        money(row.profitCents),
        row.ordersCount,
        row.itemsCount,
      ]);
    }

    rows.push([]);
    rows.push(['Cobros por forma de pago']);
    rows.push(['Forma de pago', 'Cobrado', 'Movimientos']);
    for (const row of data.byPaymentMethod) {
      rows.push([paymentMethodLabel(row.method), money(row.amountCents), row.count]);
    }

    rows.push([]);
    rows.push(['Gastos del periodo']);
    rows.push(['Fecha', 'Gasto', 'Categoría', 'Monto', 'Nota']);
    for (const row of data.expenses) {
      rows.push([row.paidAt, row.title, row.categoryName ?? '', money(row.amountCents), row.notes ?? '']);
    }

    const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    // BOM: sin él Excel en Windows rompe los acentos y separa los importes por la coma decimal.
    return `\uFEFF${body}\r\n`;
  }

  // ───────────────────────────── XLSX ─────────────────────────────

  private workbook(data: FinanceOverview): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'PartOps';
    wb.created = new Date();

    const money = (cents: number | null) => (cents === null ? null : fromCents(cents));

    // Resumen: es la hoja que se imprime y la que se mira primero.
    const summary = wb.addWorksheet('Resumen', { views: [{ state: 'frozen', ySplit: 3 }] });
    summary.addRow(['Finanzas', `${data.period.from} a ${data.period.to}`, data.currency]);
    summary.addRow([]);
    summary.addRow(['Concepto', `Monto (${data.currency})`]);
    const summaryRows: [string, number | null][] = [
      ['Ventas', money(data.totals.salesCents)],
      ['IVA incluido', money(data.totals.taxCents)],
      ['Costo de lo vendido', money(data.totals.cogsCents)],
      ['Utilidad bruta', money(data.totals.grossProfitCents)],
      ['Gastos', money(data.totals.expensesCents)],
      ['Utilidad neta', money(data.totals.netProfitCents)],
    ];
    for (const [label, value] of summaryRows) {
      const row = summary.addRow([label, value]);
      row.getCell(2).numFmt = '"Q" #,##0.00';
    }
    // La utilidad neta en negrita: es el número por el que se abre la hoja.
    summary.getRow(summary.rowCount).font = { bold: true };
    summary.getColumn(1).width = 26;
    summary.getColumn(2).width = 18;
    summary.getCell('A3').font = { bold: true };
    summary.getCell('B3').font = { bold: true };

    const daily = wb.addWorksheet('Día a día', { views: [{ state: 'frozen', ySplit: 1 }] });
    daily.addRow(['Fecha', 'Ventas', 'Costo', 'Gastos', 'Utilidad', 'Pedidos', 'Piezas']);
    for (const day of data.days) {
      daily.addRow([
        day.day,
        money(day.salesCents),
        money(day.cogsCents),
        money(day.expensesCents),
        money(day.netProfitCents),
        day.ordersCount,
        day.itemsCount,
      ]);
    }
    styleTable(daily, [12, 14, 14, 14, 14, 10, 10]);

    const sellers = wb.addWorksheet('Vendedores', { views: [{ state: 'frozen', ySplit: 1 }] });
    sellers.addRow(['Vendedor', 'Ventas', 'Costo', 'Utilidad', 'Pedidos', 'Piezas']);
    for (const row of data.bySeller) {
      sellers.addRow([
        row.label,
        money(row.salesCents),
        money(row.cogsCents),
        money(row.profitCents),
        row.ordersCount,
        row.itemsCount,
      ]);
    }
    styleTable(sellers, [28, 14, 14, 14, 10, 10]);

    const warehouses = wb.addWorksheet('Bodegas', { views: [{ state: 'frozen', ySplit: 1 }] });
    warehouses.addRow(['Bodega', 'Ventas', 'Costo', 'Utilidad', 'Pedidos', 'Piezas']);
    for (const row of data.byWarehouse) {
      warehouses.addRow([
        row.label,
        money(row.salesCents),
        money(row.cogsCents),
        money(row.profitCents),
        row.ordersCount,
        row.itemsCount,
      ]);
    }
    styleTable(warehouses, [28, 14, 14, 14, 10, 10]);

    const payments = wb.addWorksheet('Cobros', { views: [{ state: 'frozen', ySplit: 1 }] });
    payments.addRow(['Forma de pago', 'Cobrado', 'Movimientos']);
    for (const row of data.byPaymentMethod) {
      payments.addRow([paymentMethodLabel(row.method), money(row.amountCents), row.count]);
    }
    styleTable(payments, [22, 16, 14]);

    const expenses = wb.addWorksheet('Gastos', { views: [{ state: 'frozen', ySplit: 1 }] });
    expenses.addRow(['Fecha', 'Gasto', 'Categoría', 'Monto', 'Nota', 'Capturó']);
    for (const row of data.expenses) {
      expenses.addRow([
        row.paidAt,
        row.title,
        row.categoryName ?? '',
        money(row.amountCents),
        row.notes ?? '',
        row.createdByName ?? '',
      ]);
    }
    styleTable(expenses, [12, 32, 18, 14, 40, 22]);

    return wb;
  }
}

/** Encabezado en negrita con fondo, importes con formato y columnas de ancho fijo. */
function styleTable(sheet: ExcelJS.Worksheet, widths: number[]): void {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF1F4' } };
  widths.forEach((width, i) => {
    sheet.getColumn(i + 1).width = width;
  });
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    // Columnas 2–5 son importes en todas las hojas de desglose.
    for (let col = 2; col <= 5; col += 1) {
      const cell = row.getCell(col);
      if (typeof cell.value === 'number') cell.numFmt = '"Q" #,##0.00';
    }
  });
}

/** Celda de CSV: comillas solo cuando hacen falta y comillas internas duplicadas. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
