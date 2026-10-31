import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import {
  expenseCategorySchema,
  expenseInputSchema,
  expenseUpdateSchema,
  type FinanceOverview,
  type FinancePeriod,
  financePeriodSchema,
  recurringExpenseSchema,
  recurringExpenseUpdateSchema,
} from '@partops/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { type Ctx, CurrentCtx, RequirePermissions } from '../../common/context.js';
import { todayIn } from '../../common/time.js';
import { ZodBody, ZodQuery } from '../../common/zod.js';
import { FinanceExportService } from './finance.export.js';
import { FinanceService } from './finance.service.js';

/**
 * Finanzas.
 *
 * Tres permisos con tres públicos distintos:
 *
 *  - `finance.view` — ve ventas y gastos. Es el mínimo para abrir la pantalla.
 *  - `finance.cost.view` — ve costo y utilidad. Sin él, los números de margen llegan en `null` y no
 *    en cero: un vendedor puede necesitar las ventas del día sin saber cuánto gana el negocio.
 *  - `finance.expenses.manage` — captura y borra gastos. Ver un gasto no es poder inventarlo.
 *
 * `finance.export` va aparte porque el archivo sale del sistema y se reenvía por correo: quien puede
 * mirar el reporte en pantalla no necesariamente debe poder sacar el margen de todo el año.
 */

/** Dos fechas opcionales. El rango se valida después, con el negocio y su zona ya resueltos. */
const periodQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inicial inválida')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha final inválida')
    .optional(),
});

const exportQuery = periodQuery.extend({
  format: z.enum(['csv', 'xlsx']).default('xlsx'),
});

const idParam = z.object({ id: z.string().uuid('Identificador inválido') });

@Controller('finance')
export class FinanceController {
  constructor(
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(FinanceExportService) private readonly exporter: FinanceExportService,
  ) {}

  /** Reporte completo del periodo. Por omisión, el mes en curso hasta hoy. */
  @Get()
  @RequirePermissions('finance.view')
  async overview(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(periodQuery) query: z.output<typeof periodQuery>,
  ): Promise<FinanceOverview> {
    return this.finance.overview(ctx, await this.resolvePeriod(ctx, query));
  }

  /**
   * Mismo reporte, en archivo.
   *
   * `csv` para abrir en Excel sin instalar nada; `xlsx` conserva formato, anchos y una hoja por
   * desglose. Los dos salen de la misma estructura que la pantalla: si el archivo dijera otro
   * número, quien lo manda por correo quedaría mal con su contador.
   */
  @Get('export')
  @RequirePermissions('finance.view', 'finance.export')
  async export(
    @CurrentCtx() ctx: Ctx,
    @ZodQuery(exportQuery) query: z.output<typeof exportQuery>,
    @Res() res: Response,
  ): Promise<void> {
    const period = await this.resolvePeriod(ctx, query);
    const data = await this.finance.overview(ctx, period);
    const file = await this.exporter.build(data, query.format);

    res.setHeader('content-type', file.contentType);
    res.setHeader('content-disposition', `attachment; filename="${file.filename}"`);
    // El reporte cambia con cada gasto capturado: cachearlo en el borde mostraría cifras viejas.
    res.setHeader('cache-control', 'no-store');
    res.send(file.body);
  }

  /** Recalcula el agregado diario del periodo. Idempotente: el botón se puede repetir. */
  @Post('rollup')
  @RequirePermissions('finance.view')
  @HttpCode(200)
  async rollup(@CurrentCtx() ctx: Ctx, @ZodQuery(periodQuery) query: z.output<typeof periodQuery>) {
    const period = query.from && query.to ? await this.resolvePeriod(ctx, query) : undefined;
    return this.finance.recompute(ctx, period);
  }

  // ───────────────────────────── Gastos ─────────────────────────────

  @Post('expenses')
  @RequirePermissions('finance.expenses.manage')
  addExpense(@CurrentCtx() ctx: Ctx, @ZodBody(expenseInputSchema) body: z.output<typeof expenseInputSchema>) {
    return this.finance.addExpense(ctx, body);
  }

  @Patch('expenses/:id')
  @RequirePermissions('finance.expenses.manage')
  updateExpense(
    @CurrentCtx() ctx: Ctx,
    @Param() params: z.output<typeof idParam>,
    @ZodBody(expenseUpdateSchema) body: z.output<typeof expenseUpdateSchema>,
  ) {
    return this.finance.updateExpense(ctx, params.id, body);
  }

  @Delete('expenses/:id')
  @RequirePermissions('finance.expenses.manage')
  @HttpCode(204)
  async removeExpense(@CurrentCtx() ctx: Ctx, @Param() params: z.output<typeof idParam>): Promise<void> {
    await this.finance.removeExpense(ctx, params.id);
  }

  @Post('categories')
  @RequirePermissions('finance.expenses.manage')
  addCategory(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(expenseCategorySchema) body: z.output<typeof expenseCategorySchema>,
  ) {
    return this.finance.addCategory(ctx, body.name);
  }

  @Delete('categories/:id')
  @RequirePermissions('finance.expenses.manage')
  @HttpCode(204)
  async removeCategory(@CurrentCtx() ctx: Ctx, @Param() params: z.output<typeof idParam>): Promise<void> {
    await this.finance.removeCategory(ctx, params.id);
  }

  // ───────────────────────────── Gastos fijos ─────────────────────────────

  @Post('recurring')
  @RequirePermissions('finance.expenses.manage')
  addRecurring(
    @CurrentCtx() ctx: Ctx,
    @ZodBody(recurringExpenseSchema) body: z.output<typeof recurringExpenseSchema>,
  ) {
    return this.finance.addRecurring(ctx, body);
  }

  @Patch('recurring/:id')
  @RequirePermissions('finance.expenses.manage')
  updateRecurring(
    @CurrentCtx() ctx: Ctx,
    @Param() params: z.output<typeof idParam>,
    @ZodBody(recurringExpenseUpdateSchema) body: z.output<typeof recurringExpenseUpdateSchema>,
  ) {
    return this.finance.updateRecurring(ctx, params.id, body);
  }

  @Delete('recurring/:id')
  @RequirePermissions('finance.expenses.manage')
  @HttpCode(204)
  async removeRecurring(@CurrentCtx() ctx: Ctx, @Param() params: z.output<typeof idParam>): Promise<void> {
    await this.finance.removeRecurring(ctx, params.id);
  }

  /**
   * Periodo efectivo.
   *
   * Sin rango: del primero del mes a hoy. El dueño abre Finanzas para ver "cómo va el mes", no "los
   * últimos 30 días", y el corte se hace en la zona del negocio: el día 1 a las 20:00 en Guatemala
   * ya es día 2 en UTC y el reporte empezaría un día tarde.
   */
  private async resolvePeriod(ctx: Ctx, query: { from?: string; to?: string }): Promise<FinancePeriod> {
    const timezone = await this.finance.timezoneOfTenant(ctx.tenant.tenantId);
    const today = todayIn(timezone);
    const candidate = {
      from: query.from ?? `${today.slice(0, 7)}-01`,
      to: query.to ?? today,
    };
    const parsed = financePeriodSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVALID_PERIOD',
        message: parsed.error.issues[0]?.message ?? 'Periodo inválido',
      });
    }
    return parsed.data;
  }
}
