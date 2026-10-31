import { Inject, Injectable } from '@nestjs/common';
import { newOrderNotice } from '@partops/contracts';
import { PushService } from '../../infra/push.service.js';
import { RealtimeService } from '../../infra/realtime.service.js';

/**
 * Avisos de la cola de despacho.
 *
 * Vive aparte de `DispatchService` porque quien crea el pedido es `OrdersService` y no puede
 * depender del despacho: sería un ciclo (despacho mueve líneas de pedidos, pedidos avisa al
 * despacho) que Nest resuelve mal y que además obligaría a cargar la cola entera para mandar un
 * aviso. Este servicio solo sabe avisar, y por eso lo pueden usar los dos sin acoplarse.
 */
@Injectable()
export class DispatchNotifier {
  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  /**
   * Entró un pedido con piezas por preparar en esa bodega.
   *
   * El socket va primero: si el bodeguero tiene la pantalla abierta, la ve cambiar sin esperar la
   * notificación del sistema. El push cubre el caso contrario —teléfono en el bolsillo, pestaña en
   * segundo plano— y se manda después para no notificar algo que ya está en pantalla.
   */
  async orderArrived(args: {
    tenantId: string;
    warehouseId: string;
    orderId: string;
    code: string;
    customerName: string;
    pendingUnits: number;
  }): Promise<void> {
    if (args.pendingUnits <= 0) return;

    const notice = newOrderNotice({
      code: args.code,
      customerName: args.customerName,
      pendingUnits: args.pendingUnits,
    });

    this.realtime.emitNotice(args.tenantId, args.warehouseId, {
      title: notice.title,
      body: notice.body,
      orderId: args.orderId,
      at: new Date().toISOString(),
    });

    // El push nunca rompe la venta: si falla, el pedido ya existe y el socket ya avisó.
    await this.push
      .notifyWarehouse(args.tenantId, args.warehouseId, {
        title: notice.title,
        body: notice.body,
        url: `/app/despacho?pedido=${args.orderId}`,
        tag: `pedido-${args.orderId}`,
        urgent: true,
      })
      .catch(() => undefined);
  }
}
