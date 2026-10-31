import { z } from 'zod';

/**
 * Panel de plataforma (`/admin`).
 *
 * Es la vista del dueño de PartOps, no la de un negocio: lista todos los negocios, sus planes y el
 * estado de la cola de trabajos. Vive fuera de `/app` y fuera de RLS — cada consulta abre
 * `db.system` a propósito, porque su función es justamente ver a través de los negocios.
 *
 * Tres decisiones que se ven en la pantalla:
 *
 *  1. **El plan se concede a mano.** En v1 no hay pasarela de pago: el campo `tier` existe para
 *     saber qué se le prometió a cada negocio y cuándo vence, y para que suspender a quien no pagó
 *     sea una acción registrada y no un `UPDATE` en la base a las once de la noche.
 *  2. **La suspensión no borra nada.** Un negocio suspendido conserva sus datos y su historial; se
 *     le corta el acceso y se le puede reactivar el mismo día que paga.
 *  3. **Los trabajos se miran por estado y error.** Una cola con un `lastError` viejo es la señal
 *     más temprana de que algo se rompió en silencio: nadie llama para decir que el correo diario
 *     no salió.
 */
export interface AdminTenantRow {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  members: number;
  parts: number;
  /** Pedidos creados en los últimos 30 días. Mide uso, no facturación. */
  orders30d: number;
  planTier: string | null;
  /** ISO 8601. `null` = plan sin vencimiento. */
  planExpiresAt: string | null;
  createdAt: string;
  /** Último pedido o última búsqueda, lo que haya pasado después. */
  lastActivityAt: string | null;
}

export interface AdminJobRow {
  id: string;
  queue: string;
  status: string;
  runAt: string;
  attempts: number;
  lastError: string | null;
}

export interface AdminOverview {
  tenants: AdminTenantRow[];
  jobs: AdminJobRow[];
  demand: {
    searches30d: number;
    missed30d: number;
    topTerms: Array<{ term: string; count: number }>;
  };
  reference: { brands: number; models: number; vehicles: number };
}

export const PLAN_TIERS = ['FREE', 'PRO', 'TALLER'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const planGrantSchema = z
  .object({
    tier: z.enum(PLAN_TIERS),
    /** ISO 8601. `null` = sin vencimiento (cortesía, plan interno). */
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => !v.expiresAt || Date.parse(v.expiresAt) > Date.now(), {
    message: 'La fecha de vencimiento ya pasó',
    path: ['expiresAt'],
  });
export type PlanGrantInput = z.input<typeof planGrantSchema>;
export type PlanGrant = z.output<typeof planGrantSchema>;

/** `plan_grant.tier` es texto libre en la base; esto lo vuelve una etiqueta legible. */
export function planLabel(tier: string | null): string {
  if (!tier) return 'Sin plan';
  const found = PLAN_TIERS.find((t) => t === tier);
  return found ?? tier;
}

/** ¿El plan concedido sigue vigente hoy? Sin fecha, sí. */
export function planActive(expiresAt: string | null, now: Date = new Date()): boolean {
  return !expiresAt || Date.parse(expiresAt) > now.getTime();
}
