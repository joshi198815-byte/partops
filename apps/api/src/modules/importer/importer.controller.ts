import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type ColumnMapping, importCommitSchema, importProblem, MAX_IMPORT_BYTES } from '@partops/contracts';
import { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodBody } from '../../common/zod.js';
import { ImporterService } from './importer.service.js';

/**
 * Mapeo que se envía al recalcular la vista previa.
 *
 * Se acepta cualquier clave de `ImportFieldKey` y cualquier encabezado: el servicio comprueba que
 * las columnas existan de verdad en el archivo. Declarar aquí la lista de claves sería una tercera
 * copia de `IMPORT_FIELDS` que se desincroniza en cuanto se agregue un campo.
 */
const previewSchema = z.object({
  mapping: z.record(z.string(), z.string().min(1)),
});

/**
 * Importación de catálogo.
 *
 * Permiso propio (`catalog.import`) y no `catalog.create`: importar 4.000 filas con precios es una
 * operación distinta de capturar una pieza, y un vendedor que puede crear una no debería poder
 * reescribir el catálogo entero subiendo un archivo.
 */
@Controller('catalog/imports')
export class ImporterController {
  constructor(@Inject(ImporterService) private readonly importer: ImporterService) {}

  /** Sube el archivo, propone mapeo y devuelve la vista previa. No escribe piezas. */
  @Post()
  @RequirePermissions('catalog.import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  upload(
    @CurrentCtx() ctx: Ctx,
    @UploadedFile()
    file: { buffer: Buffer; size: number; originalname: string } | undefined,
  ) {
    if (!file) {
      throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Adjunta el archivo de Excel' });
    }
    const problem = importProblem(file);
    if (problem) throw new BadRequestException({ code: 'INVALID_FILE', message: problem });
    return this.importer.upload(ctx, file);
  }

  /** Últimas importaciones del negocio, para retomar o revisar el reporte. */
  @Get()
  @RequirePermissions('catalog.import')
  list(@CurrentCtx() ctx: Ctx) {
    return this.importer.list(ctx);
  }

  @Get(':id')
  @RequirePermissions('catalog.import')
  detail(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.importer.detail(ctx, id);
  }

  /** Recalcula la vista previa con el mapeo que el usuario corrigió. Sigue sin escribir nada. */
  @Post(':id/preview')
  preview(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(previewSchema) body: z.output<typeof previewSchema>,
  ) {
    return this.importer.preview(ctx, id, body.mapping as ColumnMapping);
  }

  /** Confirma: aquí sí se escribe. Idempotente por job: el segundo intento se rechaza. */
  @Post(':id/commit')
  commit(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(importCommitSchema) body: z.output<typeof importCommitSchema>,
  ) {
    return this.importer.commit(ctx, id, body);
  }
}
