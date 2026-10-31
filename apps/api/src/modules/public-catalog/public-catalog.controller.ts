import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type PublicCatalogQuery,
  type PublicOrderData,
  publicCatalogQuerySchema,
  publicOrderSchema,
  stockWatchSchema,
} from '@partops/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { Public } from '../../common/context.js';
import { CATALOG_LIMIT, WINDOW_MS } from '../../common/throttle.js';
import { ZodBody } from '../../common/zod.js';
import { PublicCatalogService } from './public-catalog.service.js';

/**
 * Vitrina pública.
 *
 * Todo aquí es `@Public()`: no hay sesión, no hay negocio activo y no hay permisos. El aislamiento
 * se apoya en tres cosas, en este orden:
 *
 *  1. El negocio se resuelve por `slug` contra la base; nunca se acepta un `tenantId` de la URL.
 *  2. Cada servicio abre su transacción con el tenant resuelto, así la RLS también cubre el olvido.
 *  3. Nada de lo que se devuelve incluye costo, márgenes, existencias exactas ni datos de clientes.
 *
 * `Cache-Control` en el listado y en la ficha: la vitrina se cachea en el borde y el TTFB baja a
 * decenas de milisegundos. El carrito y el pedido no se cachean jamás.
 */

const SHORT_CACHE = 'public, s-maxage=30, stale-while-revalidate=120';
const LONG_CACHE = 'public, s-maxage=120, stale-while-revalidate=600';

@Controller('public/catalog')
// Vitrina anónima: el límite de Postgres por negocio ya frena la creación de pedidos; esto frena el
// flood de listados y fichas, que son baratos de servir pero caros de multiplicar.
@Throttle({ default: { limit: CATALOG_LIMIT, ttl: WINDOW_MS } })
export class PublicCatalogController {
  constructor(@Inject(PublicCatalogService) private readonly catalog: PublicCatalogService) {}

  /** Portada de la vitrina: filtros por vehículo, búsqueda y facetas en una sola respuesta. */
  @Get(':slug')
  @Public()
  async list(
    @Param('slug') slug: string,
    @Query() raw: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('cache-control', SHORT_CACHE);
    return this.catalog.list(slug, parseQuery(raw));
  }

  /** Ficha por slug de pieza o por SKU/OEM: el enlace que se pega en un WhatsApp. */
  @Get(':slug/part/:key')
  @Public()
  async part(
    @Param('slug') slug: string,
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('cache-control', LONG_CACHE);
    return this.catalog.part(slug, key);
  }

  /**
   * Pedido de invitado.
   *
   * Sin caché y sin reintentos automáticos del navegador: el `idempotencyKey` que manda el cliente
   * es lo que evita el doble pedido, no la suerte del transporte.
   */
  @Post(':slug/order')
  @Public()
  async order(
    @Param('slug') slug: string,
    @ZodBody(publicOrderSchema) body: PublicOrderData,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('cache-control', 'no-store');
    const origin =
      (typeof req.headers.origin === 'string' && req.headers.origin) ||
      (typeof req.headers.referer === 'string' && new URL(req.headers.referer).origin) ||
      'http://localhost:3000';
    return this.catalog.order(slug, body, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      origin,
    });
  }

  /** Enlace de WhatsApp para "no encontré mi pieza". No crea pedido ni reserva nada. */
  @Get(':slug/inquiry')
  @Public()
  inquiry(@Param('slug') slug: string, @Query('q') q: string | undefined, @Req() req: Request) {
    const origin = (typeof req.headers.origin === 'string' && req.headers.origin) || 'http://localhost:3000';
    return this.catalog.inquiry(slug, (q ?? '').slice(0, 160), origin);
  }

  /**
   * "Avísame cuando llegue" desde la ficha de la pieza.
   *
   * No crea pedido ni reserva: solo deja el teléfono en la bandeja de la bodega. El mismo límite por
   * IP que la búsqueda, porque un bot aquí no llena la base de pedidos sino de teléfonos ajenos, que
   * es peor: el daño se lo lleva un cliente que empieza a recibir mensajes que no pidió.
   */
  @Post(':slug/watch')
  @Public()
  async watch(
    @Param('slug') slug: string,
    @ZodBody(stockWatchSchema) body: z.output<typeof stockWatchSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('cache-control', 'no-store');
    return this.catalog.watch(slug, body, { ip: req.ip });
  }

  /**
   * Registra la búsqueda del visitante como demanda.
   *
   * Va aparte del `GET` a propósito: un `GET` que escribe no se puede cachear, y la vitrina necesita
   * caché para tener un TTFB decente. Si esto falla, el catálogo ya respondió y al cliente no le
   * importa.
   */
  @Post(':slug/track')
  @Public()
  track(@Param('slug') slug: string, @Body() body: { q?: string }, @Req() req: Request) {
    return this.catalog.trackSearch(slug, (body?.q ?? '').slice(0, 120), req.ip);
  }
}

/**
 * Query sin `ZodQuery`: el decorador compartido lanza un 400 con el formato de la casa, pero aquí
 * un filtro inválido no debe romper la portada. Un `page=abc` se lee como página 1 y el cliente ve
 * el catálogo, en vez de una pantalla de error por un enlace mal copiado.
 */
function parseQuery(raw: Record<string, unknown>): PublicCatalogQuery {
  const parsed = publicCatalogQuerySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return publicCatalogQuerySchema.parse({});
}
