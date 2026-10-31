import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { DispatchUpdate, RealtimeEvent } from '@partops/contracts';
import type { Server } from 'socket.io';
import { env } from '../config/env.js';

/**
 * Puente entre la lógica de negocio y los teléfonos de bodega.
 *
 * El servicio NO abre sockets: los abre el gateway. Se separan porque `OrdersService` y
 * `DispatchService` necesitan avisar sin arrastrar el servidor de sockets a sus pruebas ni obligar
 * a que exista una conexión para vender. Si no hay gateway (tests, worker de cron), `emit` no hace
 * nada y el negocio sigue funcionando: el aviso es una comodidad, no un paso del flujo.
 */

/** 128 s: el teléfono pide el ticket y conecta en el acto. Más tiempo es una credencial regalada. */
const TICKET_TTL_MS = 128_000;

interface TicketPayload {
  /** Usuario. */
  u: string;
  /** Negocio. */
  t: string;
  /** Vence en milisegundos desde epoch. */
  e: number;
}

export interface SocketIdentity {
  userId: string;
  tenantId: string;
}

/**
 * Ticket de conexión.
 *
 * El socket no puede leer la cookie de sesión en todos los casos: la app Android (Capacitor) sirve
 * desde `capacitor://localhost`, el WebSocket cruza de puerto y un proxy puede comerse la cookie en
 * el handshake. Un ticket firmado, de vida corta y atado a (usuario, negocio) resuelve los tres
 * casos sin abrir una sesión paralela que viva más que el propio login.
 *
 * Se firma con el secreto de auth: si alguien revoca ese secreto, todos los tickets mueren con las
 * sesiones, que es exactamente lo que se quiere en una rotación de emergencia.
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;

  /** Lo llama el gateway cuando Nest ya tiene el servidor de sockets listo. */
  attach(server: Server) {
    this.server = server;
  }

  onModuleDestroy() {
    this.server = null;
  }

  get connected(): boolean {
    return this.server !== null;
  }

  issueTicket(userId: string, tenantId: string): string {
    const payload: TicketPayload = { u: userId, t: tenantId, e: Date.now() + TICKET_TTL_MS };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /** `null` en lugar de excepción: el gateway cierra la conexión sin filtrar el motivo. */
  verifyTicket(ticket: string): SocketIdentity | null {
    const [body, signature] = ticket.split('.');
    if (!body || !signature) return null;
    const expected = this.sign(body);
    // Comparación en tiempo constante: comparar strings filtra la firma carácter a carácter.
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TicketPayload;
      if (!payload.u || !payload.t || payload.e < Date.now()) return null;
      return { userId: payload.u, tenantId: payload.t };
    } catch {
      return null;
    }
  }

  /**
   * Un cambio que le importa a la bodega.
   *
   * Va a dos salas: la del negocio entero (quien tiene todas las bodegas asignadas) y la de la
   * bodega concreta. Sin la segunda, el bodeguero de la sucursal norte vería el pedido de la sur y
   * caminaría a buscar una pieza que no está en su estante.
   */
  emitUpdate(tenantId: string, warehouseId: string, update: DispatchUpdate) {
    this.emit(tenantId, warehouseId, { type: 'dispatch:update', update });
  }

  emitNotice(
    tenantId: string,
    warehouseId: string,
    notice: Omit<Extract<RealtimeEvent, { type: 'dispatch:notice' }>, 'type'>,
  ) {
    this.emit(tenantId, warehouseId, { type: 'dispatch:notice', ...notice });
  }

  private emit(tenantId: string, warehouseId: string, event: RealtimeEvent) {
    if (!this.server) return;
    try {
      this.server.to(`wh:${tenantId}:${warehouseId}`).to(`tenant:${tenantId}`).emit('realtime', event);
    } catch (error) {
      // Un socket roto no puede tumbar la venta que ya se cobró. Se registra y sigue.
      this.logger.warn(`No se pudo emitir el evento de despacho: ${String(error)}`);
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', env.BETTER_AUTH_SECRET).update(body).digest('base64url');
  }
}

export { TICKET_TTL_MS };
export const REALTIME = Symbol('REALTIME');
export const InjectRealtime = () => Inject(RealtimeService);
