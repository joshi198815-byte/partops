/**
 * Planes como dato.
 *
 * El precio y el tope viven en un solo lugar porque los lee medio producto: la página `/planes`,
 * el panel `/admin` y los candados de la API. Si la página dijera «2.000 piezas» y el candado
 * cortara en 500, el cliente tendría razón en enojarse y nosotros en no poder defenderlo.
 *
 * Lo que se cobra es solo lo que el código hace cumplir hoy. No hay pasarela de pago en v1: el
 * plan se concede desde `/admin` y se activa el mismo día que se cobra.
 */

import { PLAN_TIERS, type PlanTier } from './platform.js';

export interface PlanLimits {
  /** `null` = sin tope. */
  parts: number | null;
  members: number | null;
  importRowsPerFile: number | null;
  /** La vitrina `/c/<slug>` y su capacidad de recibir pedidos. */
  publicCatalog: boolean;
  /** Exportar ventas, gastos y catálogo a xlsx/csv. */
  exportData: boolean;
}

/** Las características que se venden como sí/no. Las numéricas usan `assertCanAdd*`. */
export type PlanFeature = 'publicCatalog' | 'exportData';

export interface PlanSpec {
  tier: PlanTier;
  name: string;
  /** Centavos de quetzal por mes. IVA incluido, como todo precio del producto. */
  priceCentsPerMonth: number;
  tagline: string;
  limits: PlanLimits;
  includes: readonly string[];
}

export const PLANS: Record<PlanTier, PlanSpec> = {
  FREE: {
    tier: 'FREE',
    name: 'Bodega',
    priceCentsPerMonth: 0,
    tagline: 'Para la bodega de una sola puerta que quiere dejar el Excel.',
    limits: {
      parts: 150,
      members: 2,
      importRowsPerFile: 300,
      publicCatalog: false,
      exportData: false,
    },
    includes: [
      'Catálogo con compatibilidad por vehículo',
      'Existencias por bodega, pasillo y estante',
      'Ventas, despacho con escáner y recibo con NIT',
      'Hasta 150 piezas y 2 usuarios',
      'Importar tu Excel de hasta 300 filas',
    ],
  },
  PRO: {
    tier: 'PRO',
    name: 'Mostrador',
    priceCentsPerMonth: 19_900,
    tagline: 'Para la bodega que vende por WhatsApp y quiere que el cliente consulte solo.',
    limits: {
      parts: 2_000,
      members: 6,
      importRowsPerFile: 5_000,
      publicCatalog: true,
      exportData: true,
    },
    includes: [
      'Todo lo del plan Bodega',
      'Hasta 2,000 piezas y 6 usuarios',
      'Catálogo público en tu propia dirección',
      'Importar Excel de hasta 5,000 filas',
      'Exportar ventas, gastos y catálogo',
      'Demanda no atendida: qué buscaron y no tenías',
    ],
  },
  TALLER: {
    tier: 'TALLER',
    name: 'Cadena',
    priceCentsPerMonth: 39_900,
    tagline: 'Para el negocio con varios roles y catálogo grande.',
    limits: {
      parts: null,
      members: 15,
      importRowsPerFile: 5_000,
      publicCatalog: true,
      exportData: true,
    },
    includes: [
      'Todo lo del plan Mostrador',
      'Piezas sin tope y 15 usuarios',
      'Roles propios con permisos a la medida',
      'Finanzas por vendedor y por forma de pago',
      'Soporte por WhatsApp el mismo día',
    ],
  },
};

/**
 * El precio de la cuenta multi-sucursal, cuando exista.
 *
 * No es un plan: no hay tier, no se puede conceder y el código no lo hace cumplir porque el modelo
 * todavía no separa catálogos por sucursal. Vive aquí como constante para que el número que se
 * anuncia en `/planes` sea el mismo que se cobrará, y para que no aparezca escrito a mano en dos
 * sitios que luego se contradicen.
 */
export const MULTI_LOCATION_PRICE_CENTS = 79_900;

/** Tier desconocido o nulo cae en FREE: un plan vencido nunca deja al negocio sin producto. */
export function planSpec(tier: string | null | undefined): PlanSpec {
  const found = PLAN_TIERS.find((t) => t === tier);
  return PLANS[found ?? 'FREE'];
}

const NEXT_TIER: Record<PlanTier, PlanTier | null> = {
  FREE: 'PRO',
  PRO: 'TALLER',
  TALLER: null,
};

/** El plan que sigue, o `null` si ya está en el tope. Para el mensaje del candado. */
export function nextPlan(tier: string | null | undefined): PlanSpec | null {
  const next = NEXT_TIER[planSpec(tier).tier];
  return next ? PLANS[next] : null;
}

const MONTHS = new Intl.NumberFormat('es-GT', { maximumFractionDigits: 0 });

/** «1,420 de 2,000 piezas» · «1,420 piezas · sin tope». Se usa tal cual en la pantalla. */
export function usageLabel(used: number, limit: number | null, unit: string): string {
  if (limit === null) return `${MONTHS.format(used)} ${unit} · sin tope`;
  return `${MONTHS.format(used)} de ${MONTHS.format(limit)} ${unit}`;
}
