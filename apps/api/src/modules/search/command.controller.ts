import { Controller, Get, Inject } from '@nestjs/common';
import { type CommandResponse, commandQuerySchema } from '@partops/contracts';
import type { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { ZodQuery } from '../../common/zod.js';
import { CommandService } from './command.service.js';

/**
 * Paleta de comandos.
 *
 * `catalog.view` como permiso mínimo: quien puede abrir el catálogo puede buscarlo, y sin él la
 * paleta no le sirve de nada. Las acciones que se ofrecen dentro se filtran aparte por permiso, así
 * que un vendedor no ve "Importar catálogo" aunque la ruta exista.
 */
@Controller('command')
export class CommandController {
  constructor(@Inject(CommandService) private readonly command: CommandService) {}

  @Get()
  @RequirePermissions('catalog.view')
  find(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(commandQuerySchema) query: z.output<typeof commandQuerySchema>,
  ): Promise<CommandResponse> {
    return this.command.find(ctx, query.q);
  }
}
