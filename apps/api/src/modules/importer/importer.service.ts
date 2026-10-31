import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildPreview,
  type ColumnMapping,
  type ImportCommitData,
  type ImportJobDetail,
  type ImportJobSummary,
  type ImportMode,
  type ImportPreview,
  type ImportRow,
  type ImportSheet,
  type ImportStatusKey,
  type ImportUploadResponse,
  mappingProblems,
  normalizeOemList,
  normalizePartCode,
  normalizeSku,
  partSlug,
  partSlugCandidate,
  validateImportRow,
} from '@partops/contracts';
import type { TxClient } from '@partops/db';
import { audit } from '../../common/audit.js';
import type { Ctx } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { SearchService } from '../search/search.service.js';
import { parseImportFile } from './sheet.reader.js';

/** Filas por transacción. Suficiente para amortizar el viaje, corto para no bloquear la tabla. */
const CHUNK = 150;

interface StoredSheet {
  headers: string[];
  rows: Record<string, string | number | null>[];
  sheetName: string;
}

interface Counters {
  createdParts: number;
  createdVariants: number;
  updatedVariants: number;
  skippedRows: number;
  errorRows: number;
  successRows: number;
}

/** Resultado de procesar una fila. Nunca lanza: una fila mala no tumba el lote. */
type RowOutcome =
  | { kind: 'created'; newPart: boolean }
  | { kind: 'updated' }
  | { kind: 'skipped' }
  | { kind: 'error'; message: string; field?: string };

/**
 * Importación de catálogo desde Excel.
 *
 * Tres pasos y ninguno se salta:
 *
 *  1. **Subir**: se lee el archivo, se propone el mapeo y se calcula la vista previa. No se escribe
 *     ni una pieza.
 *  2. **Revisar**: con el mapeo corregido se recalcula qué se crea, qué se actualiza y qué se
 *     rechaza, fila por fila.
 *  3. **Confirmar**: se procesa por lotes y cada fila mala queda registrada con su número y su
 *     motivo, para corregir el Excel y volver a subirlo.
 *
 * Una importación de 4.000 filas que crea la mitad y falla en la otra mitad sin decir cuál es peor
 * que no importar: nadie sabe qué falta hasta que falta una pieza en el mostrador.
 */
@Injectable()
export class ImporterService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(SearchService) private readonly search: SearchService,
  ) {}

  // ───────────────────────────── 1. Subir ─────────────────────────────

  async upload(
    ctx: Ctx,
    file: { buffer: Buffer; originalname: string; size: number },
  ): Promise<ImportUploadResponse> {
    const tenantId = ctx.tenant.tenantId;
    const sheet = await parseImportFile(file);
    const preview = buildPreview(sheet.rows, sheet.mapping, sheet.unmapped);
    const stored: StoredSheet = {
      headers: sheet.headers,
      rows: sheet.rows,
      sheetName: sheet.sheetName,
    };

    const job = await this.db.tx(tenantId, (tx) =>
      tx.importJob.create({
        data: {
          tenantId,
          fileName: file.originalname.slice(0, 200),
          status: 'PENDIENTE',
          mapping: sheet.mapping as never,
          payload: { mode: 'CREAR', sheet: stored } as never,
          totalRows: sheet.rows.length,
          createdById: ctx.user.id,
        },
        select: summarySelect,
      }),
    );

    return {
      job: toSummary(job),
      // La web solo pinta las primeras filas para confirmar "sí, es mi archivo"; el contenido
      // completo ya está guardado en el job y no tiene por qué viajar dos veces.
      sheet: { ...sheet, rows: sheet.rows.slice(0, 50) } satisfies ImportSheet,
      preview,
    };
  }

  // ───────────────────────────── 2. Vista previa ─────────────────────────────

  async preview(ctx: Ctx, jobId: string, mapping: ColumnMapping): Promise<ImportPreview> {
    const job = await this.load(ctx, jobId);
    const sheet = storedSheet(job.payload);
    assertMapping(mapping, sheet.headers);
    return buildPreview(sheet.rows, mapping, unmappedFor(sheet.headers, mapping));
  }

  // ───────────────────────────── 3. Confirmar ─────────────────────────────

  async commit(ctx: Ctx, jobId: string, input: ImportCommitData): Promise<ImportJobDetail> {
    const tenantId = ctx.tenant.tenantId;
    const job = await this.load(ctx, jobId);

    if (job.status === 'PROCESANDO') {
      throw new BadRequestException({
        code: 'IMPORT_RUNNING',
        message: 'Esta importación ya se está procesando',
      });
    }
    if (job.status === 'COMPLETADA' || job.status === 'PARCIAL') {
      throw new BadRequestException({
        code: 'IMPORT_FINISHED',
        message: 'Esta importación ya se confirmó. Sube el archivo de nuevo para repetirla.',
      });
    }

    const mapping = input.mapping as ColumnMapping;
    const sheet = storedSheet(job.payload);
    assertMapping(mapping, sheet.headers);
    const warehouses = await this.warehouses(ctx);

    // Se marca en curso ANTES de procesar: si el proceso muere, la pantalla dice "importando" en
    // vez de dejar el archivo como pendiente para siempre.
    await this.db.tx(tenantId, (tx) =>
      tx.importJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESANDO',
          mode: input.mode,
          mapping: mapping as never,
          warehouseId: input.warehouseId ?? null,
          payload: { mode: input.mode, sheet } as never,
          processedRows: 0,
          successRows: 0,
          errorRows: 0,
          createdParts: 0,
          createdVariants: 0,
          updatedVariants: 0,
          skippedRows: 0,
        },
      }),
    );

    const counters: Counters = {
      createdParts: 0,
      createdVariants: 0,
      updatedVariants: 0,
      skippedRows: 0,
      errorRows: 0,
      successRows: 0,
    };

    try {
      await this.run(ctx, jobId, job.fileName, sheet, mapping, input, warehouses, counters);
    } catch (err) {
      /**
       * Lo ya importado se conserva —cada lote fue su propia transacción— y se informa. Un job
       * trabado en "PROCESANDO" no se puede reintentar y no dice qué pasó.
       */
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .tx(tenantId, (tx) =>
          tx.importJob.update({
            where: { id: jobId },
            data: { status: 'FALLIDA', error: message.slice(0, 500), finishedAt: new Date() },
          }),
        )
        .catch(() => undefined);
      this.search.invalidate(tenantId);
      throw err;
    }

    const status: ImportStatusKey =
      counters.errorRows === 0 ? 'COMPLETADA' : counters.successRows > 0 ? 'PARCIAL' : 'FALLIDA';

    await this.db.tx(tenantId, async (tx) => {
      await tx.importJob.update({
        where: { id: jobId },
        data: {
          status,
          processedRows: sheet.rows.length,
          successRows: counters.successRows,
          errorRows: counters.errorRows,
          createdParts: counters.createdParts,
          createdVariants: counters.createdVariants,
          updatedVariants: counters.updatedVariants,
          skippedRows: counters.skippedRows,
          finishedAt: new Date(),
        },
      });
      await audit(tx, {
        tenantId,
        userId: ctx.user.id,
        action: 'catalog.imported',
        entity: 'import_job',
        entityId: jobId,
        after: { ...counters, mode: input.mode, file: job.fileName },
        ip: ctx.ip,
      });
    });

    this.search.invalidate(tenantId);
    return this.detail(ctx, jobId);
  }

  /** Procesa por lotes y actualiza el avance después de cada uno. */
  private async run(
    ctx: Ctx,
    jobId: string,
    fileName: string,
    sheet: StoredSheet,
    mapping: ColumnMapping,
    input: ImportCommitData,
    warehouses: WarehouseLookup,
    counters: Counters,
  ): Promise<void> {
    const tenantId = ctx.tenant.tenantId;
    const dryRun = buildPreview(sheet.rows, mapping, []);
    /** Filas que la vista previa ya rechazó (incluidas las duplicadas dentro del archivo). */
    const rejected = new Map(dryRun.errors.map((e) => [e.rowNumber, e.errors]));

    /** Nombre+marca → partId, para que 40 filas del mismo capó sean una pieza con 40 variantes. */
    const partByKey = new Map<string, string>();
    const slugsTaken = new Set<string>();

    for (let offset = 0; offset < sheet.rows.length; offset += CHUNK) {
      const chunk = sheet.rows.slice(offset, offset + CHUNK);
      const rows = chunk.map((raw, i) => ({ rowNumber: offset + i + 2, raw }));

      await this.db.tx(
        tenantId,
        async (tx) => {
          const errors: { rowNumber: number; field: string | null; message: string; raw: unknown }[] = [];

          for (const { rowNumber, raw } of rows) {
            const known = rejected.get(rowNumber);
            if (known) {
              counters.errorRows += 1;
              for (const e of known) {
                errors.push({ rowNumber, field: e.field, message: e.message, raw });
              }
              continue;
            }

            const mapped = applyMappingTo(raw, mapping);
            const validation = validateImportRow(mapped, rowNumber);
            if (!validation.ok || !validation.data) {
              counters.errorRows += 1;
              for (const e of validation.errors) {
                errors.push({ rowNumber, field: e.field, message: e.message, raw });
              }
              continue;
            }

            const outcome = await this.processRow(tx, ctx, {
              jobId,
              fileName,
              row: validation.data,
              rowNumber,
              mode: input.mode,
              defaultWarehouseId: input.warehouseId ?? null,
              warehouses,
              partByKey,
              slugsTaken,
            });

            switch (outcome.kind) {
              case 'created':
                counters.createdVariants += 1;
                if (outcome.newPart) {
                  counters.createdParts += 1;
                  slugsTaken.add(partSlug(validation.data.name));
                }
                counters.successRows += 1;
                break;
              case 'updated':
                counters.updatedVariants += 1;
                counters.successRows += 1;
                break;
              case 'skipped':
                counters.skippedRows += 1;
                break;
              case 'error':
                counters.errorRows += 1;
                errors.push({
                  rowNumber,
                  field: outcome.field ?? null,
                  message: outcome.message,
                  raw,
                });
                break;
            }
          }

          if (errors.length) {
            await tx.importRowError.createMany({
              data: errors.map((e) => ({
                tenantId,
                jobId,
                rowNumber: e.rowNumber,
                field: e.field,
                message: e.message.slice(0, 500),
                raw: e.raw as never,
              })),
            });
          }

          await tx.importJob.update({
            where: { id: jobId },
            data: {
              processedRows: Math.min(offset + chunk.length, sheet.rows.length),
              successRows: counters.successRows,
              errorRows: counters.errorRows,
              skippedRows: counters.skippedRows,
              createdParts: counters.createdParts,
              createdVariants: counters.createdVariants,
              updatedVariants: counters.updatedVariants,
            },
          });
        },
        { timeout: 60_000 },
      );
    }
  }

  /**
   * Una fila: crea o actualiza la variante, sus aplicaciones y su existencia inicial.
   *
   * Devuelve el resultado en vez de lanzar: una fila mala no puede tumbar el lote, y esa es la
   * promesa de la importación.
   */
  private async processRow(
    tx: TxClient,
    ctx: Ctx,
    args: {
      jobId: string;
      fileName: string;
      row: ImportRow;
      rowNumber: number;
      mode: ImportMode;
      defaultWarehouseId: string | null;
      warehouses: WarehouseLookup;
      partByKey: Map<string, string>;
      slugsTaken: Set<string>;
    },
  ): Promise<RowOutcome> {
    const tenantId = ctx.tenant.tenantId;
    const { row, mode } = args;
    const sku = normalizeSku(row.sku ?? '');
    if (!sku) return { kind: 'error', message: 'Falta el SKU', field: 'sku' };

    const existing = await tx.partVariant.findUnique({
      where: { tenantId_sku: { tenantId, sku } },
      select: { id: true, partId: true, barcode: true, oemNumbers: true },
    });

    if (existing) {
      if (mode === 'CREAR') {
        return {
          kind: 'error',
          message: `El SKU ${sku} ya existe en el catálogo. Elige "Actualizar existentes" si quieres sobrescribir sus datos.`,
          field: 'sku',
        };
      }
      if (mode === 'OMITIR_EXISTENTES') return { kind: 'skipped' };

      const problem = await this.updateVariant(tx, ctx, existing.id, existing, row);
      return problem ? { kind: 'error', ...problem } : { kind: 'updated' };
    }

    // ── Variante nueva ──
    const warehouseId = resolveWarehouse(row.warehouseCode, args.defaultWarehouseId, args.warehouses);
    if (!warehouseId) {
      return {
        kind: 'error',
        field: 'warehouse',
        message: row.warehouseCode
          ? `La bodega "${row.warehouseCode}" no existe en este negocio`
          : 'Elige una bodega por defecto o mapea la columna de bodega',
      };
    }

    if (row.barcode) {
      const clash = await tx.partVariant.findFirst({
        where: { tenantId, barcode: row.barcode },
        select: { sku: true },
      });
      if (clash) {
        return {
          kind: 'error',
          field: 'barcode',
          message: `El código de barras ${row.barcode} ya está en ${clash.sku}`,
        };
      }
    }

    const part = await this.resolvePart(tx, tenantId, row, args);

    /**
     * La existencia inicial entra por el ledger. Escribir `onHand` directo dejaría un saldo sin
     * origen: el primer inventario físico no cuadraría con nada y no habría forma de auditar de
     * dónde salieron esas 400 unidades.
     */
    const variant = await tx.partVariant.create({
      data: {
        tenantId,
        partId: part.id,
        sku,
        title: row.name,
        partNumber: row.partNumber?.trim() || null,
        oemNumbers: normalizeOemList(row.oemNumbers),
        barcode: row.barcode?.trim() || null,
        priceCents: row.priceCents,
        costCents: row.costCents ?? 0,
      },
      select: { id: true },
    });

    await this.applyStock(tx, ctx, {
      jobId: args.jobId,
      fileName: args.fileName,
      variantId: variant.id,
      warehouseId,
      quantity: row.stock,
      rowNumber: args.rowNumber,
      binLocation: row.binLocation,
    });

    const linked = await this.linkVehicles(tx, tenantId, part.id, row);
    if (!linked.ok) return { kind: 'error', message: linked.message, field: 'vehicleYears' };

    return { kind: 'created', newPart: part.created };
  }

  /**
   * Actualizar un SKU existente.
   *
   * La existencia NO se sobrescribe: el Excel dice lo que la bodega cree que tiene, no lo que el
   * sistema registró con sus ventas. Reemplazarla borraría las ventas del día sin dejar rastro; si
   * hace falta corregir, se registra un ajuste, que sí tiene motivo y auditoría.
   */
  private async updateVariant(
    tx: TxClient,
    ctx: Ctx,
    variantId: string,
    current: { partId: string; barcode: string | null; oemNumbers: string[] },
    row: ImportRow,
  ): Promise<{ message: string; field?: string } | null> {
    const tenantId = ctx.tenant.tenantId;

    if (row.barcode && row.barcode !== current.barcode) {
      const clash = await tx.partVariant.findFirst({
        where: { tenantId, barcode: row.barcode, id: { not: variantId } },
        select: { sku: true },
      });
      if (clash) {
        return { message: `El código de barras ${row.barcode} ya está en ${clash.sku}`, field: 'barcode' };
      }
    }

    /**
     * Los OEM del archivo se SUMAN a los que ya había: la bodega carga el catálogo por tandas y la
     * segunda no repite los códigos de la primera. Reemplazarlos perdería justo la información que
     * hace que la búsqueda encuentre la pieza.
     */
    const oem = dedupeCodes([...current.oemNumbers, ...normalizeOemList(row.oemNumbers)]);

    await tx.partVariant.update({
      where: { id: variantId },
      data: {
        priceCents: row.priceCents,
        ...(row.costCents !== null && row.costCents !== undefined ? { costCents: row.costCents } : {}),
        ...(row.partNumber ? { partNumber: row.partNumber.trim() } : {}),
        oemNumbers: oem,
        ...(row.barcode ? { barcode: row.barcode.trim() } : {}),
      },
    });

    await tx.part.update({
      where: { id: current.partId },
      data: {
        name: row.name.trim(),
        brand: row.brand?.trim() || null,
        ...(row.condition ? { condition: row.condition as never } : {}),
        ...(row.unit ? { unit: row.unit.trim() } : {}),
        ...(row.warrantyDays !== null && row.warrantyDays !== undefined
          ? { warrantyDays: row.warrantyDays }
          : {}),
        ...(row.category ? { categoryId: await this.resolveCategory(tx, tenantId, row.category) } : {}),
      },
    });

    const linked = await this.linkVehicles(tx, tenantId, current.partId, row);
    if (!linked.ok) return { message: linked.message, field: 'vehicleYears' };
    return null;
  }

  // ───────────────────────────── Piezas y aplicaciones ─────────────────────────────

  private partKey(row: ImportRow): string {
    return `${row.name.trim().toLowerCase()}|${(row.brand ?? '').trim().toLowerCase()}`;
  }

  /**
   * Pieza a la que pertenece la variante.
   *
   * Se busca por nombre + marca sin acentos porque el Excel de una segunda sucursal trae las mismas
   * piezas con otros SKU; crear una pieza nueva por cada una duplicaría el catálogo entero y el
   * vendedor vería "Capó Corolla" tres veces.
   */
  private async resolvePart(
    tx: TxClient,
    tenantId: string,
    row: ImportRow,
    args: { partByKey: Map<string, string>; slugsTaken: Set<string> },
  ): Promise<{ id: string; created: boolean }> {
    const key = this.partKey(row);
    const cached = args.partByKey.get(key);
    if (cached) return { id: cached, created: false };

    const found = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT p."id"
      FROM "part" p
      WHERE p."tenantId" = ${tenantId}
        AND public.unaccent(lower(p."name")) = public.unaccent(lower(${row.name.trim()}))
        AND coalesce(public.unaccent(lower(p."brand")), '') =
            coalesce(public.unaccent(lower(${(row.brand ?? '').trim()})), '')
      ORDER BY p."createdAt" ASC
      LIMIT 1`;
    if (found[0]) {
      args.partByKey.set(key, found[0].id);
      return { id: found[0].id, created: false };
    }

    const categoryId = row.category ? await this.resolveCategory(tx, tenantId, row.category) : null;
    const slug = await this.freeSlug(tx, tenantId, partSlug(row.name), args.slugsTaken);
    const part = await tx.part.create({
      data: {
        tenantId,
        name: row.name.trim(),
        slug,
        brand: row.brand?.trim() || null,
        categoryId,
        condition: (row.condition ?? 'NUEVO') as never,
        unit: row.unit?.trim() || 'UNIDAD',
        warrantyDays: row.warrantyDays ?? null,
      },
      select: { id: true },
    });
    args.partByKey.set(key, part.id);
    return { id: part.id, created: true };
  }

  private async resolveCategory(tx: TxClient, tenantId: string, name: string): Promise<string> {
    const slug = slugifyName(name);
    const row = await tx.partCategory.upsert({
      where: { tenantId_slug: { tenantId, slug } },
      update: {},
      create: { tenantId, name: name.trim(), slug },
      select: { id: true },
    });
    return row.id;
  }

  private async freeSlug(tx: TxClient, tenantId: string, base: string, taken: Set<string>): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const slug = partSlugCandidate(base, attempt);
      if (taken.has(slug)) continue;
      const exists = await tx.part.findUnique({
        where: { tenantId_slug: { tenantId, slug } },
        select: { id: true },
      });
      if (!exists) return slug;
    }
    // Un nombre repetido 50 veces no es un caso real; un sufijo temporal evita el bucle sin lanzar
    // un error que el usuario no podría resolver desde el Excel.
    return `${partSlugCandidate(base, 49)}-${Date.now().toString(36)}`;
  }

  private async linkVehicles(
    tx: TxClient,
    tenantId: string,
    partId: string,
    row: ImportRow,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    for (const vehicle of row.vehicles) {
      const brand = vehicle.brand?.trim();
      const model = vehicle.model?.trim();
      if (!brand || !model) return { ok: false, message: 'La aplicación necesita marca y modelo' };

      const brandRow = await tx.vehicleBrand.upsert({
        where: { name: brand },
        update: {},
        create: { name: brand },
        select: { id: true },
      });
      const modelRow = await tx.vehicleModel.upsert({
        where: { brandId_name: { brandId: brandRow.id, name: model } },
        update: {},
        create: { brandId: brandRow.id, name: model },
        select: { id: true },
      });
      const engine = vehicle.engine?.trim() || null;

      for (const range of vehicle.years) {
        // `findFirst` y no `upsert`: la clave incluye `engine`, que puede ser NULL, y en Postgres
        // dos NULL no son iguales. Un upsert por esa clave duplicaría el vehículo cada vez.
        const existing = await tx.vehicle.findFirst({
          where: { modelId: modelRow.id, yearStart: range.start, yearEnd: range.end, engine },
          select: { id: true },
        });
        const vehicleId =
          existing?.id ??
          (
            await tx.vehicle.create({
              data: { modelId: modelRow.id, yearStart: range.start, yearEnd: range.end, engine },
              select: { id: true },
            })
          ).id;

        await tx.$executeRaw`
          INSERT INTO "part_compatibility" ("id", "tenantId", "partId", "vehicleId")
          VALUES (gen_random_uuid()::text, ${tenantId}, ${partId}, ${vehicleId})
          ON CONFLICT ("partId", "vehicleId") DO NOTHING`;
      }
    }
    return { ok: true };
  }

  private async applyStock(
    tx: TxClient,
    ctx: Ctx,
    args: {
      jobId: string;
      fileName: string;
      variantId: string;
      warehouseId: string;
      quantity: number;
      rowNumber: number;
      binLocation?: string | null;
    },
  ): Promise<void> {
    if (args.quantity > 0) {
      await this.inventory.apply(tx, {
        tenantId: ctx.tenant.tenantId,
        variantId: args.variantId,
        warehouseId: args.warehouseId,
        onHandDelta: args.quantity,
        // `IMPORTACION` y no `AJUSTE`: el ledger tiene que distinguir lo que entró por archivo de
        // lo que alguien corrigió a mano; son preguntas distintas cuando algo no cuadra.
        type: 'IMPORTACION',
        reason: `Importación desde Excel: ${args.fileName} (fila ${args.rowNumber})`,
        refType: 'import_job',
        refId: args.jobId,
        userId: ctx.user.id,
      });
    }
    if (args.binLocation?.trim()) {
      await tx.inventoryLevel.updateMany({
        where: { variantId: args.variantId, warehouseId: args.warehouseId },
        data: { binLocation: args.binLocation.trim().slice(0, 40) },
      });
    }
  }

  // ───────────────────────────── Bodegas y consultas ─────────────────────────────

  private async warehouses(ctx: Ctx): Promise<WarehouseLookup> {
    const allowed = ctx.tenant.warehouseIds;
    const rows = await this.db.tx(
      ctx.tenant.tenantId,
      (tx) =>
        tx.$queryRaw<Array<{ id: string; code: string; name: string; isDefault: boolean }>>`
        SELECT w."id", w."code", w."name", w."isDefault"
        FROM "warehouse" w
        WHERE w."tenantId" = ${ctx.tenant.tenantId} AND w."isActive"
          AND (${allowed.length === 0}::boolean OR w."id" = ANY(${allowed}::text[]))
        ORDER BY w."isDefault" DESC, w."name" ASC`,
    );
    const byCode = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const row of rows) {
      byCode.set(row.code.trim().toUpperCase(), row.id);
      byName.set(row.name.trim().toLowerCase(), row.id);
    }
    return { rows, byCode, byName, defaultId: rows[0]?.id ?? null };
  }

  async list(ctx: Ctx): Promise<ImportJobSummary[]> {
    const jobs = await this.db.tx(ctx.tenant.tenantId, (tx) =>
      tx.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: summarySelect }),
    );
    return jobs.map((job) => toSummary(job));
  }

  async detail(ctx: Ctx, jobId: string): Promise<ImportJobDetail> {
    const job = await this.load(ctx, jobId);
    const errors = await this.db.tx(ctx.tenant.tenantId, (tx) =>
      tx.importRowError.findMany({
        where: { jobId },
        orderBy: [{ rowNumber: 'asc' }, { field: 'asc' }],
        take: 500,
        select: { rowNumber: true, field: true, message: true },
      }),
    );
    return { ...toSummary(job), rowErrors: errors };
  }

  private async load(ctx: Ctx, jobId: string) {
    const job = await this.db.tx(ctx.tenant.tenantId, (tx) =>
      tx.importJob.findFirst({ where: { id: jobId } }),
    );
    if (!job) {
      throw new NotFoundException({ code: 'IMPORT_NOT_FOUND', message: 'Esa importación no existe' });
    }
    return job;
  }
}

// ───────────────────────────── Auxiliares ─────────────────────────────

const summarySelect = {
  id: true,
  fileName: true,
  status: true,
  mode: true,
  totalRows: true,
  processedRows: true,
  successRows: true,
  errorRows: true,
  createdParts: true,
  createdVariants: true,
  updatedVariants: true,
  skippedRows: true,
  createdAt: true,
  finishedAt: true,
  error: true,
} as const;

interface WarehouseLookup {
  rows: { id: string; code: string; name: string; isDefault: boolean }[];
  byCode: Map<string, string>;
  byName: Map<string, string>;
  defaultId: string | null;
}

type JobRow = {
  id: string;
  fileName: string;
  status: string;
  mode: ImportMode;
  totalRows: number;
  processedRows: number;
  successRows: number;
  errorRows: number;
  createdParts: number;
  createdVariants: number;
  updatedVariants: number;
  skippedRows: number;
  createdAt: Date;
  finishedAt: Date | null;
  error: string | null;
};

function toSummary(job: JobRow): ImportJobSummary {
  return {
    id: job.id,
    fileName: job.fileName,
    status: job.status as ImportStatusKey,
    mode: job.mode,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    successRows: job.successRows,
    errorRows: job.errorRows,
    createdParts: job.createdParts,
    createdVariants: job.createdVariants,
    updatedVariants: job.updatedVariants,
    skippedRows: job.skippedRows,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdBy: null,
    error: job.error,
  };
}

function storedSheet(payload: unknown): StoredSheet {
  const sheet = (payload as { sheet?: StoredSheet } | null)?.sheet;
  if (!sheet || !Array.isArray(sheet.rows) || !Array.isArray(sheet.headers)) {
    throw new BadRequestException({
      code: 'IMPORT_PAYLOAD_MISSING',
      message: 'Este archivo ya no está disponible. Súbelo otra vez.',
    });
  }
  return sheet;
}

/** Comprueba el mapeo dos veces: lo obligatorio está mapeado y las columnas existen en el archivo. */
function assertMapping(mapping: ColumnMapping, headers: string[]) {
  const problems = mappingProblems(mapping);
  if (problems.length) {
    throw new BadRequestException({
      code: 'MAPPING_INCOMPLETE',
      message: problems[0],
      issues: problems,
    });
  }
  const known = new Set(headers);
  for (const [field, header] of Object.entries(mapping)) {
    if (header && !known.has(header)) {
      throw new BadRequestException({
        code: 'UNKNOWN_COLUMN',
        message: `La columna "${header}" no está en el archivo`,
        field,
      });
    }
  }
}

function applyMappingTo(
  raw: Record<string, string | number | null>,
  mapping: ColumnMapping,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [field, header] of Object.entries(mapping)) {
    if (header) out[field] = raw[header] ?? null;
  }
  return out;
}

function unmappedFor(headers: string[], mapping: ColumnMapping): string[] {
  const used = new Set(Object.values(mapping).filter(Boolean) as string[]);
  return headers.filter((h) => !used.has(h));
}

function resolveWarehouse(
  code: string | null | undefined,
  fallbackId: string | null,
  warehouses: WarehouseLookup,
): string | null {
  const raw = code?.trim();
  if (raw) {
    // Si el archivo nombra una bodega que no existe NO se cae a la de por defecto: cargar 400
    // unidades en la central porque "SUCURSAL-X" estaba mal escrito descuadra las dos bodegas.
    return warehouses.byCode.get(raw.toUpperCase()) ?? warehouses.byName.get(raw.toLowerCase()) ?? null;
  }
  return fallbackId ?? warehouses.defaultId;
}

function dedupeCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes) {
    const key = normalizePartCode(code);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(code);
  }
  return out.slice(0, 20);
}

/** `Suspensión` → `suspension`. Igual que en catálogo, para que no existan dos slugs del mismo nombre. */
function slugifyName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
