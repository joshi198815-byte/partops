import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  type LineStatus,
  type OrderCreateData,
  type OrderListQuery,
  orderCancelSchema,
  orderCreateSchema,
  orderLineStatusSchema,
  orderListQuerySchema,
  type PaymentCreateData,
  paymentCreateSchema,
  variantOptionQuerySchema,
} from '@partops/contracts';
import type { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodBody, ZodQuery } from '../../common/zod.js';
import { OrdersService } from './orders.service.js';

/**
 * Ventas.
 *
 * Permisos separados por trabajo: `orders.view` para ver, `orders.create` para vender,
 * `orders.dispatch` para preparar y entregar en bodega, `orders.cancel` para liberar reservas y
 * `orders.price.override` para tocar el precio. Un bodeguero necesita el tercero y no el segundo;
 * un vendedor, al revés.
 */
@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions('orders.view')
  list(@CurrentCtx() ctx: Ctx, @ZodQuery(orderListQuerySchema) query: OrderListQuery) {
    return this.orders.list(ctx, query);
  }

  /**
   * Buscador de piezas para armar la venta.
   *
   * Va antes de `:id` para que no lo capture la ruta del detalle: sin esto `/api/orders/catalog`
   * se interpretaría como "el pedido llamado catalog" y devolvería 404 en la cara del vendedor.
   */
  @Get('catalog')
  @RequirePermissions('orders.create')
  catalog(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(variantOptionQuerySchema) query: z.output<typeof variantOptionQuerySchema>,
  ) {
    return this.orders.variantOptions(ctx, query);
  }

  /** Libera reservas vencidas. Idempotente: la segunda llamada ya no encuentra nada que liberar. */
  @Post('reservations/expire')
  @RequirePermissions('orders.dispatch')
  @HttpCode(200)
  expire(@CurrentCtx() ctx: Ctx) {
    return this.orders.expireReservations(ctx);
  }

  @Get(':id')
  @RequirePermissions('orders.view')
  detail(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.orders.detail(ctx, id);
  }

  /**
   * Alta. Responde 200 y no 201 a propósito: con `idempotencyKey` repetida devuelve el pedido que
   * ya existe, y un 201 ahí le diría a la pantalla que acaba de crear algo que no creó.
   */
  @Post()
  @RequirePermissions('orders.create')
  @HttpCode(200)
  create(@CurrentCtx() ctx: Ctx, @ZodBody(orderCreateSchema) body: OrderCreateData) {
    return this.orders.create(ctx, body);
  }

  /** Mover una línea: preparar, listo, entregado, sin stock o cancelada. */
  @Post(':id/lines/:itemId/status')
  @RequirePermissions('orders.dispatch')
  @HttpCode(200)
  setLine(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @ZodBody(orderLineStatusSchema) body: z.output<typeof orderLineStatusSchema>,
  ) {
    return this.orders.setLineStatus(ctx, id, itemId, body.status as LineStatus);
  }

  @Post(':id/payments')
  @RequirePermissions('orders.create')
  @HttpCode(200)
  addPayment(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(paymentCreateSchema) body: PaymentCreateData,
  ) {
    return this.orders.addPayment(ctx, id, body);
  }

  @Post(':id/cancel')
  @RequirePermissions('orders.cancel')
  @HttpCode(200)
  cancel(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(orderCancelSchema) body: z.output<typeof orderCancelSchema>,
  ) {
    return this.orders.cancel(ctx, id, body.reason);
  }
}
