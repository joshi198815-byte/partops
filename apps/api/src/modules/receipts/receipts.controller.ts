import {
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { ReceiptFormat } from '@partops/contracts';
import type { Response } from 'express';
import { type Ctx, CurrentCtx, Public, RequirePermissions } from '../../common/context.js';
import { ReceiptsService } from './receipts.service.js';

/**
 * Recibos.
 *
 * Dos superficies distintas en el mismo archivo porque comparten token y formato:
 *
 *  - `orders/:id/receipt*` — con sesión y permiso. Emite y reenvía.
 *  - `public/receipts/:token*` — sin sesión. Es lo que el cliente abre desde WhatsApp.
 *
 * El orden de las rutas importa: `public/...` va declarado con su propio prefijo para que no lo
 * capture `orders/:id` ni el guard de sesión.
 */
@Controller('orders')
export class ReceiptsController {
  constructor(@Inject(ReceiptsService) private readonly receipts: ReceiptsService) {}

  /**
   * Emite el recibo. Repetir la llamada devuelve el mismo: nunca hay dos folios para un pedido.
   *
   * No recibe formato: se generan la carta y el ticket juntos. Elegir uno aquí obligaría a generar
   * el otro después, y "después" es exactamente cuando los datos ya no coinciden con el día de la
   * venta.
   */
  @Post(':id/receipt')
  @RequirePermissions('orders.create')
  @HttpCode(200)
  issue(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.receipts.issue(ctx, id);
  }

  /**
   * Recibo existente del pedido, o `null`.
   *
   * Devuelve 200 con `null` y no 404 a propósito: la pantalla pregunta "¿este pedido ya tiene
   * recibo?" al abrirlo, y un 404 ahí ensuciaría la consola del navegador con un error esperado.
   * La ausencia de recibo no es un fallo, es el estado normal antes de cobrar.
   */
  @Get(':id/receipt')
  @RequirePermissions('orders.view')
  async existing(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.receipts.find(ctx, id);
  }

  /** Reenvío desde el pedido: mismo recibo, enlace de WhatsApp fresco. */
  @Post(':id/receipt/resend')
  @RequirePermissions('orders.receipt.resend')
  @HttpCode(200)
  resend(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.receipts.resend(ctx, id);
  }
}

/**
 * Recibo público.
 *
 * `X-Robots-Tag: noindex` es obligatorio: sin él, un enlace compartido por WhatsApp acaba indexado
 * y el recibo de un cliente aparece en Google con su nombre, su NIT y lo que compró.
 */
@Controller('public/receipts')
export class PublicReceiptsController {
  constructor(@Inject(ReceiptsService) private readonly receipts: ReceiptsService) {}

  @Get(':token')
  @Public()
  async view(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    this.noindex(res);
    if (!isToken(token)) throw notFound();
    return this.receipts.publicView(token);
  }

  /**
   * PDF del recibo. `?formato=ticket` devuelve el de 80 mm.
   *
   * `inline` y no `attachment`: el cliente lo abre en WhatsApp y lo ve; si quiere guardarlo, el
   * visor ya trae el botón. Forzar la descarga en un teléfono deja el archivo en Descargas, donde
   * nadie lo encuentra.
   */
  @Get(':token/pdf')
  @Public()
  async pdf(
    @Param('token') token: string,
    @Query('formato') formato: string | undefined,
    @Res() res: Response,
  ) {
    this.noindex(res);
    if (!isToken(token)) throw notFound();

    const format: ReceiptFormat = formato === 'ticket' ? 'ticket' : 'carta';
    const found = await this.receipts.localFile(token, format);
    if (!found) throw notFound();

    if ('redirect' in found) {
      res.redirect(302, found.redirect);
      return;
    }
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="${found.filename}"`);
    // Inmutable: el PDF de un recibo nunca cambia. Un año de caché en el borde ahorra el viaje.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.sendFile(found.path, (err) => {
      if (err && !res.headersSent) res.status(404).json({ code: 'RECEIPT_NOT_FOUND' });
    });
  }

  private noindex(res: Response) {
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
    res.setHeader('referrer-policy', 'no-referrer');
  }
}

/** 22 caracteres base64url = 132 bits. Cualquier otra cosa se rechaza antes de tocar la base. */
function isToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,32}$/.test(token);
}

function notFound() {
  return new NotFoundException({ code: 'RECEIPT_NOT_FOUND', message: 'Ese recibo no existe' });
}
