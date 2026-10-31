import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TxClient } from '@partops/db';
import { env } from '../../config/env.js';
import { DatabaseService } from '../../infra/database.module.js';

/**
 * Antibots del catálogo público.
 *
 * Dos capas, porque ninguna basta sola:
 *
 *  - **Turnstile** frena el script que rellena el formulario en bucle. Se verifica en el servidor;
 *    el token que llega del navegador no prueba nada por sí mismo.
 *  - **Contador por IP** frena lo que Turnstile no ve: alguien pidiendo a mano cien veces, o un
 *    token reutilizado. El conteo vive en Postgres y no en memoria porque Render reinicia el
 *    proceso y cada instancia tendría su propio contador —justo cuando el abuso importa.
 *
 * La IP no se guarda: se guarda `sha256(secreto + ip)`. Sirve para contar y bloquear, y no se
 * puede revertir a la dirección de una persona si la base se filtra.
 */

export const PUBLIC_SCOPES = {
  /** Pedidos por IP: seis por hora deja comprar a una familia y corta el guion de spam. */
  PEDIDO: { limit: 6, windowMs: 60 * 60_000 },
  /** Búsquedas por IP: cuarenta por minuto es navegar; más es rastrear el catálogo. */
  BUSQUEDA: { limit: 40, windowMs: 60_000 },
  /** Avisos de llegada por IP: diez cada diez minutos son diez piezas de verdad. */
  AVISO: { limit: 10, windowMs: 10 * 60_000 },
} as const;

export type PublicScope = keyof typeof PUBLIC_SCOPES;

@Injectable()
export class PublicGuardService {
  private readonly log = new Logger(PublicGuardService.name);

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** Hash estable por instalación. Sin el secreto, un hash de IP es reversible por diccionario. */
  keyFor(ip: string | undefined): string {
    const salt = env.TURNSTILE_SECRET_KEY ?? env.BETTER_AUTH_SECRET;
    return createHash('sha256')
      .update(`${salt}:${ip ?? 'sin-ip'}`)
      .digest('base64url')
      .slice(0, 32);
  }

  /**
   * Cuenta el intento y devuelve si queda dentro del presupuesto.
   *
   * Se cuenta ANTES de comprobar, no después: si se comprobara primero y se registrara al final,
   * una petición que falla a mitad no contaría y el atacante podría fallar gratis para siempre.
   */
  async hit(key: string, scope: PublicScope, tenantId: string | null): Promise<boolean> {
    const { limit, windowMs } = PUBLIC_SCOPES[scope];
    return this.db.system(async (tx) => {
      const [row] = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM "public_hit"
        WHERE "key" = ${key} AND "scope" = ${scope}
          AND "createdAt" > now() - make_interval(secs => ${windowMs / 1000})`;
      if (Number(row?.count ?? 0) >= limit) return false;
      await tx.publicHit.create({ data: { key, scope, tenantId } });
      return true;
    });
  }

  /**
   * Verifica el token de Turnstile.
   *
   * Sin `TURNSTILE_SECRET_KEY` (desarrollo, o un negocio que aún no lo configuró) no se exige: el
   * catálogo tiene que funcionar el primer día, y el rate limit sigue activo. En producción la
   * variable existe y el token pasa a ser obligatorio.
   */
  async verifyTurnstile(
    token: string | undefined,
    ip: string | undefined,
  ): Promise<{ ok: boolean; required: boolean; code?: string }> {
    if (!env.TURNSTILE_SECRET_KEY) return { ok: true, required: false };
    if (!token) return { ok: false, required: true, code: 'TURNSTILE_MISSING' };
    try {
      const body = new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      });
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(6_000),
      });
      const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
      if (data.success) return { ok: true, required: true };
      this.log.warn(`Turnstile rechazó un token: ${(data['error-codes'] ?? []).join(',')}`);
      return { ok: false, required: true, code: 'TURNSTILE_FAILED' };
    } catch (err) {
      // Cloudflare caído no puede tumbar la vitrina: se deja pasar y queda el rate limit. Es la
      // misma decisión que un captcha que no carga, y el pedido igual entra a la cola de bodega
      // donde alguien lo revisa antes de prepararlo.
      this.log.warn(`No se pudo verificar Turnstile: ${(err as Error).message}`);
      return { ok: true, required: true };
    }
  }

  /** El sitio público de Turnstile, para que la web pinte el widget. `null` si no está activo. */
  get siteKey(): string | null {
    // Se exigen las dos: con el secreto sin la clave del sitio, el widget no se pinta y el pedido
    // se rechazaría en el servidor sin que el cliente pueda resolver el captcha.
    if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) return null;
    return env.TURNSTILE_SITE_KEY;
  }

  /**
   * Purga de contadores viejos.
   *
   * Se llama desde el barrido del catálogo. Sin esto la tabla crece para siempre y la consulta de
   * conteo —que corre en cada pedido— se vuelve lentamente más cara cada mes.
   */
  async purgeOlderThan(days = 2): Promise<number> {
    const deleted = await this.db.system(
      (tx) =>
        tx.$executeRaw`DELETE FROM "public_hit" WHERE "createdAt" < now() - make_interval(days => ${days})`,
    );
    return Number(deleted);
  }
}

/** Helper para que el servicio público no tenga que abrir su propia transacción dos veces. */
export type PublicTx = TxClient;
