import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_ROLES,
  inviteToken,
  type OnboardingState,
  OWNER_ROLE,
  suggestSlug,
} from '@partops/contracts';
import type { TxClient } from '@partops/db';
import { AuthService } from '../../auth/auth.service.js';
import { audit } from '../../common/audit.js';
import type { AuthUser, TenantContext } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { MailService } from '../../mail/mail.service.js';

export interface CreatedTenant {
  id: string;
  name: string;
  slug: string;
}

/**
 * Alta de un negocio en cuatro pasos.
 *
 * Por qué por pasos y no un formulario único: cada paso escribe algo que el siguiente necesita
 * (el negocio antes de la bodega, la bodega antes de invitar con acceso a ella) y el dueño puede
 * cerrar el navegador a la mitad. El estado se deduce de la base —no de una fila "progreso"— así
 * que no hay forma de que la pantalla diga "paso 3" cuando la bodega no existe.
 *
 * Todo lo de aquí corre con `system()`, porque todavía no hay tenant en el que fijar RLS: el
 * negocio se está creando. Es el único módulo con ese privilegio además del panel de plataforma.
 */
@Injectable()
export class OnboardingService {
  private readonly log = new Logger(OnboardingService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /**
   * Estado actual. Se calcula con dos consultas: membresía activa más antigua (el alta) y sus
   * bodegas/roles. Con eso se derivan los cuatro pasos.
   */
  async state(user: AuthUser): Promise<OnboardingState> {
    const member = await this.db.system((tx) =>
      tx.member.findFirst({
        where: { userId: user.id, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { tenantId: true, role: { select: { key: true } } },
      }),
    );

    if (!member) {
      return {
        steps: { business: false, warehouse: false, tax: false, team: false },
        nextStep: 'business',
        tenantId: null,
        tenantName: null,
        tenantSlug: null,
        nextPath: '/onboarding/negocio',
      };
    }

    const [tenant, warehouses, onboarded] = await this.db.tx(member.tenantId, (tx) =>
      Promise.all([
        tx.tenant.findUnique({
          where: { id: member.tenantId },
          select: { name: true, slug: true },
        }),
        tx.warehouse.count({ where: { isActive: true } }),
        //  El cierre del asistente se marca como evento, no como columna: es un hecho con fecha
        //  que ya pertenece a la bitácora y así no hay migración por un booleano.
        tx.auditLog.count({ where: { action: 'tenant.onboarded' } }),
      ]),
    );

    const steps = {
      business: Boolean(tenant),
      warehouse: warehouses > 0,
      // Si ya hay bodega, el paso de impuestos se dio por contestado (con los valores por defecto
      // si lo saltó). Marcarlo pendiente para siempre sería mentira.
      tax: warehouses > 0,
      team: onboarded > 0,
    };

    const nextStep = !steps.business
      ? 'business'
      : !steps.warehouse
        ? 'warehouse'
        : !steps.tax
          ? 'tax'
          : !steps.team
            ? 'team'
            : null;

    // La ruta vive aquí y no en la web: si el asistente cambia de pasos, el servidor es el único
    // que decide a dónde va el usuario y no hay dos listas que se desincronicen.
    const STEP_PATH: Record<NonNullable<typeof nextStep>, string> = {
      business: '/onboarding/negocio',
      warehouse: '/onboarding/bodega',
      tax: '/onboarding/impuestos',
      team: '/onboarding/equipo',
    };

    return {
      steps,
      nextStep,
      tenantId: member.tenantId,
      tenantName: tenant?.name ?? null,
      tenantSlug: tenant?.slug ?? null,
      nextPath: nextStep ? STEP_PATH[nextStep] : '/app',
    };
  }

  /**
   * Paso 1. Crea negocio + roles base + membresía de propietario en UNA transacción.
   *
   * Si algo falla (slug tomado, error de base), no queda un negocio huérfano ni un usuario con
   * membresía a medias: es exactamente el estado que obliga a limpiar a mano en producción.
   */
  async createBusiness(
    user: AuthUser,
    input: {
      name: string;
      slug?: string;
      legalName?: string;
      taxId?: string;
      phone?: string;
      whatsapp?: string;
      address?: string;
    },
  ): Promise<CreatedTenant> {
    const existing = await this.db.system((tx) =>
      tx.member.findFirst({
        where: { userId: user.id, isActive: true },
        select: { tenantId: true },
      }),
    );
    if (existing) {
      throw new ConflictException({
        code: 'ALREADY_ONBOARDED',
        message: 'Ya tienes un negocio configurado',
      });
    }

    const base = input.slug ?? suggestSlug(input.name);

    return this.db.system(async (tx) => {
      const slug = await this.freeSlug(tx, base);
      const tenant = await tx.tenant.create({
        data: {
          name: input.name,
          slug,
          legalName: input.legalName,
          taxId: input.taxId,
          phone: input.phone,
          whatsapp: input.whatsapp ?? input.phone,
          address: input.address,
          // El prefijo de pedido se deriva del nombre para que el primer recibo no diga "PD".
          orderPrefix: prefixFor(input.name),
        },
        select: { id: true, name: true, slug: true },
      });

      const roles = await this.createDefaultRoles(tx, tenant.id);
      const ownerRole = roles.get(OWNER_ROLE);
      if (!ownerRole) throw new Error('Rol de propietario no creado');

      await tx.member.create({
        data: { tenantId: tenant.id, userId: user.id, roleId: ownerRole, warehouseIds: [] },
      });

      await audit(tx, {
        tenantId: tenant.id,
        userId: user.id,
        action: 'tenant.created',
        entity: 'tenant',
        entityId: tenant.id,
        after: { name: tenant.name, slug: tenant.slug },
      });

      this.log.log(`Negocio ${tenant.slug} creado por ${user.id}`);
      return tenant;
    });
  }

  /**
   * Paso 2. Primera bodega, marcada como predeterminada.
   *
   * El código se autogenera si no lo dan: `B1`, `B2`… Un campo obligatorio más en el paso donde el
   * dueño solo quiere empezar a cargar piezas es fricción sin beneficio.
   */
  async createFirstWarehouse(
    tenant: TenantContext,
    user: AuthUser,
    input: { name: string; code?: string; address?: string; phone?: string; sellsOnline?: boolean },
  ) {
    return this.db.tx(tenant.tenantId, async (tx) => {
      const count = await tx.warehouse.count();
      if (count > 0) {
        throw new ConflictException({
          code: 'WAREHOUSE_EXISTS',
          message: 'Ya tienes una bodega; crea las demás desde Bodegas',
        });
      }
      const code = input.code ?? 'B1';
      const warehouse = await tx.warehouse.create({
        data: {
          tenantId: tenant.tenantId,
          code,
          name: input.name,
          address: input.address,
          phone: input.phone,
          isDefault: true,
          sellsOnline: input.sellsOnline ?? false,
        },
        select: { id: true, code: true, name: true },
      });

      await audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'warehouse.created',
        entity: 'warehouse',
        entityId: warehouse.id,
        after: { code, name: warehouse.name, isDefault: true },
      });
      return warehouse;
    });
  }

  /** Paso 3. Impuestos. Se guardan como puntos base para que 12 % sea `1200`, entero, sin flotantes. */
  async setTaxes(
    tenant: TenantContext,
    user: AuthUser,
    input: { pricesIncludeTax: boolean; taxRateBps: number },
  ) {
    return this.db.tx(tenant.tenantId, async (tx) => {
      const before = await tx.tenant.findUniqueOrThrow({
        where: { id: tenant.tenantId },
        select: { taxRateBps: true, pricesIncludeTax: true },
      });
      const updated = await tx.tenant.update({
        where: { id: tenant.tenantId },
        data: { taxRateBps: input.taxRateBps, pricesIncludeTax: input.pricesIncludeTax },
        select: { taxRateBps: true, pricesIncludeTax: true },
      });
      await audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'tenant.taxes_updated',
        entity: 'tenant',
        entityId: tenant.tenantId,
        before,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Paso 4. Invitaciones opcionales y cierre.
   *
   * No se exige invitar a nadie: una bodega de una sola persona es el caso más común y bloquearla
   * en "invita a tu equipo" sería absurdo. Sí se manda el correo de bienvenida al propietario,
   * que es el momento en que ya hay algo que ver.
   */
  async finish(
    tenant: TenantContext,
    user: AuthUser,
    input: { invites: Array<{ email: string; roleKey: string; name?: string }> },
  ) {
    const invited = input.invites.length
      ? await this.inviteMany(tenant, user, input.invites)
      : { invited: [] as string[], skipped: [] as Array<{ email: string; reason: string }> };

    // Marca de cierre del asistente. Sin esto, el paso 4 nunca se vería completo y la web volvería
    // a mostrar el asistente a un negocio que ya trabaja desde hace semanas.
    await this.db.tx(tenant.tenantId, (tx) =>
      audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'tenant.onboarded',
        entity: 'tenant',
        entityId: tenant.tenantId,
      }),
    );

    await this.mail.send(user.email, {
      template: 'welcome',
      tenantName: tenant.tenantName,
      appUrl: `${process.env.WEB_APP_URL ?? 'http://localhost:3000'}/app`,
    });

    return { ...invited, tenantSlug: tenant.tenantSlug };
  }

  /**
   * Invitaciones en lote dentro de una transacción. Los correos duplicados o ya miembros se
   * rechazan con el detalle de cuáles, en vez de fallar todo por uno: quien invita a cinco y uno
   * ya está dentro quiere que los otros cuatro reciban el correo.
   */
  async inviteMany(
    tenant: TenantContext,
    user: AuthUser,
    invites: Array<{ email: string; roleKey: string; name?: string }>,
  ) {
    const created = await this.db.tx(tenant.tenantId, async (tx) => {
      const roles = await tx.role.findMany({ select: { id: true, key: true } });
      const byKey = new Map(roles.map((r) => [r.key, r.id]));

      const emails = invites.map((i) => i.email);
      const already = await tx.member.findMany({
        where: { user: { email: { in: emails } } },
        select: { user: { select: { email: true } } },
      });
      const alreadySet = new Set(already.map((m) => m.user.email));

      const pending = await tx.invitation.findMany({
        where: { email: { in: emails }, status: 'PENDIENTE', expiresAt: { gt: new Date() } },
        select: { email: true },
      });
      const pendingSet = new Set(pending.map((p) => p.email));

      const result: Array<{ email: string; token: string; expiresAt: Date }> = [];
      const skipped: Array<{ email: string; reason: string }> = [];

      for (const invite of invites) {
        if (alreadySet.has(invite.email)) {
          skipped.push({ email: invite.email, reason: 'YA_ES_MIEMBRO' });
          continue;
        }
        if (pendingSet.has(invite.email)) {
          skipped.push({ email: invite.email, reason: 'INVITACION_PENDIENTE' });
          continue;
        }
        const roleId = byKey.get(invite.roleKey);
        if (!roleId) {
          // Un rol inventado en el payload no debe crear una membresía sin permisos: se reporta.
          skipped.push({ email: invite.email, reason: 'ROL_INEXISTENTE' });
          continue;
        }
        const token = inviteToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await tx.invitation.create({
          data: {
            tenantId: tenant.tenantId,
            email: invite.email,
            roleId,
            token,
            invitedById: user.id,
            expiresAt,
          },
        });
        await audit(tx, {
          tenantId: tenant.tenantId,
          userId: user.id,
          action: 'team.invited',
          entity: 'invitation',
          entityId: invite.email,
          after: { email: invite.email, roleKey: invite.roleKey },
        });
        result.push({ email: invite.email, token, expiresAt });
      }
      return { result, skipped };
    });

    // Los correos se mandan FUERA de la transacción: un SMTP lento no debe mantener abierta una
    // transacción con locks, y si el envío falla la invitación sigue siendo válida y reenviables.
    for (const invite of created.result) {
      await this.mail
        .send(invite.email, {
          template: 'invitation',
          url: `${process.env.WEB_APP_URL ?? 'http://localhost:3000'}/invitacion/${invite.token}`,
          tenantName: tenant.tenantName,
          inviterName: user.name,
        })
        .catch((err) => this.log.warn(`No se pudo enviar la invitación a ${invite.email}: ${err}`));
    }

    return { invited: created.result.map(({ email }) => email), skipped: created.skipped };
  }

  /** Vista previa pública de una invitación para pintar la pantalla antes de crear la cuenta. */
  async previewInvitation(token: string) {
    const invitation = await this.db.system((tx) =>
      tx.invitation.findUnique({
        where: { token },
        select: {
          email: true,
          status: true,
          expiresAt: true,
          tenant: { select: { name: true, slug: true, logoUrl: true } },
        },
      }),
    );
    if (!invitation) throw new NotFoundException('Esta invitación no existe');
    return { ...invitation, state: invitationState(invitation) };
  }

  /**
   * Canje. Se une al negocio con el rol y las bodegas de la invitación y marca el token como
   * usado. El correo de la invitación tiene que coincidir con el de la sesión: si no, alguien con
   * el enlace reenviado por WhatsApp podría entrar con su propia cuenta.
   */
  async acceptInvitation(user: AuthUser, token: string) {
    // La invitación llega por token, sin sesión de negocio: se busca con `system()` y a partir de
    // ahí todo ocurre dentro del tenant de la invitación.
    const invitation = await this.db.system((tx) =>
      tx.invitation.findUnique({
        where: { token },
        select: {
          id: true,
          tenantId: true,
          email: true,
          roleId: true,
          status: true,
          expiresAt: true,
          warehouseIds: true,
        },
      }),
    );
    if (!invitation) throw new NotFoundException('Esta invitación no existe');

    const state = invitationState(invitation);
    if (state !== 'VALIDA') {
      throw new BadRequestException({
        code: state,
        message:
          state === 'VENCIDA' ? 'Esta invitación venció. Pide una nueva.' : 'Esta invitación ya se usó.',
      });
    }
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenException({
        code: 'WRONG_EMAIL',
        message: `Esta invitación es para ${invitation.email}. Entra con ese correo.`,
      });
    }

    await this.db.tx(invitation.tenantId, async (tx) => {
      await tx.member.upsert({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId: user.id } },
        create: {
          tenantId: invitation.tenantId,
          userId: user.id,
          roleId: invitation.roleId,
          warehouseIds: invitation.warehouseIds,
        },
        update: { roleId: invitation.roleId, isActive: true, warehouseIds: invitation.warehouseIds },
      });
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACEPTADA' },
      });
      await audit(tx, {
        tenantId: invitation.tenantId,
        userId: user.id,
        action: 'team.invitation_accepted',
        entity: 'member',
        entityId: user.id,
        after: { email: user.email },
      });
    });

    this.auth.invalidateTenant(invitation.tenantId, user.id);
    return { tenantId: invitation.tenantId };
  }

  /** Rol del propietario y los cuatro roles base, con sus permisos como datos. */
  private async createDefaultRoles(tx: TxClient, tenantId: string) {
    const created = new Map<string, string>();
    for (const def of DEFAULT_ROLES) {
      const role = await tx.role.create({
        data: {
          tenantId,
          key: def.key,
          name: def.name,
          description: def.description,
          permissions: [...def.permissions],
          isSystem: true,
        },
        select: { id: true, key: true },
      });
      created.set(role.key, role.id);
    }
    return created;
  }

  /**
   * Slug libre entre `base`, `base-2`, `base-3`… Se consulta con `system()` porque la unicidad es
   * global. Diez intentos es de sobra: si diez negocios se llaman igual en el mismo minuto, el
   * nombre del negocio no es el problema.
   */
  private async freeSlug(tx: TxClient, base: string): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const slug = attempt === 0 ? base : `${base.slice(0, 36).replace(/-+$/g, '')}-${attempt + 1}`;
      const taken = await tx.tenant.findUnique({ where: { slug }, select: { id: true } });
      if (!taken) return slug;
    }
    // Fallback con sufijo aleatorio: nunca dejar al usuario atorado por el nombre que eligió.
    return `${base.slice(0, 31).replace(/-+$/g, '')}-${randomUUID().slice(0, 6)}`;
  }
}

/** Prefijo corto para números de pedido: `Repuestos El Tornillo` → `RET`. */
function prefixFor(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 1 && !['de', 'del', 'la', 'las', 'el', 'los', 'y'].includes(w.toLowerCase()));
  const acronym = words
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return acronym.length >= 2
    ? acronym
    : name
        .replace(/[^A-Za-z]/g, '')
        .slice(0, 3)
        .toUpperCase() || 'PD';
}

type InvitationState = 'VALIDA' | 'VENCIDA' | 'USADA';

function invitationState(inv: { status: string; expiresAt: Date }): InvitationState {
  if (inv.status !== 'PENDIENTE') return 'USADA';
  return inv.expiresAt.getTime() < Date.now() ? 'VENCIDA' : 'VALIDA';
}
