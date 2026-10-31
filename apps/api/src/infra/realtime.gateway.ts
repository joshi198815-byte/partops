import { Inject } from '@nestjs/common';
import {
  ConnectedSocket,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service.js';
import { canAccessWarehouse, type TenantContext } from '../common/context.js';
import { allowedOrigins } from '../config/env.js';
import { RealtimeService } from './realtime.service.js';

interface SocketState {
  userId: string;
  tenant: TenantContext;
}

/**
 * Canal en vivo de bodega.
 *
 * Reglas que no se negocian:
 *
 *  1. **Se entra con ticket, no con cookie.** El handshake desde el APK o desde un túnel no siempre
 *     lleva cookie; el ticket firmado de 128 s resuelve eso sin abrir una sesión paralela.
 *  2. **El negocio se vuelve a resolver en el connect.** Un ticket robado de alguien a quien ya se
 *     le quitó el acceso no debe darle ni un evento. El ticket prueba identidad, no autorización.
 *  3. **Salas por negocio y por bodega.** El bodeguero de la sucursal norte no recibe el pedido de
 *     la sur: caminaría a buscar una pieza que no está en su estante.
 *  4. **El servidor no confía en el cliente.** No hay ningún evento entrante que cambie estado; los
 *     cambios van por HTTP con permisos. El socket es de bajada, y por eso no puede ser un atajo
 *     para saltarse `orders.dispatch`.
 */
@WebSocketGateway({
  // Mismo camino que la API. Render y Cloudflare enrutan `/api/*` a la API; `/api/realtime`
  // atraviesa el rewrite de Next y el proxy del borde sin una regla extra de WebSocket.
  path: '/api/realtime',
  cors: { origin: allowedOrigins, credentials: true },
  // Sin `transports` forzados: el borde acepta WebSocket y el cliente cae a polling si la red de
  // la bodega lo bloquea. Un túnel que solo permite HTTP no debe dejar al bodeguero sin lista.
  pingInterval: 20_000,
  pingTimeout: 25_000,
  maxHttpBufferSize: 64 * 1024,
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /**
   * Un socket no inicializado no debe romper el arranque: en pruebas y en el worker no hay
   * servidor de sockets y el negocio tiene que funcionar igual.
   */
  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  async handleConnection(socket: Socket) {
    const ticket = typeof socket.handshake.auth?.ticket === 'string' ? socket.handshake.auth.ticket : '';
    const identity = ticket ? this.realtime.verifyTicket(ticket) : null;
    if (!identity) {
      socket.emit('realtime:error', { code: 'UNAUTHENTICATED', message: 'Vuelve a entrar' });
      socket.disconnect(true);
      return;
    }

    let tenant: TenantContext;
    try {
      tenant = await this.auth.resolveTenant(identity.userId, identity.tenantId);
    } catch {
      // Miembro desactivado o negocio suspendido entre el ticket y el connect.
      socket.emit('realtime:error', { code: 'FORBIDDEN', message: 'Sin acceso a este negocio' });
      socket.disconnect(true);
      return;
    }

    /**
     * Solo quien tiene trabajo en bodega recibe la cola. Un vendedor no necesita el socket y
     * abrirlo le costaría una conexión del pool en cada pestaña abierta todo el día.
     */
    if (!tenant.permissions.has('orders.dispatch')) {
      socket.emit('realtime:error', { code: 'FORBIDDEN', message: 'Sin permiso de despacho' });
      socket.disconnect(true);
      return;
    }

    const state: SocketState = { userId: identity.userId, tenant };
    socket.data.state = state;

    await socket.join(`tenant:${tenant.tenantId}`);
    // Bodegas asignadas; lista vacía = todas, y ahí la sala del negocio ya cubre el caso.
    for (const warehouseId of tenant.warehouseIds) {
      await socket.join(`wh:${tenant.tenantId}:${warehouseId}`);
    }

    socket.emit('realtime:ready', {
      tenantId: tenant.tenantId,
      warehouses: tenant.warehouseIds,
      connectedAt: new Date().toISOString(),
    });
  }

  handleDisconnect(socket: Socket) {
    // Nada que limpiar: las salas mueren con el socket y el estado es por conexión.
    const state = socket.data.state as SocketState | undefined;
    if (state) socket.data.state = undefined;
  }

  /**
   * Latido del cliente.
   *
   * Socket.IO ya tiene ping/pong, pero el teléfono necesita saber que la conexión sirve ANTES de
   * fiarse de la lista: una red de bodega puede aceptar el socket y no entregar nada. Esto
   * devuelve el reloj del servidor para detectar que el teléfono lleva horas desfasado.
   */
  @SubscribeMessage('realtime:ping')
  ping(@ConnectedSocket() socket: Socket) {
    const state = socket.data.state as SocketState | undefined;
    if (!state) return { ok: false };
    return { ok: true, at: new Date().toISOString(), tenantId: state.tenant.tenantId };
  }

  /**
   * Cambio de bodega activa sin reconectar.
   *
   * El bodeguero que cubre dos sucursales el mismo día no debe cerrar sesión para dejar de recibir
   * los pedidos de la que no está pisando.
   */
  @SubscribeMessage('realtime:watch')
  async watch(@ConnectedSocket() socket: Socket, payload: { warehouseId?: unknown } | undefined) {
    const state = socket.data.state as SocketState | undefined;
    if (!state) return { ok: false };

    const warehouseId = typeof payload?.warehouseId === 'string' ? payload.warehouseId : null;
    if (warehouseId && !canAccessWarehouse(state.tenant, warehouseId)) return { ok: false };

    // Deja solo la sala de bodega pedida (o vuelve a la del negocio si viene nula).
    for (const room of socket.rooms) {
      if (room.startsWith(`wh:${state.tenant.tenantId}:`)) {
        if (!warehouseId || room !== `wh:${state.tenant.tenantId}:${warehouseId}`) {
          await socket.leave(room);
        }
      }
    }
    if (warehouseId) await socket.join(`wh:${state.tenant.tenantId}:${warehouseId}`);
    return { ok: true, warehouseId };
  }
}
