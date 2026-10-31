import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  bulkPartsSchema,
  catalogListQuerySchema,
  categoryInputSchema,
  compatibilityIdsSchema,
  compatibilityRangeSchema,
  imageOrderSchema,
  imageUploadProblem,
  MAX_IMAGE_BYTES,
  partCreateSchema,
  partUpdateSchema,
  partVariantInputSchema,
  partVariantUpdateSchema,
  stockAdjustSchema,
} from '@partops/contracts';
import { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodBody, ZodQuery } from '../../common/zod.js';
import { CatalogService } from './catalog.service.js';

/**
 * Varias aplicaciones en una sola llamada: el formulario manda "Corolla 2003-2008" y
 * "Corolla 2009-2013" de una vez, porque separarlas obliga a repetir el selector dos veces.
 */
const compatibilityBulkSchema = z.object({
  ranges: z.array(compatibilityRangeSchema).min(1, 'Agrega al menos una aplicación').max(100),
});

const vehicleQuerySchema = z.object({
  q: z.string().trim().max(60).default(''),
  brand: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Piezas del catálogo.
 *
 * Los permisos se separan a propósito entre leer, crear, editar y archivar: un vendedor necesita
 * `catalog.view` para buscar, y no debe poder cambiar un precio. El costo de una variante se manda
 * como `null` a quien no tiene `catalog.cost.view`, no se oculta en la interfaz — ocultar en el
 * cliente es mandar el dato y confiar en que nadie abra la pestaña de red.
 */
@Controller('catalog/parts')
export class PartsController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermissions('catalog.view')
  list(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(catalogListQuerySchema) query: z.output<typeof catalogListQuerySchema>,
  ) {
    return this.catalog.list(ctx, query);
  }

  @Get('categories')
  @RequirePermissions('catalog.view')
  categories(@CurrentCtx() ctx: Ctx) {
    return this.catalog.categories(ctx);
  }

  @Post('categories')
  @RequirePermissions('catalog.create')
  @HttpCode(201)
  createCategory(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(categoryInputSchema) body: z.output<typeof categoryInputSchema>,
  ) {
    return this.catalog.createCategory(ctx, body.name);
  }

  /**
   * Aplicaciones vehiculares para el selector de compatibilidad.
   *
   * `catalog.view` y no `inventory.view`: se usa al cargar una pieza y al filtrar la búsqueda, y en
   * los dos casos la persona ya está viendo el catálogo.
   */
  @Get('vehicles')
  @RequirePermissions('catalog.view')
  vehicles(@CurrentCtx() ctx: Ctx, @ZodQuery(vehicleQuerySchema) query: z.output<typeof vehicleQuerySchema>) {
    return this.catalog.vehicleOptions(ctx, query);
  }

  /** Bodegas visibles para el usuario, ya acotadas por su asignación. */
  @Get('warehouses')
  @RequirePermissions('catalog.view')
  warehouses(@CurrentCtx() ctx: Ctx) {
    return this.catalog.warehouses(ctx);
  }

  @Get(':id')
  @RequirePermissions('catalog.view')
  detail(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.catalog.detail(ctx, id);
  }

  @Post()
  @RequirePermissions('catalog.create')
  @HttpCode(201)
  create(@CurrentCtx() ctx: Ctx, @ZodBody(partCreateSchema) body: z.output<typeof partCreateSchema>) {
    return this.catalog.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermissions('catalog.update')
  update(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(partUpdateSchema) body: z.output<typeof partUpdateSchema>,
  ) {
    return this.catalog.update(ctx, id, body);
  }

  /**
   * Borra o archiva. Se responde 200 en los dos casos porque para la persona es la misma acción;
   * el cuerpo dice qué pasó de verdad para que la pantalla pueda avisar "se archivó porque ya tenía
   * ventas" en lugar de dejar la fila sin explicación.
   */
  @Delete(':id')
  @RequirePermissions('catalog.archive')
  remove(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.catalog.remove(ctx, id);
  }

  @Post('bulk')
  @RequirePermissions('catalog.update')
  @HttpCode(200)
  bulk(@CurrentCtx() ctx: Ctx, @ZodBody(bulkPartsSchema) body: z.output<typeof bulkPartsSchema>) {
    return this.catalog.bulk(ctx, body);
  }

  // ───────────────────────────── Variantes ─────────────────────────────

  @Post(':id/variants')
  @RequirePermissions('catalog.create')
  @HttpCode(201)
  createVariant(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(partVariantInputSchema) body: z.output<typeof partVariantInputSchema>,
  ) {
    return this.catalog.createVariant(ctx, id, body);
  }

  @Patch(':id/variants/:variantId')
  @RequirePermissions('catalog.update')
  updateVariant(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @ZodBody(partVariantUpdateSchema) body: z.output<typeof partVariantUpdateSchema>,
  ) {
    return this.catalog.updateVariant(ctx, id, variantId, body);
  }

  @Delete(':id/variants/:variantId')
  @RequirePermissions('catalog.update')
  removeVariant(@CurrentCtx() ctx: Ctx, @Param('id') id: string, @Param('variantId') variantId: string) {
    return this.catalog.removeVariant(ctx, id, variantId);
  }

  /**
   * Ajuste de existencia desde la ficha.
   *
   * Exige `inventory.adjust` y no `catalog.update`: cambiar el stock es una operación de inventario
   * con consecuencias contables, y el vendedor que puede corregir un precio no necesariamente debe
   * poder decir que hay cuatro piezas donde hay dos.
   */
  @Post(':id/variants/:variantId/stock')
  @RequirePermissions('inventory.adjust')
  @HttpCode(200)
  adjustStock(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @ZodBody(stockAdjustSchema) body: z.output<typeof stockAdjustSchema>,
  ) {
    return this.catalog.adjustStock(ctx, id, variantId, body);
  }

  // ───────────────────────────── Compatibilidad ─────────────────────────────

  @Post(':id/vehicles')
  @RequirePermissions('catalog.update')
  @HttpCode(201)
  addVehicles(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(compatibilityIdsSchema) body: z.output<typeof compatibilityIdsSchema>,
  ) {
    return this.catalog.addVehicleIds(ctx, id, body.vehicleIds);
  }

  @Post(':id/compatibility')
  @RequirePermissions('catalog.update')
  @HttpCode(201)
  addCompatibility(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(compatibilityBulkSchema) body: z.output<typeof compatibilityBulkSchema>,
  ) {
    return this.catalog.addCompatibility(ctx, id, body.ranges);
  }

  @Delete(':id/compatibility/:compatibilityId')
  @RequirePermissions('catalog.update')
  removeCompatibility(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @Param('compatibilityId') compatibilityId: string,
  ) {
    return this.catalog.removeCompatibility(ctx, id, compatibilityId);
  }

  // ───────────────────────────── Imágenes ─────────────────────────────

  /**
   * Subida de una imagen.
   *
   * `memoryStorage` y límite de 8 MB en el interceptor: el archivo se rechaza antes de tocar el
   * disco, y el límite del contrato (`imageUploadProblem`) vuelve a comprobarlo dentro del servicio
   * por si llega por otra vía. Nunca se escribe el archivo original: sharp lo re-codifica y el EXIF
   * —con las coordenadas de la bodega— desaparece.
   */
  @Post(':id/images')
  @RequirePermissions('catalog.update')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  addImage(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @UploadedFile()
    file: { buffer: Buffer; size: number; mimetype: string; originalname: string } | undefined,
  ) {
    if (!file) {
      throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Adjunta una imagen' });
    }
    const problem = imageUploadProblem(file);
    if (problem) {
      throw new BadRequestException({ code: 'INVALID_IMAGE', message: problem });
    }
    return this.catalog.addImage(ctx, id, file);
  }

  @Delete(':id/images/:imageId')
  @RequirePermissions('catalog.update')
  removeImage(@CurrentCtx() ctx: Ctx, @Param('id') id: string, @Param('imageId') imageId: string) {
    return this.catalog.removeImage(ctx, id, imageId);
  }

  @Put(':id/images/order')
  @RequirePermissions('catalog.update')
  reorderImages(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(imageOrderSchema) body: z.output<typeof imageOrderSchema>,
  ) {
    return this.catalog.reorderImages(ctx, id, body.ids);
  }
}
