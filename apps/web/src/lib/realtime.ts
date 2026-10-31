'use client';

import type { RealtimeEvent, RealtimeTicket } from '@partops/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Conexión en vivo con la bodega.
 *
 * Tres cosas que este hook hace y que no se ven en una demo:
 *
 *  - **Se reconecta con espera creciente.** La red del pasillo se cae y vuelve cada dos minutos; un
 *    reintento cada 250 ms la tumba otra vez. El techo es 30 s y se reinicia al volver a la pestaña.
 *  - **Al volver pide la verdad.** Un evento perdido no se recupera solo: al conectar se avisa para
 *    que la pantalla recargue la cola. Sin eso, el bodeguero ve una lista de hace veinte minutos y
 *    prepara un pedido que ya salió.
 *  - **No hay socket si no hay permiso ni gateway.** El ticket se pide por HTTP; si el servidor no
 *    tiene servidor de sockets (worker, pruebas) se queda en `apagado` y la pantalla sigue por HTTP.
 */

export type ConnectionState = 'conectando' | 'en-vivo' | 'reintentando' | 'sin-permiso' | 'apagado';

/** 1 s, 2 s, 4 s… techo 30 s. La bodega vuelve y no la estamos martillando. */
function delayFor(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
}

interface SocketLike {
  on(event: string, handler: (...args: never[]) => void): void;
  emit(event: string, payload?: unknown): void;
  disconnect(): void;
}

export function useRealtime(args: {
  enabled: boolean;
  warehouseId: string | null;
  onEvent?: (event: RealtimeEvent) => void;
  /** Se llama al conectar (y al reconectar) para recargar la cola desde el servidor. */
  onResync?: () => void;
}) {
  const { enabled, warehouseId, onEvent, onResync } = args;
  const [state, setState] = useState<ConnectionState>('apagado');

  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };

  const socketRef = useRef<SocketLike | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  const warehouseRef = useRef(warehouseId);
  warehouseRef.current = warehouseId;

  /**
   * `connectRef` evita el ciclo entre `connect` y `schedule`: cada una necesita a la otra, y con
   * `useCallback` una dependencia mutua se resuelve recreando las dos en cada render (y abriendo un
   * socket nuevo cada vez).
   */
  const connectRef = useRef<() => Promise<void>>(async () => undefined);

  const schedule = useCallback(() => {
    if (!aliveRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const wait = delayFor(attemptRef.current);
    attemptRef.current += 1;
    timerRef.current = setTimeout(() => {
      // En segundo plano el navegador congela los timers igual; despertar cada 30 s para nada
      // consume batería. Se reintenta al volver a mirar la pantalla.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      void connectRef.current();
    }, wait);
  }, []);

  const connect = useCallback(async () => {
    if (!enabled || !aliveRef.current) return;
    setState('conectando');

    let ticket: RealtimeTicket;
    try {
      ticket = await api<RealtimeTicket>('/api/realtime/ticket');
    } catch {
      // Sin permiso de despacho no hay nada que escuchar; reintentar sería un bucle inútil.
      setState('sin-permiso');
      return;
    }
    if (!ticket.connected) {
      setState('apagado');
      return;
    }

    const { io } = await import('socket.io-client');
    if (!aliveRef.current) return;
    const socket = io({
      path: ticket.path,
      // WebSocket primero; si la red lo bloquea, Socket.IO cae a polling solo.
      transports: ['websocket', 'polling'],
      auth: { ticket: ticket.ticket },
      reconnection: false,
      timeout: 8000,
    }) as unknown as SocketLike;

    socketRef.current = socket;

    socket.on('connect', () => {
      attemptRef.current = 0;
      setState('en-vivo');
      if (warehouseRef.current) socket.emit('realtime:watch', { warehouseId: warehouseRef.current });
      handlers.current.onResync?.();
    });
    socket.on('realtime', (event: RealtimeEvent) => handlers.current.onEvent?.(event));
    socket.on('realtime:error', () => {
      setState('sin-permiso');
      socket.disconnect();
    });
    socket.on('disconnect', () => {
      socketRef.current = null;
      if (!aliveRef.current) return;
      setState('reintentando');
      schedule();
    });
    socket.on('connect_error', () => {
      socket.disconnect();
      socketRef.current = null;
      if (!aliveRef.current) return;
      setState('reintentando');
      schedule();
    });
  }, [enabled, schedule]);

  connectRef.current = connect;

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) {
      setState('apagado');
      return () => undefined;
    }

    void connect();

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      attemptRef.current = 0;
      if (!socketRef.current) void connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      aliveRef.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
    // Cambiar de bodega no rehace la conexión: `watch` mueve la sala en el socket abierto.
  }, [enabled, connect]);

  /**
   * La bodega activa puede llegar después del primer render (la lista se carga por HTTP). Sin
   * esto, el socket quedaría en la sala del negocio y el bodeguero no vería el trabajo de su
   * sucursal hasta reconectar.
   */
  useEffect(() => {
    socketRef.current?.emit('realtime:watch', { warehouseId: warehouseId || null });
  }, [warehouseId]);

  /** Cambia de sala sin reconectar (el bodeguero que cubre dos sucursales el mismo día). */
  const watch = useCallback((next: string | null) => {
    socketRef.current?.emit('realtime:watch', { warehouseId: next });
  }, []);

  const ping = useCallback(() => {
    socketRef.current?.emit('realtime:ping');
  }, []);

  return { state, watch, ping };
}
