import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from './database.module.js';
import type { FcmService } from './fcm.service.js';
import { PushService } from './push.service.js';

/**
 * Reparto del aviso por transporte.
 *
 * La tabla `push_token` mezcla navegadores y teléfonos, y cada fila tiene que salir por su camino:
 * una suscripción Web Push no se puede mandar a Firebase ni al revés. Equivocarse no da error —el
 * proveedor acepta el mensaje y no llega— así que se fija aquí.
 *
 * No hay base: el `system` del servicio se reemplaza por una función que devuelve las filas. Lo que
 * se prueba es la decisión, no la consulta.
 */
function pushService(rows: Array<Record<string, unknown>>, fcm: Partial<FcmService>) {
  const deleted: string[] = [];
  const db = {
    system: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: async () => rows,
        pushToken: {
          deleteMany: async ({ where }: { where: { token: string } }) => deleted.push(where.token),
        },
      }),
  } as unknown as DatabaseService;

  const service = new PushService(db, fcm as FcmService);
  return { service, deleted };
}

describe('push: ruteo por plataforma', () => {
  it('sin VAPID ni FCM no intenta nada y no falla', async () => {
    const { service } = pushService([{ token: 'x', platform: 'fcm', p256dh: null, auth: null }], {
      available: false,
    });
    await expect(service.notifyWarehouse('t1', 'w1', { title: 'Pedido', body: 'PD-0001' })).resolves.toEqual({
      sent: 0,
      failed: 0,
      removed: 0,
    });
  });

  it('una fila fcm no se manda por Web Push aunque tenga claves', async () => {
    const send = vi.fn().mockResolvedValue('ok');
    const { service } = pushService(
      [{ token: 'fcm-token', platform: 'fcm', p256dh: 'no-deberia-usarse', auth: 'tampoco' }],
      { available: true, send, removeToken: vi.fn() },
    );

    const result = await service.notifyWarehouse('t1', 'w1', { title: 'Listo', body: 'PD-0002' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
  });

  it('un token muerto en FCM se borra y no cuenta como enviado', async () => {
    const removeToken = vi.fn().mockResolvedValue(undefined);
    const { service } = pushService([{ token: 'muerto', platform: 'fcm', p256dh: null, auth: null }], {
      available: true,
      send: vi.fn().mockResolvedValue('gone'),
      removeToken,
    });

    const result = await service.notifyWarehouse('t1', 'w1', { title: 'Listo', body: 'PD-0003' });
    expect(result).toEqual({ sent: 0, failed: 0, removed: 1 });
    expect(removeToken).toHaveBeenCalledWith('muerto');
  });

  it('una fila web sin claves se salta sin marcarse como fallo', async () => {
    const { service } = pushService(
      [{ token: 'https://push.example/1', platform: 'web', p256dh: null, auth: null }],
      {
        available: true,
      },
    );

    // Reintentar no arregla una suscripción sin `p256dh`: el navegador la guardó a medias.
    await expect(service.notifyWarehouse('t1', 'w1', { title: 'Aviso', body: 'cuerpo' })).resolves.toEqual({
      sent: 0,
      failed: 0,
      removed: 0,
    });
  });

  it('la suscripción nativa se guarda con su plataforma', async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const db = {
      system: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          pushToken: {
            upsert: async (args: { create: Record<string, unknown> }) => upserts.push(args.create),
          },
        }),
    } as unknown as DatabaseService;

    const service = new PushService(db, { available: false } as FcmService);
    await service.subscribe({
      tenantId: 't1',
      userId: 'u1',
      token: 'fcm-token-123',
      platform: 'fcm',
    });

    expect(upserts[0]).toMatchObject({ platform: 'fcm', token: 'fcm-token-123', p256dh: null });
  });
});
