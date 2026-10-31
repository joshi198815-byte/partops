'use client';

import type {
  DispatchOp,
  DispatchOpResult,
  DispatchQueueResponse,
  DispatchSyncResponse,
} from '@partops/contracts';

/**
 * Cola de despacho en el teléfono.
 *
 * La bodega no tiene señal. El bodeguero escanea una pieza en el pasillo C y el servidor no
 * responde; si el cambio se pierde, él vuelve a tocar y el inventario se descuadra, o peor, deja de
 * confiar en la pantalla y anota en papel. Esta cola guarda la operación en IndexedDB —no en
 * memoria, porque el navegador del teléfono se cierra solo— y la reintenta al recuperar la red.
 *
 * Dos invariantes:
 *
 *  1. **`opId` se genera al encolar, no al enviar.** Si se generara al enviar, el reintento después
 *     de un timeout sería una operación nueva para el servidor y descontaría la pieza otra vez.
 *  2. **La última intención gana.** Si la misma línea se marcó listo y luego "no está", se envía
 *     solo lo último: mandar el histórico haría que el orden de llegada decidiera el resultado.
 */

const DB_NAME = 'partops-despacho';
const DB_VERSION = 1;
const OPS = 'ops';
const CACHE = 'cache';

export interface QueuedOp extends DispatchOp {
  /** ISO del momento en que se tocó el botón. Se muestra como "hace 3 min sin enviar". */
  queuedAt: string;
  attempts: number;
  lastError: string | null;
}

export interface CachedQueue {
  key: string;
  value: DispatchQueueResponse;
  savedAt: string;
}

interface OutboxDb {
  ops: {
    toArray(): Promise<QueuedOp[]>;
    put(op: QueuedOp): Promise<unknown>;
    delete(opId: string): Promise<unknown>;
    clear(): Promise<void>;
    count(): Promise<number>;
  };
  cache: {
    put(row: CachedQueue): Promise<unknown>;
    get(key: string): Promise<CachedQueue | undefined>;
  };
}

let dbPromise: Promise<OutboxDb> | null = null;

/**
 * Dexie se carga en el navegador, nunca en el servidor: `indexedDB` no existe en Node y un import
 * estático rompería el render del servidor de Next.
 */
async function db(): Promise<OutboxDb | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return null;
  if (!dbPromise) {
    dbPromise = (async () => {
      const { default: Dexie } = await import('dexie');
      const instance = new Dexie(DB_NAME);
      instance.version(DB_VERSION).stores({
        // `opId` es la clave: reencolar la misma operación la reemplaza, no la duplica.
        [OPS]: 'opId, queuedAt',
        [CACHE]: 'key',
      });
      return instance as unknown as OutboxDb;
    })();
  }
  return dbPromise;
}

/** Identidad de la operación. `randomUUID` no existe en contextos no seguros (http en LAN). */
export function newOpId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Formato UUID v4 a mano: el servidor valida con `z.string().uuid()`.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function enqueue(op: DispatchOp): Promise<QueuedOp> {
  const row: QueuedOp = { ...op, queuedAt: new Date().toISOString(), attempts: 0, lastError: null };
  const store = await db();
  if (!store) return row;
  await store.ops.put(row);
  return row;
}

export async function pendingOps(): Promise<QueuedOp[]> {
  const store = await db();
  if (!store) return [];
  const rows = await store.ops.toArray();
  return rows.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function pendingCount(): Promise<number> {
  const store = await db();
  if (!store) return 0;
  return store.ops.count();
}

export async function clearOps(): Promise<void> {
  const store = await db();
  if (!store) return;
  await store.ops.clear();
}

/**
 * Manda lo pendiente.
 *
 * El servidor compacta el lote otra vez, pero aquí ya se deja una sola operación por línea: si el
 * teléfono estuvo una hora sin señal, no tiene sentido enviar cinco estados de la misma pieza por
 * una red que apenas alcanza para uno.
 *
 * Solo se borran las operaciones que el servidor aceptó (aplicada o repetida). Un rechazo se
 * conserva marcado: la pantalla lo muestra y el bodeguero decide, en vez de que desaparezca en
 * silencio un "no está" que sí importaba.
 */
export async function flush(): Promise<{
  sent: number;
  rejected: DispatchOpResult[];
  queue: DispatchQueueResponse | null;
}> {
  const store = await db();
  const rows = await pendingOps();
  if (!rows.length) return { sent: 0, rejected: [], queue: null };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { sent: 0, rejected: [], queue: null };
  }

  const latest = new Map<string, QueuedOp>();
  for (const row of rows) latest.set(`${row.orderId}:${row.itemId}`, row);
  const batch = [...latest.values()];

  const response = await fetch('/api/dispatch/sync', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ops: batch.map(({ opId, orderId, itemId, status, scannedCode }) => ({
        opId,
        orderId,
        itemId,
        status,
        scannedCode: scannedCode ?? null,
      })),
    }),
  });

  if (!response.ok) {
    // Se queda todo en la cola y se anota el intento: la pantalla dice "sin enviar", no "listo".
    for (const row of batch) {
      await store?.ops.put({ ...row, attempts: row.attempts + 1, lastError: `HTTP ${response.status}` });
    }
    throw new Error(`No se pudo sincronizar (${response.status})`);
  }

  const data = (await response.json()) as DispatchSyncResponse;
  for (const result of data.results) {
    if (result.outcome === 'RECHAZADO') {
      const row = latest.get(`${result.orderId}:${result.itemId}`);
      if (row) {
        await store?.ops.put({
          ...row,
          attempts: row.attempts + 1,
          lastError: result.message ?? 'Rechazado',
        });
      }
      continue;
    }
    await store?.ops.delete(result.opId);
  }

  await cacheQueue(data.queue);
  return {
    sent: data.results.filter((r) => r.outcome !== 'RECHAZADO').length,
    rejected: data.results.filter((r) => r.outcome === 'RECHAZADO'),
    queue: data.queue,
  };
}

/** Última cola vista. Es lo que se pinta al abrir sin señal: la lista de hace un minuto sirve. */
export async function cacheQueue(queue: DispatchQueueResponse): Promise<void> {
  const store = await db();
  if (!store) return;
  await store.cache.put({ key: 'queue', value: queue, savedAt: new Date().toISOString() });
}

export async function readCachedQueue(): Promise<{ queue: DispatchQueueResponse; savedAt: string } | null> {
  const store = await db();
  if (!store) return null;
  const row = await store.cache.get('queue');
  return row ? { queue: row.value, savedAt: row.savedAt } : null;
}
