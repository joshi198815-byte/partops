import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DEFAULT_ROLES, inviteToken, isPermission, OWNER_ROLE, type Permission } from '@partops/contracts';
import type { TxClient } from '@partops/db';
import { AuthService } from '../../auth/auth.service.js';
import { audit, diff } from '../../common/audit.js';
import type { AuthUser, TenantContext } from '../../common/context.js';
import { DatabaseService } from '../../infra/database.module.js';
import { MailService } from '../../mail/mail.service.js';
import { PlanService } from '../plan/plan.service.js';

export interface TeamMemberView {
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  roleKey: string;
  roleName: string;
  warehouseIds: string[];
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/**
 * Equipo, roles e invitaciones.
 *
 * Reglas que este servicio sostiene, y que son la razón de que no se use el CRUD de
 * organizaciones de Better Auth:
 *
 *  - **Nunca se queda sin propietario.** Degradar, desactivar o quitar al último propietario
 *    dejaría el negocio sin quien pague, sin quien reparta permisos y sin salida: hay que
 *    escribirlo explícitamente en la base para recuperarlo. Se bloquea con un mensaje claro.
 *  - **Nadie se asciende a sí mismo.** Cambiar el rol propio está prohibido incluso al
 *    propietario, porque un clic equivocado en su propia fila le quita acceso a facturación sin
 *    que nadie se lo pueda devolver.
 *  - **Los roles de sistema no se editan.** `propietario` siempre tiene todo; los otros cuatro
 *    cambiarlos haría que dos negocios con el mismo rol se comporten distinto y que las recetas de
 *    permisos del producto dejen de aplicar. Se crean roles nuevos encima.
 *  - **Cada cambio deja bitácora y bota la caché de permisos.** Quitar una bodega surte efecto
 *    en el siguiente request, no en medio minuto.
 */
@Injectable()
export class TeamService {
  private readonly log = new Logger(TeamService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(PlanService) private readonly plan: PlanService,
  ) {}

  async list(tenant: TenantContext) {
    return this.db.tx(tenant.tenantId, async (tx) => {
      const [members, roles, invitations, warehouses] = await Promise.all([
        tx.member.findMany({
          orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            userId: true,
            warehouseIds: true,
            isActive: true,
            createdAt: true,
            role: { select: { key: true, name: true } },
            user: {
              select: { name: true, email: true, image: true, lastLoginAt: true },
            },
          },
        }),
        tx.role.findMany({
          orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
          select: { id: true, key: true, name: true, description: true, permissions: true, isSystem: true },
        }),
        tx.invitation.findMany({
          where: { status: 'PENDIENTE', expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            token: true,
            expiresAt: true,
            createdAt: true,
            roleId: true,
            invitedBy: { select: { name: true } },
          },
        }),
        tx.warehouse.findMany({
          where: { isActive: true },
          orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
          select: { id: true, code: true, name: true },
        }),
      ]);

      const roleById = new Map(roles.map((r) => [r.id, r]));
      const memberViews: TeamMemberView[] = members.map((m) => ({
        id: m.id,
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
        roleKey: m.role.key,
        roleName: m.role.name,
        warehouseIds: m.warehouseIds,
        isActive: m.isActive,
        lastLoginAt: m.user.lastLoginAt,
        createdAt: m.createdAt,
      }));

      return {
        members: memberViews,
        roles,
        warehouses,
        invitations: invitations.map((i) => ({
          id: i.id,
          email: i.email,
          // El token va al cliente porque es lo que arma el botón "copiar enlace"; quien puede
          // leerlo ya puede invitar, así que no revela nada nuevo.
          token: i.token,
          expiresAt: i.expiresAt,
          createdAt: i.createdAt,
          roleKey: roleById.get(i.roleId)?.key ?? '',
          roleName: roleById.get(i.roleId)?.name ?? '',
          invitedByName: i.invitedBy.name,
        })),
        // Cuántos propietarios activos hay: la web desactiva el botón de degradar cuando es 1.
        ownerCount: memberViews.filter((m) => m.isActive && m.roleKey === OWNER_ROLE).length,
      };
    });
  }

  async invite(
    tenant: TenantContext,
    user: AuthUser,
    input: { email: string; roleKey: string; warehouseIds: string[] },
  ) {
    const roleId = await this.db.tx(tenant.tenantId, async (tx) => {
      const role = await tx.role.findUnique({
        where: { tenantId_key: { tenantId: tenant.tenantId, key: input.roleKey } },
        select: { id: true },
      });
      if (!role) throw new BadRequestException({ code: 'ROLE_NOT_FOUND', message: 'Ese rol no existe' });

      const member = await tx.member.findFirst({
        where: { user: { email: input.email } },
        select: { id: true, isActive: true },
      });
      if (member?.isActive) {
        throw new ConflictException({
          code: 'ALREADY_MEMBER',
          message: 'Esa persona ya trabaja en tu negocio',
        });
      }

      const pending = await tx.invitation.findFirst({
        where: { email: input.email, status: 'PENDIENTE', expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (pending) {
        throw new ConflictException({
          code: 'INVITATION_PENDING',
          message: 'Ya hay una invitación pendiente para ese correo. Reenvíala desde la lista.',
        });
      }

      if (input.warehouseIds.length) {
        const valid = await tx.warehouse.count({ where: { id: { in: input.warehouseIds } } });
        if (valid !== input.warehouseIds.length) {
          throw new BadRequestException({
            code: 'WAREHOUSE_NOT_FOUND',
            message: 'Una de las bodegas elegidas no existe',
          });
        }
      }

      // Después de descartar duplicados: si la persona ya está o ya tiene enlace, ese es el
      // motivo que hay que decir, no un límite del plan que confunde.
      await this.plan.assertCanAddMember({ tenant }, tx);

      const invitation = await tx.invitation.create({
        data: {
          tenantId: tenant.tenantId,
          email: input.email,
          roleId: role.id,
          warehouseIds: input.warehouseIds,
          token: inviteToken(),
          invitedById: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        select: { id: true, token: true, expiresAt: true },
      });

      await audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'team.invited',
        entity: 'invitation',
        entityId: invitation.id,
        after: { email: input.email, roleKey: input.roleKey, warehouseIds: input.warehouseIds },
      });
      return { roleId: role.id, invitation };
    });

    const inviteUrl = `${process.env.WEB_APP_URL ?? 'http://localhost:3000'}/invitacion/${roleId.invitation.token}`;

    /**
     * `delivered` no es adorno: con `MAIL_PROVIDER=log` el correo no sale y la pantalla no puede
     * decir "enviada". El enlace se devuelve igual para que quien invita lo comparta a mano —el
     * botón "Copiar enlace" ya existe— y la persona no se quede esperando un correo que no va a
     * llegar.
     */
    let delivered = true;
    await this.mail
      .send(input.email, {
        template: 'invitation',
        url: inviteUrl,
        tenantName: tenant.tenantName,
        inviterName: user.name,
      })
      .catch((err) => {
        delivered = false;
        this.log.warn(`Invitación creada pero no enviada a ${input.email}: ${err}`);
      });

    return {
      id: roleId.invitation.id,
      email: input.email,
      expiresAt: roleId.invitation.expiresAt,
      delivered,
      url: inviteUrl,
    };
  }

  /** Reenvía el mismo token y correo. Cambiar el token rompería el enlace que ya se compartió. */
  async resendInvitation(tenant: TenantContext, user: AuthUser, invitationId: string) {
    const invitation = await this.db.tx(tenant.tenantId, async (tx) => {
      const found = await tx.invitation.findUnique({
        where: { id: invitationId },
        select: { id: true, email: true, token: true, status: true, expiresAt: true },
      });
      if (!found) throw new NotFoundException('Invitación no encontrada');
      if (found.status !== 'PENDIENTE') {
        throw new BadRequestException({ code: 'NOT_PENDING', message: 'Esa invitación ya se usó' });
      }
      // Si venció, se extiende: reenviar un enlace muerto es peor que no reenviar nada.
      if (found.expiresAt.getTime() < Date.now()) {
        await tx.invitation.update({
          where: { id: found.id },
          data: { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
        });
      }
      await audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'team.invitation_resent',
        entity: 'invitation',
        entityId: found.id,
        after: { email: found.email },
      });
      return found;
    });

    const url = `${process.env.WEB_APP_URL ?? 'http://localhost:3000'}/invitacion/${invitation.token}`;
    await this.mail.send(invitation.email, {
      template: 'invitation',
      url,
      tenantName: tenant.tenantName,
      inviterName: user.name,
    });
    return { ok: true, delivered: true, url };
  }

  async cancelInvitation(tenant: TenantContext, user: AuthUser, invitationId: string) {
    return this.db.tx(tenant.tenantId, async (tx) => {
      const found = await tx.invitation.findUnique({
        where: { id: invitationId },
        select: { id: true, email: true, status: true },
      });
      if (!found) throw new NotFoundException('Invitación no encontrada');
      if (found.status !== 'PENDIENTE') return { ok: true };
      await tx.invitation.update({ where: { id: found.id }, data: { status: 'CANCELADA' } });
      await audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'team.invitation_cancelled',
        entity: 'invitation',
        entityId: found.id,
        before: { email: found.email },
      });
      return { ok: true };
    });
  }

  async updateMember(
    tenant: TenantContext,
    user: AuthUser,
    memberId: string,
    input: { roleKey?: string; warehouseIds?: string[]; isActive?: boolean },
  ) {
    const affectedUserId = await this.db.tx(tenant.tenantId, async (tx) => {
      const member = await tx.member.findUnique({
        where: { id: memberId },
        select: {
          id: true,
          userId: true,
          roleId: true,
          warehouseIds: true,
          isActive: true,
          role: { select: { key: true } },
          user: { select: { name: true, email: true } },
        },
      });
      if (!member) throw new NotFoundException('Esa persona no está en tu equipo');

      if (member.userId === user.id && input.roleKey && input.roleKey !== member.role.key) {
        throw new ForbiddenException({
          code: 'CANNOT_CHANGE_OWN_ROLE',
          message: 'No puedes cambiar tu propio rol. Pídeselo a otro propietario.',
        });
      }
      if (member.userId === user.id && input.isActive === false) {
        throw new ForbiddenException({
          code: 'CANNOT_DISABLE_SELF',
          message: 'No puedes desactivar tu propia cuenta',
        });
      }

      const nextIsActive = input.isActive ?? member.isActive;
      const leavingOwner =
        member.role.key === OWNER_ROLE &&
        ((input.roleKey !== undefined && input.roleKey !== OWNER_ROLE) || !nextIsActive);
      if (leavingOwner) await this.assertNotLastOwner(tx, member.id);

      let roleId = member.roleId;
      if (input.roleKey && input.roleKey !== member.role.key) {
        const role = await tx.role.findUnique({
          where: { tenantId_key: { tenantId: tenant.tenantId, key: input.roleKey } },
          select: { id: true },
        });
        if (!role) throw new BadRequestException({ code: 'ROLE_NOT_FOUND', message: 'Ese rol no existe' });
        roleId = role.id;
      }

      if (input.warehouseIds) {
        const valid = await tx.warehouse.count({ where: { id: { in: input.warehouseIds } } });
        if (valid !== input.warehouseIds.length) {
          throw new BadRequestException({
            code: 'WAREHOUSE_NOT_FOUND',
            message: 'Una de las bodegas elegidas no existe',
          });
        }
      }

      const updated = await tx.member.update({
        where: { id: member.id },
        data: {
          roleId,
          warehouseIds: input.warehouseIds ?? undefined,
          isActive: input.isActive === undefined ? undefined : input.isActive,
        },
        select: { roleId: true, warehouseIds: true, isActive: true },
      });

      const changes = diff(
        { roleId: member.roleId, warehouseIds: member.warehouseIds, isActive: member.isActive },
        updated,
      );
      if (changes) {
        await audit(tx, {
          tenantId: tenant.tenantId,
          userId: user.id,
          action: input.isActive === false ? 'team.member_deactivated' : 'team.member_updated',
          entity: 'member',
          entityId: member.id,
          before: changes.before,
          after: { ...changes.after, email: member.user.email },
        });
      }
      return member.userId;
    });

    // Fuera de la transacción: invalida el rol cacheado para que el cambio aplique ya.
    this.auth.invalidateTenant(tenant.tenantId, affectedUserId);
    return { ok: true };
  }

  /**
   * Quitar a alguien del negocio. No borra la cuenta: la persona puede trabajar en otra bodega con
   * el mismo correo, y sus pedidos históricos siguen apuntando a su usuario.
   */
  async removeMember(tenant: TenantContext, user: AuthUser, memberId: string) {
    const removed = await this.db.tx(tenant.tenantId, async (tx) => {
      const member = await tx.member.findUnique({
        where: { id: memberId },
        select: {
          id: true,
          userId: true,
          role: { select: { key: true } },
          user: { select: { email: true } },
        },
      });
      if (!member) throw new NotFoundException('Esa persona no está en tu equipo');
      if (member.userId === user.id) {
        throw new ForbiddenException({
          code: 'CANNOT_REMOVE_SELF',
          message: 'Para salir del negocio, pídeselo a otro propietario',
        });
      }
      if (member.role.key === OWNER_ROLE) await this.assertNotLastOwner(tx, member.id);

      await tx.member.delete({ where: { id: member.id } });
      // Sus tokens de push dejan de valer: sin esto, el teléfono sigue recibiendo avisos de una
      // bodega a la que ya no pertenece.
      await tx.pushToken.deleteMany({ where: { userId: member.userId } });
      await audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'team.member_removed',
        entity: 'member',
        entityId: member.id,
        before: { email: member.user.email },
      });
      return member.userId;
    });

    this.auth.invalidateTenant(tenant.tenantId, removed);
    return { ok: true };
  }

  /** Rol propio: nombre, descripción y permisos. Los de sistema quedan protegidos. */
  async createRole(
    tenant: TenantContext,
    user: AuthUser,
    input: { name: string; description?: string; permissions: string[] },
  ) {
    const unknown = input.permissions.filter((p) => !isPermission(p));
    if (unknown.length) {
      throw new BadRequestException({
        code: 'UNKNOWN_PERMISSION',
        message: `Permisos desconocidos: ${unknown.join(', ')}`,
      });
    }

    return this.db.tx(tenant.tenantId, async (tx) => {
      const key = input.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
      if (!key || DEFAULT_ROLES.some((r) => r.key === key)) {
        throw new ConflictException({
          code: 'RESERVED_ROLE_KEY',
          message: 'Ese nombre choca con un rol del sistema. Usa otro.',
        });
      }

      const exists = await tx.role.findUnique({
        where: { tenantId_key: { tenantId: tenant.tenantId, key } },
        select: { id: true },
      });
      if (exists) {
        throw new ConflictException({ code: 'ROLE_EXISTS', message: 'Ya existe un rol con ese nombre' });
      }

      const role = await tx.role.create({
        data: {
          tenantId: tenant.tenantId,
          key,
          name: input.name,
          description: input.description,
          permissions: input.permissions as Permission[],
          isSystem: false,
        },
        select: { id: true, key: true, name: true },
      });
      await audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'team.role_created',
        entity: 'role',
        entityId: role.id,
        after: { key, permissions: input.permissions },
      });
      return role;
    });
  }

  async updateRole(
    tenant: TenantContext,
    user: AuthUser,
    roleId: string,
    input: { name?: string; description?: string; permissions?: string[] },
  ) {
    if (input.permissions) {
      const unknown = input.permissions.filter((p) => !isPermission(p));
      if (unknown.length) {
        throw new BadRequestException({
          code: 'UNKNOWN_PERMISSION',
          message: `Permisos desconocidos: ${unknown.join(', ')}`,
        });
      }
    }

    return this.db.tx(tenant.tenantId, async (tx) => {
      const role = await tx.role.findUnique({
        where: { id: roleId },
        select: { id: true, key: true, name: true, description: true, permissions: true, isSystem: true },
      });
      if (!role) throw new NotFoundException('Ese rol no existe');
      if (role.isSystem || role.key === OWNER_ROLE) {
        throw new ForbiddenException({
          code: 'SYSTEM_ROLE',
          message: 'Los roles base no se editan. Crea un rol propio con los permisos que necesites.',
        });
      }

      const updated = await tx.role.update({
        where: { id: role.id },
        data: {
          name: input.name,
          description: input.description,
          permissions: input.permissions as Permission[] | undefined,
        },
        select: { name: true, description: true, permissions: true },
      });

      const changes = diff(role, updated);
      if (changes) {
        await audit(tx, {
          tenantId: tenant.tenantId,
          userId: user.id,
          action: 'team.role_updated',
          entity: 'role',
          entityId: role.id,
          before: changes.before,
          after: changes.after,
        });
        // Quien tenga ese rol cambia de permisos en el acto, no en 30 s.
        this.auth.invalidateTenant(tenant.tenantId);
      }
      return updated;
    });
  }

  /** Borrar un rol exige reasignar a sus miembros antes: nunca dejar membresías sin rol. */
  async deleteRole(tenant: TenantContext, user: AuthUser, roleId: string, moveToRoleKey: string) {
    return this.db.tx(tenant.tenantId, async (tx) => {
      const role = await tx.role.findUnique({
        where: { id: roleId },
        select: { id: true, key: true, name: true, isSystem: true },
      });
      if (!role) throw new NotFoundException('Ese rol no existe');
      if (role.isSystem) {
        throw new ForbiddenException({ code: 'SYSTEM_ROLE', message: 'Los roles base no se eliminan' });
      }
      const target = await tx.role.findUnique({
        where: { tenantId_key: { tenantId: tenant.tenantId, key: moveToRoleKey } },
        select: { id: true },
      });
      if (!target) throw new BadRequestException({ code: 'ROLE_NOT_FOUND', message: 'Ese rol no existe' });
      if (target.id === role.id) {
        throw new BadRequestException({
          code: 'SAME_ROLE',
          message: 'Elige un rol distinto para mover al equipo',
        });
      }

      const moved = await tx.member.updateMany({
        where: { roleId: role.id },
        data: { roleId: target.id },
      });
      await tx.role.delete({ where: { id: role.id } });
      await audit(tx, {
        tenantId: tenant.tenantId,
        userId: user.id,
        action: 'team.role_deleted',
        entity: 'role',
        entityId: role.id,
        before: { key: role.key, name: role.name, membersMoved: moved.count },
      });
      this.auth.invalidateTenant(tenant.tenantId);
      return { ok: true, moved: moved.count };
    });
  }

  /**
   * El negocio siempre conserva al menos un propietario activo.
   *
   * Se cuenta dentro de la transacción con `FOR UPDATE` implícito del propio `update`: dos
   * propietarios degradándose a sí mismos a la vez —uno al otro— podrían pasar la comprobación
   * ambos y dejar cero. El lock de la fila del miembro objetivo serializa el caso real.
   */
  private async assertNotLastOwner(tx: TxClient, memberId: string) {
    await tx.$queryRaw`SELECT id FROM "member" WHERE id = ${memberId} FOR UPDATE`;
    const owners = await tx.member.count({
      where: { isActive: true, role: { key: OWNER_ROLE } },
    });
    if (owners <= 1) {
      throw new BadRequestException({
        code: 'LAST_OWNER',
        message: 'Tu negocio necesita al menos un propietario. Asigna ese rol a otra persona primero.',
      });
    }
  }
}
