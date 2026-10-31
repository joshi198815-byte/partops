import { Controller, Get, Inject } from '@nestjs/common';
import { type AuditResponse, auditQuerySchema } from '@partops/contracts';
import type { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodQuery } from '../../common/zod.js';
import { AuditQueryService } from './audit.query.service.js';

/**
 * Bitácora de cambios.
 *
 * `audit.view` y no `team.manage`: quien audita no tiene por qué poder invitar ni despedir. Es el
 * permiso que se le da a un contador o a un socio que solo revisa.
 *
 * El detalle de `before`/`after` viaja en la lista porque son pocos campos por fila y abrir una
 * segunda llamada por renglón haría la pantalla lenta en una conexión de bodega. Si algún día una
 * entidad guarda un objeto grande, se recorta al escribir y no al leer.
 */
@Controller('audit')
export class AuditController {
  constructor(@Inject(AuditQueryService) private readonly audit: AuditQueryService) {}

  @Get()
  @RequirePermissions('audit.view')
  list(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(auditQuerySchema) query: z.output<typeof auditQuerySchema>,
  ): Promise<AuditResponse> {
    return this.audit.list(ctx, query);
  }
}
