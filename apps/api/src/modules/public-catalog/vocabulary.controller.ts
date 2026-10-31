import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/context.js';
import { PublicCatalogService } from './public-catalog.service.js';

/**
 * Tabla de referencia vehicular, abierta.
 *
 * La usa la portada para el demo del parser: sin esto, la web tendría que inventarse un
 * vocabulario y el demo mentiría sobre lo que el producto entiende. Es una tabla **global y
 * curada** (`vehicle_brand` / `vehicle_model`): no tiene `tenantId` y no se expone ni una fila de
 * negocio. Las categorías de pieza quedan fuera a propósito porque sí son de cada negocio.
 *
 * Controller separado de `PublicCatalogController` porque aquel vive en `public/catalog/:slug` y
 * `vocabulary` se leería como un slug.
 */
@Controller('public')
export class VocabularyController {
  constructor(@Inject(PublicCatalogService) private readonly catalog: PublicCatalogService) {}

  @Get('vocabulary')
  @Public()
  async vocabulary(@Res({ passthrough: true }) res: Response) {
    // Una hora en el borde: el parque vehicular cambia cuando alguien cura la tabla, no por minuto.
    res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return this.catalog.referenceVocabulary();
  }
}
