import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import {
  type DispatchQueueQuery,
  dispatchQueueQuerySchema,
  dispatchScanSchema,
  dispatchSyncSchema,
  type PushSubscribeData,
  type PushUnsubscribeData,
  pushSubscribeSchema,
  pushUnsubscribeSchema,
  type RealtimeTicket,
} from '@partops/contracts';
import type { z } from 'zod';
import type { AuthedRequest, Ctx } from '../../common/context.js';
import { CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodBody, ZodQuery } from '../../common/zod.js';
import { PushService } from '../../infra/push.service.js';
import { RealtimeService } from '../../infra/realtime.service.js';
import { DispatchService } from './dispatch.service.js';

/**
 * Despacho.
 *
 * Todo exige `orders.dispatch`: el bodeguero prepara y entrega, y quien solo vende no debe poder
 * mover una línea desde el pasillo. El vendedor ve el mismo estado en Ventas, que es donde le toca.
 */
@Controller('dispatch')
export class DispatchController {
  constructor(@Inject(DispatchService) private readonly dispatch: DispatchService) {}

  /** Cola de preparación ordenada por la caminata. */
  @Get('queue')
  @RequirePermissions('orders.dispatch')
  queue(@CurrentCtx() ctx: Ctx, @ZodQuery(dispatchQueueQuerySchema) query: DispatchQueueQuery) {
    return this.dispatch.queue(ctx, query);
  }

  /**
   * Escanear una pieza.
   *
   * Devuelve 200 con `ok: false` cuando el código no es de esa línea, en vez de un 4xx: es una
   * respuesta normal del flujo —el bodeguero tiene la pieza equivocada en la mano— y la pantalla
   * necesita el SKU esperado para decírselo, no un error genérico de red.
   */
  @Post('orders/:orderId/lines/:itemId/scan')
  @RequirePermissions('orders.dispatch')
  @HttpCode(200)
  scan(
    @CurrentCtx() ctx: Ctx,
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @ZodBody(dispatchScanSchema) body: z.output<typeof dispatchScanSchema>,
  ) {
    return this.dispatch.scan(ctx, orderId, itemId, body.code, body.status);
  }

  /** Sincroniza lo que el teléfono guardó sin señal. Idempotente por `opId`. */
  @Post('sync')
  @RequirePermissions('orders.dispatch')
  @HttpCode(200)
  sync(@CurrentCtx() ctx: Ctx, @ZodBody(dispatchSyncSchema) body: z.output<typeof dispatchSyncSchema>) {
    return this.dispatch.sync(ctx, body);
  }
}

/**
 * Tiempo real y avisos.
 *
 * El ticket se pide por HTTP porque el handshake del socket no puede leer la cookie en el APK ni
 * detrás de un túnel. Vive 128 s: lo justo para conectar, no para reutilizarlo desde otro aparato.
 */
@Controller('realtime')
export class RealtimeController {
  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  @Get('ticket')
  @RequirePermissions('orders.dispatch')
  ticket(@CurrentCtx() ctx: Ctx): RealtimeTicket {
    return {
      ticket: this.realtime.issueTicket(ctx.user.id, ctx.tenant.tenantId),
      path: '/api/realtime',
      expiresIn: 128,
      connected: this.realtime.connected,
    };
  }

  /**
   * Clave pública de Web Push.
   *
   * `null` cuando no hay llaves configuradas: la pantalla no debe ofrecer "activar avisos" si el
   * servidor no puede mandarlos, porque el navegador pediría permiso para nada.
   */
  @Get('push/key')
  @RequirePermissions('orders.dispatch')
  pushKey() {
    return { key: this.push.publicKey };
  }

  /** Suscribe este aparato. */
  @Post('push/subscribe')
  @RequirePermissions('orders.dispatch')
  @HttpCode(200)
  async subscribe(
    @CurrentCtx() ctx: Ctx,
    @Req() req: AuthedRequest,
    @ZodBody(pushSubscribeSchema) body: PushSubscribeData,
  ) {
    await this.push.subscribe({
      tenantId: ctx.tenant.tenantId,
      userId: ctx.user.id,
      token: body.endpoint,
      p256dh: body.keys?.p256dh ?? null,
      auth: body.keys?.auth ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { ok: true };
  }

  @Post('push/unsubscribe')
  @RequirePermissions('orders.dispatch')
  @HttpCode(200)
  async unsubscribe(@CurrentCtx() ctx: Ctx, @ZodBody(pushUnsubscribeSchema) body: PushUnsubscribeData) {
    await this.push.unsubscribe(body.endpoint, ctx.user.id);
    return { ok: true };
  }
}
