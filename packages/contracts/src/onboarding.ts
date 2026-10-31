import { z } from 'zod';
import { isReservedSlug, normalizeGtPhone, normalizeNit, slugify } from './identifiers.js';

/**
 * Esquemas de alta y equipo, compartidos por API y web.
 *
 * Un mismo esquema en los dos lados significa que el formulario marca el error antes de enviar y
 * el servidor responde exactamente lo mismo si alguien lo salta. Los mensajes están en español de
 * Guatemala porque los lee el dueño de la bodega, no un programador.
 */

/** Longitud en bytes UTF-8 sin depender de `TextEncoder` (que no está en el lib de Node). */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const passwordSchema = z
  .string()
  .min(8, 'Usa al menos 8 caracteres')
  .max(200, 'Máximo 200 caracteres')
  // Límite de bcrypt: más de 72 bytes se ignoran en silencio y el usuario cree tener una clave
  // más fuerte de la que realmente se guarda.
  .refine((v) => utf8Length(v) <= 72, 'La contraseña es demasiado larga');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Escribe un correo válido')
  .max(200, 'Máximo 200 caracteres');

export const phoneSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const normalized = normalizeGtPhone(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Escribe un teléfono de 8 dígitos' });
      return z.NEVER;
    }
    return normalized;
  });

export const optionalPhoneSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const normalized = normalizeGtPhone(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Escribe un teléfono de 8 dígitos o déjalo vacío' });
      return z.NEVER;
    }
    return normalized;
  })
  .optional();

export const nitSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const normalized = normalizeNit(v);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'El NIT tiene entre 6 y 12 caracteres' });
      return z.NEVER;
    }
    return normalized;
  })
  .optional();

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Solo minúsculas, números y guiones')
  .min(3, 'Al menos 3 caracteres')
  .max(40, 'Máximo 40 caracteres')
  .refine((v) => !isReservedSlug(v), 'Esa dirección está reservada');

/** El slug sugerido a partir del nombre; el usuario puede cambiarlo en el paso 1. */
export const suggestSlug = slugify;

// ───────────────────────────── Onboarding ─────────────────────────────

/**
 * Paso 1 — el negocio. Es lo único obligatorio para empezar a trabajar: nombre y dónde vende.
 * El NIT y el logo se pueden dejar para después; pedirlos aquí es fricción en el momento en que
 * el dueño solo quiere ver si la herramienta le sirve.
 */
export const onboardingBusinessSchema = z.object({
  name: z.string().trim().min(2, 'Escribe el nombre de tu negocio').max(80),
  slug: slugSchema.optional(),
  legalName: z.string().trim().max(160).optional(),
  taxId: nitSchema,
  phone: optionalPhoneSchema,
  whatsapp: optionalPhoneSchema,
  address: z.string().trim().max(240).optional(),
  /** Solo se aceptan monedas y países que el producto soporta hoy: fingir más rompe los reportes. */
  country: z.literal('GT').default('GT'),
  currency: z.literal('GTQ').default('GTQ'),
});

export type OnboardingBusinessInput = z.input<typeof onboardingBusinessSchema>;

/**
 * Paso 2 — la primera bodega. `code` es lo que el bodeguero grita en el pasillo ("está en W1"),
 * así que se limita a algo corto y sin espacios.
 */
export const onboardingWarehouseSchema = z.object({
  name: z.string().trim().min(2, 'Escribe el nombre de la bodega').max(80),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, 'De 1 a 6 letras o números, sin espacios')
    .optional(),
  address: z.string().trim().max(240).optional(),
  phone: optionalPhoneSchema,
  /** Vender en línea se decide al final; el catálogo público arranca apagado. */
  sellsOnline: z.boolean().default(false),
});

export type OnboardingWarehouseInput = z.input<typeof onboardingWarehouseSchema>;

/**
 * Paso 3 — impuestos. Se pregunta una sola vez y explícito, porque de esto depende que todos los
 * precios del sistema cuadren: si un negocio carga 12 % aparte y otro lo tiene incluido, un
 * reporte que asuma lo contrario miente por 12 % en cada venta.
 */
export const onboardingTaxSchema = z.object({
  pricesIncludeTax: z.boolean().default(true),
  taxRateBps: z.number().int().min(0).max(3000).default(1200),
});

export type OnboardingTaxInput = z.input<typeof onboardingTaxSchema>;

/** Paso 4 — invitar al equipo (opcional). Se puede saltar y hacer después desde Equipo. */
export const onboardingTeamSchema = z.object({
  invites: z
    .array(
      z.object({
        email: emailSchema,
        roleKey: z.string().trim().min(1),
        name: z.string().trim().max(80).optional(),
      }),
    )
    .max(10, 'Invita hasta 10 personas ahora; el resto, desde Equipo')
    .default([]),
});

export type OnboardingTeamInput = z.input<typeof onboardingTeamSchema>;

export const onboardingCompleteSchema = onboardingTeamSchema;

/** Vista del progreso: qué pasos ya están hechos y cuál sigue. */
export interface OnboardingState {
  steps: {
    business: boolean;
    warehouse: boolean;
    tax: boolean;
    team: boolean;
  };
  /** `null` cuando ya está completo. */
  nextStep: 'business' | 'warehouse' | 'tax' | 'team' | null;
  tenantId: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  /** Ruta a la que el cliente debe navegar. */
  nextPath: string;
}

// ───────────────────────────── Equipo ─────────────────────────────

export const inviteMemberSchema = z.object({
  email: emailSchema,
  roleKey: z.string().trim().min(1, 'Elige un rol'),
  /** Vacío = todas las bodegas. */
  warehouseIds: z.array(z.string().uuid()).max(50).default([]),
});

export type InviteMemberInput = z.input<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    roleKey: z.string().trim().min(1).optional(),
    warehouseIds: z.array(z.string().uuid()).max(50).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay cambios que guardar');

export type UpdateMemberInput = z.input<typeof updateMemberSchema>;

export const createRoleSchema = z.object({
  name: z.string().trim().min(2, 'Ponle nombre al rol').max(40),
  description: z.string().trim().max(160).optional(),
  permissions: z.array(z.string()).min(1, 'Elige al menos un permiso'),
});

export type CreateRoleInput = z.input<typeof createRoleSchema>;

/**
 * Canje. El nombre y la contraseña solo aplican cuando la cuenta se crea en el mismo paso; si la
 * persona ya tiene cuenta (o ya inició sesión), el cuerpo llega con el token y nada más. Por eso
 * son opcionales: la identidad que manda es la de la sesión, nunca la del cuerpo.
 */
export const acceptInvitationSchema = z.object({
  token: z.string().trim().min(8),
  name: z.string().trim().min(2, 'Escribe tu nombre').max(80).optional(),
  password: passwordSchema.optional(),
});

export type AcceptInvitationInput = z.input<typeof acceptInvitationSchema>;

/** Respuesta de `/api/me`: lo que la web necesita para pintar el shell sin más llamadas. */
export interface MeResponse {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    emailVerified: boolean;
    mustChangePassword: boolean;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
    role: string;
    permissions: string[];
    warehouseIds: string[];
  } | null;
  memberships: Array<{
    tenantId: string;
    tenantName: string;
    slug: string;
    logoUrl: string | null;
    role: string;
    roleName: string;
    suspended: boolean;
  }>;
  isPlatformAdmin: boolean;
  onboarding: OnboardingState | null;
  homePath: string;
}
