import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Body validado con Zod, ya tipado y transformado.
 *
 * Nest ejecuta la decoración antes de entrar al handler: si el dato no cumple el esquema, el
 * servicio nunca ve basura a medio validar. Se evita class-validator porque obligaría a mantener
 * dos descripciones del mismo dato; los esquemas de `@partops/contracts` (y los locales) son la
 * única fuente de verdad.
 */
export const ZodBody = <S extends z.ZodType>(schema: S) =>
  createParamDecorator((_: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ body: unknown }>();
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      // Se devuelven todas las fallas con su ruta: el formulario puede marcar cada campo en vez de
      // mostrar un "datos inválidos" genérico que obligue a adivinar.
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.') || '(raíz)',
        message: i.message,
      }));
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: issues[0]?.message ?? 'Datos inválidos',
        issues,
      });
    }
    return result.data as z.output<S>;
  })();

/** Query validada: los filtros de listados llegan como texto y necesitan coerción. */
export const ZodQuery = <S extends z.ZodType>(schema: S) =>
  createParamDecorator((_: unknown, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ query: unknown }>();
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.') || '(raíz)',
        message: i.message,
      }));
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: issues[0]?.message ?? 'Filtros inválidos',
        issues,
      });
    }
    return result.data as z.output<S>;
  })();
