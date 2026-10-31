import { createSign } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from './database.module.js';
import type { PushPayload } from './push.service.js';

/**
 * FCM HTTP v1 sin `firebase-admin`.
 *
 * La librería oficial arrastra gRPC y un árbol de dependencias de decenas de megabytes para lo
 * único que aquí se necesita: firmar un JWT RS256, cambiarlo por un access token y hacer un `POST`.
 * Son cuarenta líneas con `node:crypto` y el contenedor no engorda.
 *
 * Sin las tres variables de entorno (`FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`) el
 * servicio se apaga solo. Un despliegue sin Firebase sigue despachando: pierde el aviso con la app
 * cerrada, nada más.
 */

export interface FcmMessage {
  message: {
    token: string;
    notification: { title: string; body: string };
    data: Record<string, string>;
    android: {
      priority: 'high' | 'normal';
      collapseKey?: string;
      notification: { channelId: string; sound: string; clickAction: string };
    };
  };
}

/** Tres horas de validez; Google rechaza más de una hora… salvo que el reloj del servidor vaya mal. */
const TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Construye el mensaje. Función pura: se prueba sin red ni credenciales, que es la mitad del
 * trabajo y la única que se puede probar en CI.
 *
 * `data` lleva el `url` **además** de la notificación: con la app cerrada Android pinta lo que trae
 * `notification`, pero al tocarlo el plugin entrega `data` a la app —y ahí es donde está la ruta
 * interna que hay que abrir. Sin duplicarlo, el aviso abre la app en la pantalla de inicio.
 */
export function buildMessage(token: string, payload: PushPayload): FcmMessage {
  return {
    message: {
      token,
      notification: { title: payload.title, body: payload.body },
      data: {
        ...(payload.url ? { url: payload.url } : {}),
        ...(payload.tag ? { tag: payload.tag } : {}),
      },
      android: {
        // `urgent` = el pedido ya está listo y alguien espera en el mostrador. Un aviso de prioridad
        // normal puede dormir en Doze hasta media hora, que es justo lo que no sirve.
        priority: payload.urgent ? 'high' : 'normal',
        ...(payload.tag ? { collapseKey: payload.tag } : {}),
        notification: {
          channelId: payload.urgent ? 'partops_pedidos' : 'partops_general',
          sound: 'default',
          // El plugin de push abre el intent principal; la ruta concreta la resuelve la app con
          // `data.url`. `clickAction` se deja vacío para no prometer un deep link que no existe.
          clickAction: '',
        },
      },
    },
  };
}

export type SendOutcome = 'ok' | 'gone' | 'failed';

@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private readonly projectId: string | null;
  private readonly clientEmail: string | null;
  private readonly privateKey: string | null;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {
    this.projectId = process.env.FCM_PROJECT_ID?.trim() || null;
    this.clientEmail = process.env.FCM_CLIENT_EMAIL?.trim() || null;
    // La llave en PEM viaja en una variable de entorno con `\n` literales: en un `.env` real no
    // caben saltos de línea. Se restauran aquí una sola vez.
    const raw = process.env.FCM_PRIVATE_KEY?.trim();
    this.privateKey = raw ? raw.replace(/\\n/g, '\n') : null;
  }

  get available(): boolean {
    return Boolean(this.projectId && this.clientEmail && this.privateKey);
  }

  /**
   * Envía un aviso.
   *
   * `gone` es una respuesta deliberada y no un fallo: Google dice «ese token ya no existe» cuando el
   * usuario desinstaló la app o borró los datos. Se devuelve así para que quien llama borre la fila
   * en vez de reintentar contra un destino muerto en cada pedido.
   */
  async send(token: string, payload: PushPayload): Promise<SendOutcome> {
    if (!this.available) return 'failed';

    try {
      const accessToken = await this.accessToken();
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildMessage(token, payload)),
      });

      if (res.ok) return 'ok';

      const body = (await res.text()).slice(0, 500);
      // 404 UNREGISTERED / 400 con INVALID_ARGUMENT sobre el token: el aparato ya no está.
      if (res.status === 404 || /UNREGISTERED|not a valid FCM registration/i.test(body)) {
        return 'gone';
      }
      this.logger.warn(`FCM ${res.status}: ${body}`);
      return 'failed';
    } catch (err) {
      this.logger.warn(`FCM sin respuesta: ${(err as Error).message}`);
      return 'failed';
    }
  }

  /** Borra los tokens muertos. Mismo criterio que el 410 de web-push. */
  async removeToken(token: string): Promise<void> {
    await this.db.system(async (tx) => {
      await tx.pushToken.deleteMany({ where: { token } });
    });
  }

  /**
   * Access token de Google, con caché.
   *
   * Se renueva cinco minutos antes de expirar: un token que vence a mitad de un lote de avisos hace
   * fallar el resto con 401, y el bodeguero se entera de que «no le llegó el pedido».
   */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 5 * 60_000 > now) return this.cached.token;

    const iat = Math.floor(now / 1000);
    const claims = {
      iss: this.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + TOKEN_TTL_SECONDS,
    };

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = base64url(JSON.stringify(claims));
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${body}`)
      .sign(this.privateKey as string, 'base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${body}.${signature}`,
      }),
    });

    if (!res.ok) throw new Error(`Google OAuth ${res.status}`);

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
    return data.access_token;
  }
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
