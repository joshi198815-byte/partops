import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@partops/contracts';
import type { Request } from 'express';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
  mustChangePassword: boolean;
  /**
   * Rol de plataforma (`admin`), no del negocio. Sin este campo el guard no puede distinguir al
   * dueño de PartOps de un cliente, y `@PlatformAdmin()` rechazaría siempre.
   */
  role?: string | null;
}

export interface TenantContext {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: string;
  permissions: Set<Permission>;
  /** Bodegas asignadas. Vacío = todas (propietario y administrador). */
  warehouseIds: string[];
}

export interface RequestContext {
  user: AuthUser;
  sessionId: string;
  activeTenantId?: string | null;
  tenant?: TenantContext;
  ip?: string;
  userAgent?: string;
}

export type AuthedRequest = Request & { ctx?: RequestContext };

export interface Ctx extends RequestContext {
  tenant: TenantContext;
}

/** Inyecta el contexto autenticado. `tenant` está garantizado cuando la ruta no es `@NoTenant()`. */
export const CurrentCtx = createParamDecorator((_: unknown, context: ExecutionContext): Ctx => {
  const req = context.switchToHttp().getRequest<AuthedRequest>();
  return req.ctx as Ctx;
});

export const IS_PUBLIC = 'po:public';
export const NO_TENANT = 'po:no-tenant';
export const PERMISSIONS = 'po:permissions';
export const PLATFORM_ADMIN = 'po:platform-admin';
export const PENDING_PASSWORD_OK = 'po:pending-password-ok';

/** Ruta sin sesión (catálogo público, webhooks, salud, recibo por token). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Requiere sesión pero no negocio activo (onboarding, /me, elegir negocio). */
export const NoTenant = () => SetMetadata(NO_TENANT, true);
/** Exige todos los permisos listados en el negocio activo. */
export const RequirePermissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS, perms);
/** Solo administradores de plataforma (panel interno). */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN, true);
/**
 * Accesible con una contraseña temporal sin cambiar (p. ej. `/me`, el estado del onboarding y la
 * pantalla de cambio). Todo lo demás queda bloqueado por el guard.
 */
export const AllowPendingPassword = () => SetMetadata(PENDING_PASSWORD_OK, true);

/** ¿El usuario tiene acceso a esta bodega? Lista vacía = todas. */
export function canAccessWarehouse(tenant: TenantContext, warehouseId: string): boolean {
  return tenant.warehouseIds.length === 0 || tenant.warehouseIds.includes(warehouseId);
}
