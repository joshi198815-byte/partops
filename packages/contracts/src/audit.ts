import { z } from 'zod';

/**
 * Bitácora de auditoría.
 *
 * `audit()` ya escribe cada mutación sensible dentro de su transacción; esto es la otra mitad: poder
 * leerla. Sin pantalla, la bitácora era una tabla que solo crecía.
 *
 * Lo que se filtra y por qué:
 *
 *  - **Entidad y acción**, porque son las dos preguntas reales: «¿quién cambió precios?» es entidad
 *    `part_variant`; «¿quién canceló pedidos?» es acción `order.cancelled`.
 *  - **Actor**, porque cuando algo sale mal la primera hipótesis es una persona concreta.
 *  - **Fechas en la zona del negocio**, igual que finanzas: un cambio de las 19:00 de Guatemala es de
 *    hoy, no de mañana.
 *
 * No se filtra por el contenido de `before`/`after`: son `jsonb` y una búsqueda de texto sobre ellos
 * sería una consulta cara que nadie usa. Se abren en el detalle de la fila.
 */
export const auditQuerySchema = z
  .object({
    entity: z.string().trim().max(40).optional(),
    action: z.string().trim().max(80).optional(),
    actorId: z.string().max(64).optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inicial inválida')
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha final inválida')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'La fecha inicial va antes de la final',
    path: ['from'],
  });
export type AuditQuery = z.output<typeof auditQuerySchema>;

export interface AuditRow {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  /** ISO 8601 en UTC; la pantalla lo pinta en la zona del negocio. */
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
}

export interface AuditResponse {
  items: AuditRow[];
  total: number;
  /** Valores distintos del negocio, para poblar los selectores sin una llamada extra. */
  entities: string[];
  actions: string[];
}

/**
 * Texto legible de una acción (`finance.expense_created` → «Gasto registrado»).
 *
 * Se resuelve en el cliente y no en la base: la bitácora guarda el verbo técnico —estable, filtrable
 * y comparable entre versiones— y la traducción cambia con la interfaz sin migrar datos.
 */
const ACTION_LABEL: Record<string, string> = {
  // Negocio
  'tenant.created': 'Negocio creado',
  'tenant.onboarded': 'Negocio configurado',
  'tenant.settings_updated': 'Configuración del negocio actualizada',
  'tenant.taxes_updated': 'Impuestos actualizados',
  'warehouse.created': 'Bodega creada',
  // Equipo
  'team.invited': 'Invitación enviada',
  'team.invitation_accepted': 'Invitación aceptada',
  'team.invitation_cancelled': 'Invitación cancelada',
  'team.invitation_resent': 'Invitación reenviada',
  'team.member_removed': 'Miembro retirado',
  'team.role_created': 'Rol creado',
  'team.role_updated': 'Rol actualizado',
  'team.role_deleted': 'Rol eliminado',
  // Catálogo
  'catalog.category_created': 'Categoría creada',
  'catalog.part_created': 'Pieza creada',
  'catalog.part_updated': 'Pieza actualizada',
  'catalog.part_archived': 'Pieza archivada',
  'catalog.part_deleted': 'Pieza eliminada',
  'catalog.variant_created': 'Variante creada',
  'catalog.variant_updated': 'Variante actualizada',
  'catalog.variant_deactivated': 'Variante desactivada',
  'catalog.variant_deleted': 'Variante eliminada',
  'catalog.compatibility_added': 'Compatibilidad agregada',
  'catalog.compatibility_removed': 'Compatibilidad quitada',
  'catalog.image_added': 'Imagen agregada',
  'catalog.image_removed': 'Imagen quitada',
  'catalog.imported': 'Importación aplicada',
  // Inventario
  'inventory.adjusted': 'Existencia ajustada',
  'inventory.reorder_updated': 'Punto de reorden actualizado',
  'inventory.transfer_created': 'Traslado creado',
  'inventory.transfer_sent': 'Traslado enviado',
  'inventory.transfer_cancelled': 'Traslado cancelado',
  // Pedidos
  'orders.cancelled': 'Pedido cancelado',
  'orders.line_status_changed': 'Línea de pedido movida',
  'orders.payment_added': 'Pago registrado',
  // Finanzas
  'finance.category_created': 'Categoría de gasto creada',
  'finance.category_deleted': 'Categoría de gasto eliminada',
  'finance.expense_created': 'Gasto registrado',
  'finance.expense_updated': 'Gasto actualizado',
  'finance.expense_deleted': 'Gasto eliminado',
  'finance.recurring_created': 'Gasto fijo creado',
  'finance.recurring_updated': 'Gasto fijo actualizado',
  'finance.recurring_deleted': 'Gasto fijo eliminado',
  'finance.recurring_generated': 'Gasto fijo del mes generado',
  // Plataforma
  'platform.plan_granted': 'Plan concedido',
  'platform.tenant_suspended': 'Negocio suspendido',
  'platform.tenant_resumed': 'Negocio reactivado',
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** Entidad legible: `part_variant` → «Variante». La clave sigue siendo el identificador técnico. */
const ENTITY_LABEL: Record<string, string> = {
  tenant: 'Negocio',
  member: 'Miembro',
  role: 'Rol',
  invitation: 'Invitación',
  part: 'Pieza',
  part_variant: 'Variante',
  inventory_level: 'Existencia',
  stock_transfer: 'Traslado',
  sales_order: 'Pedido',
  expense: 'Gasto',
  recurring_expense: 'Gasto fijo',
  import_job: 'Importación',
};

export function entityLabel(entity: string): string {
  return ENTITY_LABEL[entity] ?? entity;
}
