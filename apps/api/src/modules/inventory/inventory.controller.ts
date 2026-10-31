import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  inventoryListQuerySchema,
  movementQuerySchema,
  type ReorderPointData,
  reorderPointSchema,
  type TransferCreateData,
  type TransferReceiveData,
  transferCreateSchema,
  transferListQuerySchema,
  transferReceiveSchema,
  variantOptionQuerySchema,
} from '@partops/contracts';
import { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodBody, ZodQuery } from '../../common/zod.js';
import { InventoryQueryService } from './inventory.query.service.js';
import { TransferService } from './transfer.service.js';

const cancelSchema = z.object({ reason: z.string().trim().max(300).optional() });

/**
 * Inventario.
 *
 * Cuatro permisos distintos porque son cuatro trabajos distintos: ver (`inventory.view`), corregir
 * una existencia con motivo (`inventory.adjust`), mover entre bodegas (`inventory.transfer`) y tomar
 * inventario físico (`inventory.count`). Un vendedor puede necesitar los dos primeros y no el
 * tercero, y el bodeguero al revés.
 */
@Controller('inventory')
export class InventoryController {
  constructor(
    @Inject(InventoryQueryService) private readonly query: InventoryQueryService,
    @Inject(TransferService) private readonly transfers: TransferService,
  ) {}

  // ───────────────────────────── Existencias ─────────────────────────────

  @Get()
  @RequirePermissions('inventory.view')
  list(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(inventoryListQuerySchema) query: z.output<typeof inventoryListQuerySchema>,
  ) {
    return this.query.list(ctx, query);
  }

  /** Totales para las tarjetas de arriba. Va antes de `:id` para que no lo capture la ruta. */
  @Get('summary')
  @RequirePermissions('inventory.view')
  summary(@CurrentCtx() ctx: Ctx) {
    return this.query.summary(ctx);
  }

  /** Bodegas visibles para el usuario, ya acotadas por su asignación. */
  @Get('warehouses')
  @RequirePermissions('inventory.view')
  warehouses(@CurrentCtx() ctx: Ctx) {
    return this.query.warehouses(ctx);
  }

  /** Piezas para armar un traslado, con lo disponible en la bodega de origen. */
  @Get('variants')
  @RequirePermissions('inventory.view')
  variants(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(variantOptionQuerySchema) query: z.output<typeof variantOptionQuerySchema>,
  ) {
    return this.query.variantOptions(ctx, query);
  }

  /** Ledger. Reescribir un movimiento es imposible por trigger; aquí solo se lee. */
  @Get('movements')
  @RequirePermissions('inventory.view')
  movements(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(movementQuerySchema) query: z.output<typeof movementQuerySchema>,
  ) {
    return this.query.movements(ctx, query);
  }

  /**
   * Punto de reorden y ubicación.
   *
   * Idempotente: mandar dos veces el mismo mínimo deja el mismo estado, y la pantalla puede
   * reintentar sin miedo cuando la red del pasillo se cae.
   */
  @Post('variants/:variantId/reorder')
  @RequirePermissions('inventory.adjust')
  @HttpCode(200)
  setReorder(
    @CurrentCtx() ctx: Ctx,
    @Param('variantId') variantId: string,
    @ZodBody(reorderPointSchema) body: ReorderPointData,
  ) {
    return this.query.setReorder(ctx, variantId, body);
  }

  // ───────────────────────────── Traslados ─────────────────────────────

  @Get('transfers')
  @RequirePermissions('inventory.view')
  listTransfers(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(transferListQuerySchema) query: z.output<typeof transferListQuerySchema>,
  ) {
    return this.transfers.list(ctx, query);
  }

  @Get('transfers/:id')
  @RequirePermissions('inventory.view')
  transfer(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.transfers.detail(ctx, id);
  }

  @Post('transfers')
  @RequirePermissions('inventory.transfer')
  @HttpCode(201)
  createTransfer(@CurrentCtx() ctx: Ctx, @ZodBody(transferCreateSchema) body: TransferCreateData) {
    return this.transfers.create(ctx, body);
  }

  /** Despacho desde origen: la pieza sale físicamente y baja la existencia. */
  @Post('transfers/:id/send')
  @RequirePermissions('inventory.transfer')
  @HttpCode(200)
  sendTransfer(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.transfers.send(ctx, id);
  }

  @Post('transfers/:id/receive')
  @RequirePermissions('inventory.transfer')
  @HttpCode(200)
  receiveTransfer(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(transferReceiveSchema) body: TransferReceiveData,
  ) {
    return this.transfers.receive(ctx, id, body);
  }

  @Post('transfers/:id/cancel')
  @RequirePermissions('inventory.transfer')
  @HttpCode(200)
  cancelTransfer(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(cancelSchema) body: z.output<typeof cancelSchema>,
  ) {
    return this.transfers.cancel(ctx, id, body.reason);
  }
}
