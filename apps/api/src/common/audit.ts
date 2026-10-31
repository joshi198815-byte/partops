import type { TxClient } from '@partops/db';

export interface AuditEntry {
  tenantId: string;
  userId?: string | null;
  /** `team.member.role_changed`, `inventory.adjusted`, `order.cancelled`… verbo.entidad.acción. */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/**
 * Bitácora dentro de la misma transacción que el cambio.
 *
 * Si la escritura se revierte, la bitácora se revierte con ella: nunca queda un registro de algo
 * que no pasó, ni un cambio sin registro. Por eso recibe `tx` y no el cliente suelto.
 *
 * `before`/`after` se reducen a los campos que cambian; volcar la fila completa llena la tabla de
 * ruido y de datos personales que nadie consulta.
 */
export async function audit(tx: TxClient, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: entry.tenantId,
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: (entry.before ?? undefined) as never,
      after: (entry.after ?? undefined) as never,
      ip: entry.ip ?? null,
    },
  });
}

/** Diferencia campo a campo. Devuelve `undefined` si no cambió nada. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } | undefined {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]) && after[key] !== undefined) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : undefined;
}
