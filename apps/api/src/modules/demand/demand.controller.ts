import { Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodBody, ZodQuery } from '../../common/zod.js';
import { DemandService } from './demand.service.js';
import { StockWatchService } from './stock-watch.service.js';

/**
 * Demanda y avisos de llegada.
 *
 * Dos permisos en juego y una asimetría deliberada: `demand.view` deja ver qué se busca y no hay;
 * `demand.watch.manage` deja mover la bandeja de avisos. El vendedor tiene el primero —le sirve
 * para decir "no lo tengo, pero te aviso"— y solo gerencia puede mandar los WhatsApp en lote, que
 * es la acción que un cliente siente.
 */

const notifyBody = z.object({
  ids: z.array(z.string().uuid()).min(1, 'Selecciona al menos un aviso').max(500),
});

const keyQuery = z.object({
  /** Clave del grupo (`variant:<uuid>`, `part:<uuid>`, `term:<texto>`). */
  grupo: z.string().trim().min(3).max(160),
  /** Portada del catálogo, para que el mensaje del cliente tenga a dónde llevar. */
  catalogo: z.string().url().max(300).optional(),
});

@Controller('demand')
export class DemandController {
  constructor(@Inject(DemandService) private readonly demand: DemandService) {}

  /** Panel completo: totales, faltantes, vehículo, categoría, serie diaria y meses. */
  @Get()
  @RequirePermissions('demand.view')
  overview(@CurrentCtx() ctx: Ctx) {
    return this.demand.overview(ctx);
  }

  /**
   * Recalcula el agregado de los últimos días.
   *
   * Manual y no solo por cron: cuando alguien importa un catálogo grande y quiere ver el efecto en
   * el reporte sin esperar a la madrugada. Es idempotente —borra e inserta el mismo rango—, así que
   * un doble clic no duplica nada.
   */
  @Post('rollup')
  @RequirePermissions('demand.view')
  rollup(@CurrentCtx() ctx: Ctx) {
    return this.demand.recomputeRecent(ctx);
  }
}

@Controller('demand/watch')
export class StockWatchController {
  constructor(@Inject(StockWatchService) private readonly watch: StockWatchService) {}

  /** Bandeja: avisos pendientes agrupados por pieza, con la existencia de hoy. */
  @Get()
  @RequirePermissions('demand.view')
  tray(@CurrentCtx() ctx: Ctx) {
    return this.watch.tray(ctx);
  }

  /** Clientes de un grupo, con el mensaje de WhatsApp ya escrito para cada uno. */
  @Get(':key')
  @RequirePermissions('demand.view')
  notification(
    @CurrentCtx() ctx: Ctx,
    @Param('key') key: string,
    @ZodQuery(keyQuery) query: z.output<typeof keyQuery>,
  ) {
    const base = query.catalogo ?? `https://partops.autos/c/${ctx.tenant.tenantSlug}`;
    return this.watch.notification(ctx, decodeURIComponent(key), base);
  }

  /** Marca los avisos como enviados. Solo los que se mostraron y se mandaron de verdad. */
  @Post('notified')
  @RequirePermissions('demand.watch.manage')
  notified(@CurrentCtx() ctx: Ctx, @ZodBody(notifyBody) body: z.output<typeof notifyBody>) {
    return this.watch.markNotified(ctx, body.ids);
  }

  /** Quita avisos que ya no se van a cumplir. */
  @Delete()
  @RequirePermissions('demand.watch.manage')
  dismiss(@CurrentCtx() ctx: Ctx, @ZodBody(notifyBody) body: z.output<typeof notifyBody>) {
    return this.watch.dismiss(ctx, body.ids);
  }
}
