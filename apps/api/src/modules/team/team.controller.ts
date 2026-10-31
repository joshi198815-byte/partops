import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { createRoleSchema, inviteMemberSchema, updateMemberSchema } from '@partops/contracts';
import { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodBody } from '../../common/zod.js';
import { TeamService } from './team.service.js';

/**
 * Borrar un rol exige decir a dónde se mueve la gente que lo tenía. Sin esto, el `delete` de
 * `role` fallará por la llave foránea y el usuario vería un error de base de datos en vez de una
 * decisión clara.
 */
const deleteRoleSchema = z.object({
  moveToRoleKey: z.string().trim().min(1, 'Elige el rol que tomará el equipo'),
});

const updateRoleSchema = createRoleSchema.partial();

/** Equipo y roles. Cada cambio exige `team.manage`; la lectura también, porque incluye correos. */
@Controller('team')
export class TeamController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Get()
  @RequirePermissions('team.manage')
  list(@CurrentCtx() ctx: Ctx) {
    return this.team.list(ctx.tenant);
  }

  @Post('invitations')
  @RequirePermissions('team.manage')
  @HttpCode(201)
  invite(@CurrentCtx() ctx: Ctx, @ZodBody(inviteMemberSchema) body: z.output<typeof inviteMemberSchema>) {
    return this.team.invite(ctx.tenant, ctx.user, body);
  }

  @Post('invitations/:id/resend')
  @RequirePermissions('team.manage')
  @HttpCode(200)
  resend(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.team.resendInvitation(ctx.tenant, ctx.user, id);
  }

  @Delete('invitations/:id')
  @RequirePermissions('team.manage')
  cancel(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.team.cancelInvitation(ctx.tenant, ctx.user, id);
  }

  @Patch('members/:id')
  @RequirePermissions('team.manage')
  updateMember(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(updateMemberSchema) body: z.output<typeof updateMemberSchema>,
  ) {
    return this.team.updateMember(ctx.tenant, ctx.user, id, body);
  }

  @Delete('members/:id')
  @RequirePermissions('team.manage')
  removeMember(@CurrentCtx() ctx: Ctx, @Param('id') id: string) {
    return this.team.removeMember(ctx.tenant, ctx.user, id);
  }

  @Post('roles')
  @RequirePermissions('team.manage')
  @HttpCode(201)
  createRole(@CurrentCtx() ctx: Ctx, @ZodBody(createRoleSchema) body: z.output<typeof createRoleSchema>) {
    return this.team.createRole(ctx.tenant, ctx.user, body);
  }

  @Patch('roles/:id')
  @RequirePermissions('team.manage')
  updateRole(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(updateRoleSchema) body: z.output<typeof updateRoleSchema>,
  ) {
    return this.team.updateRole(ctx.tenant, ctx.user, id, body);
  }

  @Delete('roles/:id')
  @RequirePermissions('team.manage')
  deleteRole(
    @CurrentCtx() ctx: Ctx,
    @Param('id') id: string,
    @ZodBody(deleteRoleSchema) body: z.output<typeof deleteRoleSchema>,
  ) {
    return this.team.deleteRole(ctx.tenant, ctx.user, id, body.moveToRoleKey);
  }
}
