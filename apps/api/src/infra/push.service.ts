import { Inject, Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';
import { env } from '../config/env.js';
import { DatabaseService } from './database.module.js';
import { FcmService } from './fcm.service.js';

/**
 * Avisos al teléfono cuando el socket no está.
 *
 * El orden importa: **primero el socket, después el push**. Un pedido nuevo que llega mientras el
 * bodeguero mira la pantalla aparece sin demora; el push es la red de seguridad para cuando la
 * pestaña está en segundo plano o la señal se cayó entre estanterías. Mandar push siempre gastaría
 * batería y cuota de notificaciones para algo que el usuario ya está viendo.
 *
 * Dos transportes, una sola tabla: `push_token.platform` dice por dónde sale cada fila.
 *
 *  - `web` → Web Push con VAPID. Funciona sin instalar nada, con la PWA abierta en Chrome.
 *  - `fcm` → Firebase, para el APK con la app **cerrada**. Web Push no despierta una app nativa.
 *
 * Cada transporte se apaga solo si le faltan sus llaves: un despliegue sin Firebase sigue avisando
 * al navegador, y uno sin VAPID sigue avisando al teléfono.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Ruta interna a abrir al tocar el aviso. */
  url?: string;
  /** Etiqueta: dos avisos del mismo pedido se reemplazan en vez de apilarse. */
  tag?: string;
  /** `true` vibra y suena: es lo que el bodeguero siente en el bolsillo. */
  urgent?: boolean;
}

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(FcmService) private readonly fcm: FcmService,
  ) {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const defaultSubject = `mailto:${env.MAIL_FROM.match(/<([^>]+)>/)?.[1] ?? 'partopsgt@gmail.com'}`;
    const subject = process.env.VAPID_SUBJECT?.trim() || defaultSubject;

    this.enabled = Boolean(publicKey && privateKey);
    if (this.enabled) {
      webpush.setVapidDetails(subject, publicKey as string, privateKey as string);
    }
  }

  get available(): boolean {
    return this.enabled || this.fcm.available;
  }

  /** Clave pública que el navegador necesita para suscribirse. `null` = avisos apagados. */
  get publicKey(): string | null {
    return this.available ? (process.env.VAPID_PUBLIC_KEY ?? null) : null;
  }

  /**
   * Guarda la suscripción del teléfono.
   *
   * `upsert` por `token`: el mismo navegador suscrito dos veces (el usuario volvió a conceder
   * permiso, o cambió de negocio) actualiza la fila en vez de acumular destinos que ya no existen.
   * Una tabla con endpoints muertos hace que cada pedido gaste medio segundo en un 410.
   */
  async subscribe(args: {
    tenantId: string;
    userId: string;
    token: string;
    platform?: 'web' | 'fcm';
    p256dh?: string | null;
    auth?: string | null;
    userAgent?: string | null;
  }) {
    const platform = args.platform ?? 'web';
    // Una fila `web` sin claves no puede entregarse nunca; una `fcm` no las usa. Se guardan como
    // nulas en ambos casos y se filtra al enviar, en vez de rechazar la suscripción y dejar al
    // bodeguero sin avisos.
    await this.db.system(async (tx) => {
      await tx.pushToken.upsert({
        where: { token: args.token },
        create: {
          tenantId: args.tenantId,
          userId: args.userId,
          token: args.token,
          platform,
          p256dh: args.p256dh ?? null,
          auth: args.auth ?? null,
          userAgent: args.userAgent?.slice(0, 300) ?? null,
        },
        update: {
          tenantId: args.tenantId,
          userId: args.userId,
          platform,
          p256dh: args.p256dh ?? null,
          auth: args.auth ?? null,
          userAgent: args.userAgent?.slice(0, 300) ?? null,
        },
      });
    });
  }

  /** Quitar el aviso de este aparato. Idempotente: dos toques no fallan. */
  async unsubscribe(token: string, userId?: string): Promise<void> {
    await this.db.system(async (tx) => {
      await tx.pushToken.deleteMany({ where: userId ? { token, userId } : { token } });
    });
  }

  /**
   * Manda a todos los aparatos de quienes despachan en esa bodega.
   *
   * Se resuelven los destinatarios por permiso y no por rol: un rol propio con `orders.dispatch`
   * tiene que recibir el aviso igual que el bodeguero de fábrica.
   */
  async notifyWarehouse(tenantId: string, warehouseId: string, payload: PushPayload): Promise<PushResult> {
    if (!this.available) return { sent: 0, failed: 0, removed: 0 };

    const recipients = await this.db.system(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ token: string; platform: string; p256dh: string | null; auth: string | null }>
      >`
        SELECT DISTINCT p."token", p."platform", p."p256dh", p."auth"
        FROM "push_token" p
        JOIN "member" m ON m."userId" = p."userId" AND m."tenantId" = p."tenantId" AND m."isActive"
        JOIN "role" r ON r."id" = m."roleId"
        WHERE p."tenantId" = ${tenantId}
          -- Sin bodegas asignadas = todas; con bodegas, solo quien cubre esa sucursal.
          AND (cardinality(m."warehouseIds") = 0 OR ${warehouseId} = ANY(m."warehouseIds"))
          AND (r."key" = 'propietario' OR r."permissions" @> ARRAY['orders.dispatch']::text[])`;
      return rows;
    });

    let sent = 0;
    let failed = 0;
    let removed = 0;

    await Promise.all(
      recipients.map(async (row) => {
        // Cada aparato sale por su transporte. Una fila `fcm` sin claves VAPID es normal; una `web`
        // sin ellas está rota y se salta sin marcar fallo, porque reintentar no la va a arreglar.
        if (row.platform === 'fcm') {
          if (!this.fcm.available) return;
          const outcome = await this.fcm.send(row.token, payload);
          if (outcome === 'ok') sent += 1;
          else if (outcome === 'gone') {
            removed += 1;
            await this.fcm.removeToken(row.token);
          } else failed += 1;
          return;
        }

        if (!this.enabled || !row.p256dh || !row.auth) return;
        try {
          await webpush.sendNotification(
            { endpoint: row.token, keys: { p256dh: row.p256dh, auth: row.auth } },
            JSON.stringify({ ...payload, at: new Date().toISOString() }),
            // 12 h: un aviso que llega mañana a la madrugada no le sirve a nadie.
            { TTL: 60 * 60 * 12, urgency: payload.urgent ? 'high' : 'normal' },
          );
          sent += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          // 404/410 = el navegador desinstaló la PWA o revocó el permiso. Se borra para no
          // reintentar contra un destino muerto en cada pedido.
          if (status === 404 || status === 410) {
            removed += 1;
            await this.unsubscribe(row.token);
            return;
          }
          failed += 1;
          this.logger.warn(`Fallo al enviar push (${status ?? 'sin estado'})`);
        }
      }),
    );

    return { sent, failed, removed };
  }
}
