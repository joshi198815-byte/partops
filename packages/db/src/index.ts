import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Prisma, PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';
export { Prisma };

export interface CreateClientOptions {
  connectionString: string;
  maxConnections?: number;
  log?: boolean;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

export interface PoolStats {
  total: number;
  idle: number;
  active: number;
  waiting: number;
  max: number;
}

/**
 * Cliente base del pool. NO debe usarse para datos de negocio: solo para las tablas de auth
 * (que no llevan tenantId) y para trabajos de sistema explícitos.
 *
 * El tope de conexiones es bajo a propósito: Neon free da pocas y cada transacción RLS toma una.
 */
export function createBaseClient({
  connectionString,
  maxConnections = 10,
  log = false,
  connectionTimeoutMillis = 10_000,
  idleTimeoutMillis = 30_000,
}: CreateClientOptions) {
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    // pg espera para siempre por defecto: un pool saturado colgaría cada request hasta el timeout
    // del gateway. Mejor una petición fallida y rápido que mil colgadas.
    connectionTimeoutMillis,
    idleTimeoutMillis,
  });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  const client = new PrismaClient({
    adapter,
    log: log ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
  const $poolStats = (): PoolStats => ({
    total: pool.totalCount,
    idle: pool.idleCount,
    active: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount,
    max: maxConnections,
  });
  return Object.assign(client, { $poolStats });
}

export type BaseClient = ReturnType<typeof createBaseClient>;
export type TxClient = Prisma.TransactionClient;

export interface TxOptions {
  timeout?: number;
  maxWait?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/** 30 s para una transacción larga (importación por lote), 8 s para esperar una conexión. */
const DEFAULT_TX: TxOptions = { timeout: 30_000, maxWait: 8_000 };

/**
 * Envuelve CADA operación en una transacción corta que fija el contexto RLS antes de ejecutarla.
 *
 * Es lo que hace que un `findMany` olvidado de `where tenantId` no pueda filtrar datos ajenos:
 * la política `tenant_isolation` se aplica en la base con el `app.tenant_id` de esta transacción.
 */
function rlsExtension(base: BaseClient, key: 'app.tenant_id' | 'app.bypass_rls', value: string) {
  return base.$extends({
    name: `rls:${key}`,
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config(${key}, ${value}, TRUE)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export function tenantClient(base: BaseClient, tenantId: string) {
  if (!tenantId) throw new Error('tenantId requerido para tenantClient');
  return rlsExtension(base, 'app.tenant_id', tenantId);
}

/**
 * Cliente de sistema: ve todos los tenants. Solo para provisionamiento, cron global y el panel de
 * plataforma. Cualquier uso en un endpoint de negocio es un bug de aislamiento.
 */
export function systemClient(base: BaseClient) {
  return rlsExtension(base, 'app.bypass_rls', 'on');
}

export type TenantClient = ReturnType<typeof tenantClient>;

/**
 * Transacción interactiva con el tenant fijado. Es lo que se usa para vender: la reserva de stock,
 * la línea del pedido y el movimiento del ledger ocurren en la misma transacción o no ocurren.
 */
export async function tenantTx<T>(
  base: BaseClient,
  tenantId: string,
  fn: (tx: TxClient) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  if (!tenantId) throw new Error('tenantId requerido para tenantTx');
  return base.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, TRUE)`;
      return fn(tx);
    },
    { ...DEFAULT_TX, ...options },
  );
}

export async function systemTx<T>(
  base: BaseClient,
  fn: (tx: TxClient) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  return base.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
      return fn(tx);
    },
    { ...DEFAULT_TX, ...options },
  );
}
