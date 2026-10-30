/**
 * Permisos como datos, no como condicionales repartidos por el código.
 *
 * Cada permiso es una capacidad concreta. Los roles base son listas de permisos, así que un rol
 * propio (plan de pago) se crea guardando otra lista — sin tocar el servidor. `null` en las
 * guards significa "solo propietario": el permiso no se delega.
 */

export const PERMISSION_GROUPS = {
  dashboard: {
    label: 'Tablero',
    permissions: { 'dashboard.view': 'Ver tablero y métricas del día' } as const,
  },
  catalog: {
    label: 'Catálogo',
    permissions: {
      'catalog.view': 'Ver piezas y compatibilidades',
      'catalog.create': 'Crear piezas',
      'catalog.update': 'Editar piezas, precios y compatibilidades',
      'catalog.archive': 'Archivar piezas',
      'catalog.import': 'Importar desde Excel o CSV',
      'catalog.cost.view': 'Ver costo y margen',
      'catalog.export': 'Exportar catálogo',
    } as const,
  },
  inventory: {
    label: 'Inventario',
    permissions: {
      'inventory.view': 'Ver existencias por bodega',
      'inventory.adjust': 'Ajustar existencias con motivo',
      'inventory.transfer': 'Crear y recibir traslados entre bodegas',
      'inventory.count': 'Tomar inventario físico',
      'labels.print': 'Imprimir etiquetas de anaquel',
    } as const,
  },
  orders: {
    label: 'Ventas y despacho',
    permissions: {
      'orders.view': 'Ver pedidos',
      'orders.create': 'Crear pedidos y cotizar',
      'orders.dispatch': 'Preparar y despachar pedidos en bodega',
      'orders.price.override': 'Cambiar precio o aplicar descuento',
      'orders.cancel': 'Cancelar pedidos y liberar reservas',
      'orders.receipt.resend': 'Reenviar recibos',
    } as const,
  },
  warehouse: {
    label: 'Bodegas',
    permissions: {
      'warehouse.view': 'Ver bodegas y ubicaciones',
      'warehouse.manage': 'Crear y editar bodegas y pasillos',
    } as const,
  },
  customers: {
    label: 'Clientes',
    permissions: {
      'customers.view': 'Ver clientes e historial',
      'customers.manage': 'Crear y editar clientes',
    } as const,
  },
  finance: {
    label: 'Finanzas',
    permissions: {
      'finance.view': 'Ver ventas, costos y utilidad',
      'finance.expenses.manage': 'Registrar y editar gastos',
      'finance.export': 'Exportar reportes financieros',
      'finance.cost.view': 'Ver costo de compra',
    } as const,
  },
  demand: {
    label: 'Demanda',
    permissions: {
      'demand.view': 'Ver búsquedas sin existencia',
      'demand.watch.manage': 'Gestionar avisos de llegada de piezas',
    } as const,
  },
  settings: {
    label: 'Configuración',
    permissions: {
      'settings.manage': 'Configurar negocio, marca e impuestos',
      'team.manage': 'Gestionar equipo y roles',
      'audit.view': 'Ver bitácora de cambios',
      'billing.manage': 'Gestionar plan y facturación',
      'catalog.publish': 'Publicar el catálogo público',
    } as const,
  },
} as const;

type Groups = typeof PERMISSION_GROUPS;
export type Permission = {
  [G in keyof Groups]: keyof Groups[G]['permissions'];
}[keyof Groups];

export const ALL_PERMISSIONS = Object.values(PERMISSION_GROUPS).flatMap((g) =>
  Object.keys(g.permissions),
) as Permission[];

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export const OWNER_ROLE = 'propietario';

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}

const OPERATE: Permission[] = ['dashboard.view', 'catalog.view', 'inventory.view', 'warehouse.view'];

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    key: OWNER_ROLE,
    name: 'Propietario',
    description: 'Control total, incluida la suscripción. No se puede eliminar ni degradar.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'administrador',
    name: 'Administrador',
    description: 'Todo excepto facturación y roles propios.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'billing.manage'),
  },
  {
    key: 'gerente',
    name: 'Gerente',
    description: 'Dirige ventas y personal. Ve finanzas, no las edita en profundidad.',
    permissions: [
      ...OPERATE,
      'catalog.create',
      'catalog.update',
      'catalog.cost.view',
      'inventory.adjust',
      'inventory.transfer',
      'orders.view',
      'orders.create',
      'orders.cancel',
      'orders.price.override',
      'orders.receipt.resend',
      'customers.view',
      'customers.manage',
      'finance.view',
      'finance.cost.view',
      'demand.view',
      'demand.watch.manage',
      'labels.print',
    ],
  },
  {
    key: 'vendedor',
    name: 'Vendedor',
    description: 'Vende y consulta. No ajusta existencias ni ve costos.',
    permissions: [
      ...OPERATE,
      'orders.view',
      'orders.create',
      'orders.receipt.resend',
      'customers.view',
      'customers.manage',
      'demand.view',
    ],
  },
  {
    key: 'bodeguero',
    name: 'Bodeguero',
    description: 'Prepara y despacha pedidos. Ve y ajusta existencias de sus bodegas.',
    permissions: [
      ...OPERATE,
      'inventory.adjust',
      'inventory.transfer',
      'inventory.count',
      'labels.print',
      'orders.view',
      'orders.dispatch',
    ],
  },
];

/** Roles con sesgo operativo: si la persona tiene uno, su pantalla de arranque es la de su oficio. */
export function staffHomePath(roleKeys: readonly string[], permissions: readonly string[]): string {
  const perms = new Set(permissions);
  const canDispatch = perms.has('orders.dispatch');
  const canSell = perms.has('orders.create');
  const keys = new Set(roleKeys);

  if (keys.has(OWNER_ROLE)) return '/app';
  if (perms.has('dashboard.view') && (perms.has('finance.view') || perms.has('team.manage'))) {
    return '/app';
  }
  if (canDispatch && !canSell) return '/app/despacho';
  if (canSell && !perms.has('inventory.adjust')) return '/app/ventas';
  if (perms.has('inventory.adjust') && !canSell) return '/app/inventario';
  if (perms.has('dashboard.view')) return '/app';
  if (canDispatch) return '/app/despacho';
  if (canSell) return '/app/ventas';
  return '/app';
}
