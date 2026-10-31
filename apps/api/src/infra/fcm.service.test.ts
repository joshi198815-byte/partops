import { describe, expect, it } from 'vitest';
import { buildMessage } from './fcm.service.js';

/**
 * El mensaje FCM, sin red ni credenciales.
 *
 * Es la parte del push que se puede probar en CI, y la que más se rompe en silencio: un `data.url`
 * que falta no falla en el servidor —Google acepta el mensaje— y el aviso abre la app en la pantalla
 * de inicio en vez del pedido. Nadie lo nota hasta que el bodeguero toca una notificación y no pasa
 * nada.
 */
describe('FCM: construcción del mensaje', () => {
  it('lleva el enlace y la etiqueta que abrirán la app', () => {
    const msg = buildMessage('tok_1', {
      title: 'Pedido listo',
      body: 'PD-0042',
      url: '/app/despacho',
      tag: 'order-42',
    });

    expect(msg.message.token).toBe('tok_1');
    expect(msg.message.data.url).toBe('/app/despacho');
    expect(msg.message.android.collapseKey).toBe('order-42');
    expect(msg.message.data.tag).toBe('order-42');
  });

  it('un aviso urgente va por el canal de pedidos y con prioridad alta', () => {
    const msg = buildMessage('tok_2', {
      title: 'Pedido nuevo',
      body: 'Cliente en mostrador',
      urgent: true,
    });

    expect(msg.message.android.priority).toBe('high');
    // El canal se crea en la app; si el id no coincide, Android tira el aviso a «otras» y el
    // bodeguero no lo oye.
    expect(msg.message.android.notification.channelId).toBe('partops_pedidos');
  });

  it('sin urgencia usa prioridad normal y el canal general', () => {
    const msg = buildMessage('tok_3', { title: 'Resumen', body: 'Sin prisa' });
    expect(msg.message.android.priority).toBe('normal');
    expect(msg.message.android.notification.channelId).toBe('partops_general');
  });

  it('sin url no inventa una clave de datos vacía', () => {
    const msg = buildMessage('tok_4', { title: 'Aviso', body: 'Cuerpo' });
    expect(msg.message.data).toEqual({});
    expect(msg.message.android.collapseKey).toBeUndefined();
  });

  it('la notificación repite título y cuerpo: con la app cerrada Android no ejecuta JS', () => {
    const msg = buildMessage('tok_5', { title: 'Listo', body: 'PD-0007' });
    expect(msg.message.notification).toEqual({ title: 'Listo', body: 'PD-0007' });
  });
});
