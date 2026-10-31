import { Controller, Get, Inject } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { SEARCH_LIMIT, WINDOW_MS } from '../../common/throttle.js';
import { ZodQuery } from '../../common/zod.js';
import { SearchService } from './search.service.js';

/**
 * `q` puede venir vacío: el mostrador abre la búsqueda y navega por facetas sin escribir nada.
 * `limit` se acota en el servicio; aquí solo se coacciona para no recibir NaN.
 */
const searchQuery = z.object({
  q: z.string().trim().max(200).default(''),
  brand: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  /** MOSTRADOR, MOVIL o CATALOGO: de dónde vino, para separar demanda de vitrina y de bodega. */
  source: z.enum(['MOSTRADOR', 'MOVIL', 'CATALOGO']).optional(),
});

@Controller('search')
// 90/min: la paleta de comandos dispara con debounce, así que una persona escribiendo rápido no se
// acerca; un bucle sí. `demand` cae en el límite por defecto, que es más que suficiente.
@Throttle({ default: { limit: SEARCH_LIMIT, ttl: WINDOW_MS } })
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  /**
   * `catalog.view` y no un permiso nuevo: quien puede ver el catálogo puede buscarlo. Separarlos
   * solo lograría que un vendedor con el permiso correcto viera una pantalla vacía.
   */
  @Get()
  @RequirePermissions('catalog.view')
  find(@CurrentCtx() ctx: Ctx, @ZodQuery(searchQuery) query: z.output<typeof searchQuery>) {
    return this.search.run(ctx, query);
  }

  /** Búsquedas sin existencia: la lista de compras que se arma sola. */
  @Get('demand')
  @RequirePermissions('demand.view')
  demand(@CurrentCtx() ctx: Ctx) {
    return this.search.demand(ctx);
  }
}
