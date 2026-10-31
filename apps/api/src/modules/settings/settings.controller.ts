import { Controller, Get, Inject, Patch } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from '../../auth/auth.service.js';
import { audit, diff } from '../../common/audit.js';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodBody } from '../../common/zod.js';
import { DatabaseService } from '../../infra/database.module.js';

/**
 * Configuración del negocio.
 *
 * Solo cubre lo que ya existe en el modelo. El nombre se edita aquí y no en el alta porque
 * cambiarlo después es legítimo: una bodega se rebautiza o corrige una errata que ya salió en
 * recibos. El slug no se edita: es la dirección del catálogo y cambiarla rompe los enlaces que ya
 * se compartieron por WhatsApp — se decide una vez, en el alta.
 */
const FIELDS = {
  name: true,
  slug: true,
  legalName: true,
  taxId: true,
  phone: true,
  whatsapp: true,
  address: true,
  taxRateBps: true,
  pricesIncludeTax: true,
  catalogEnabled: true,
  catalogTagline: true,
} as const;

const patchSchema = z
  .object({
    name: z.string().trim().min(2, 'Escribe el nombre de tu negocio').max(80).optional(),
    legalName: z.string().trim().max(160).optional(),
    taxId: z.string().trim().max(12).optional(),
    phone: z.string().trim().max(20).optional(),
    whatsapp: z.string().trim().max(20).optional(),
    address: z.string().trim().max(240).optional(),
    pricesIncludeTax: z.boolean().optional(),
    taxRateBps: z.number().int().min(0).max(3000).optional(),
    catalogEnabled: z.boolean().optional(),
    /**
     * Frase corta de la vitrina. Cambiarla publica un catálogo distinto, así que se recorta y se
     * permite vaciarla (`null`) — una bodega que quitó su promo no debe quedarse con ella.
     */
    catalogTagline: z.string().trim().max(120, 'Máximo 120 caracteres').nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No hay cambios que guardar');

@Controller('settings')
export class SettingsController {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  @RequirePermissions('settings.manage')
  read(@CurrentCtx() ctx: Ctx) {
    return this.db.tx(ctx.tenant.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.tenantId }, select: FIELDS }),
    );
  }

  @Patch()
  @RequirePermissions('settings.manage')
  async update(@CurrentCtx() ctx: Ctx, @ZodBody(patchSchema) body: z.output<typeof patchSchema>) {
    const result = await this.db.tx(ctx.tenant.tenantId, async (tx) => {
      const before = await tx.tenant.findUniqueOrThrow({
        where: { id: ctx.tenant.tenantId },
        select: FIELDS,
      });

      const after = await tx.tenant.update({
        where: { id: ctx.tenant.tenantId },
        data: body,
        select: FIELDS,
      });

      const changes = diff(before, after);
      if (changes) {
        await audit(tx, {
          tenantId: ctx.tenant.tenantId,
          userId: ctx.user.id,
          action: 'tenant.settings_updated',
          entity: 'tenant',
          entityId: ctx.tenant.tenantId,
          before: changes.before,
          after: changes.after,
          ip: ctx.ip,
        });
      }
      return { after, changed: Boolean(changes) };
    });

    // El nombre y el slug se pintan en cada pantalla desde el contexto cacheado: 30 s con el
    // nombre viejo se leen como un error de la aplicación.
    if (result.changed) this.auth.invalidateTenant(ctx.tenant.tenantId);

    return result.after;
  }
}
