import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import {
  type BaseClient,
  createBaseClient,
  type TenantClient,
  type TxOptions,
  tenantClient,
  tenantTx,
} from '@partops/db';
import { env } from '../config/env.js';

export const DB_CLIENT = Symbol('DB_CLIENT');

/**
 * El pool vive uno por proceso y se comparte.
 *
 * El tope de conexiones es deliberadamente bajo: Neon free tiene un límite duro y cada
 * transacción RLS ocupa una. Diez conexiones bien usadas atienden más que cien que esperan.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly client: BaseClient;

  constructor() {
    this.client = createBaseClient({
      connectionString: env.DATABASE_URL,
      maxConnections: env.PG_POOL_MAX,
      log: env.NODE_ENV === 'development' && process.env.DB_LOG === '1',
    });
  }

  /** Cliente con el tenant fijado. Todo acceso a datos de negocio pasa por aquí. */
  forTenant(tenantId: string): TenantClient {
    return tenantClient(this.client, tenantId);
  }

  /** Transacción interactiva con contexto RLS: ventas, reservas, importaciones. */
  tx<T>(tenantId: string, fn: Parameters<typeof tenantTx<T>>[2], options?: TxOptions) {
    return tenantTx(this.client, tenantId, fn, options);
  }

  /** Comprobación de salud: una consulta barata que además confirma que RLS está activo. */
  async ping(): Promise<{ ok: boolean; rls: boolean; latencyMs: number }> {
    const started = Date.now();
    try {
      const rows = await this.client.$queryRaw<{ rls: boolean }[]>`
        SELECT relrowsecurity AND relforcerowsecurity AS rls
        FROM pg_class WHERE relname = 'part'
      `;
      return { ok: true, rls: rows[0]?.rls ?? false, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, rls: false, latencyMs: Date.now() - started };
    }
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}

@Global()
@Module({
  providers: [DatabaseService, { provide: DB_CLIENT, useExisting: DatabaseService }],
  exports: [DatabaseService, DB_CLIENT],
})
export class DatabaseModule {}

export { Inject };
