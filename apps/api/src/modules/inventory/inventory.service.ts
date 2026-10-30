import { BadRequestException, Injectable } from '@nestjs/common';
import type { MovementType, TxClient } from '@partops/db';

export interface StockChange {
  tenantId: string;
  variantId: string;
  warehouseId: string;
  /** Cambio en existencia física. Positivo entra, negativo sale. */
  onHandDelta?: number;
  /** Cambio en reserva. Se mueve con delta, no en absoluto: así dos ventas no se pisan. */
  reservedDelta?: number;
  type: MovementType;
  reason?: string | null;
  refType?: string | null;
  refId?: string | null;
  userId?: string | null;
  /** Solo la sincronización offline puede dejar existencia negativa, y queda marcado. */
  allowNegative?: boolean;
}

export interface StockResult {
  onHand: number;
  reserved: number;
  /** Existencia libre después del cambio: `onHand - reserved`. */
  available: number;
}

/**
 * Único punto por el que se mueve el inventario.
 *
 * Por qué SQL crudo y no un `update` de Prisma: la comprobación y la escritura tienen que ser una
 * sola sentencia. Con dos pasos (leer, validar, escribir) dos cajeros vendiendo la última pieza al
 * mismo tiempo leen "hay 1", ambos pasan la validación y el stock queda en -1. Aquí la condición
 * vive en el `WHERE` del `UPDATE`: Postgres serializa la fila y el segundo pierde con 0 filas,
 * que se traduce a `OUT_OF_STOCK`.
 *
 * El `stock_movement` que se inserta después es el registro inmutable de ese cambio y el que
 * permite auditar cualquier descuadre.
 */
@Injectable()
export class InventoryService {
  async apply(tx: TxClient, c: StockChange): Promise<StockResult> {
    const onHand = c.onHandDelta ?? 0;
    const reserved = c.reservedDelta ?? 0;
    if (onHand === 0 && reserved === 0) {
      throw new BadRequestException({ code: 'NO_CHANGE', message: 'El movimiento no cambia existencias' });
    }
    const allowNegative = c.allowNegative ?? false;

    /**
     * Dos sentencias, una sola transacción, y cada una tiene un motivo:
     *
     *  1. `INSERT ... DO NOTHING` garantiza que exista la fila en (0,0). No se intenta insertar el
     *     delta: una reserva de 3 sobre una pieza que nunca ha entrado daría (-3? no, 0/3) y el
     *     CHECK `reserved <= onHand` reventaría con un error de base en vez de "no hay existencia".
     *  2. `UPDATE` con la condición dentro del `WHERE`: la comprobación y la escritura son la misma
     *     sentencia. Si no se cumple, `RETURNING` vuelve vacío → `OUT_OF_STOCK`. Postgres bloquea la
     *     fila, así que dos ventas simultáneas se serializan y exactamente una gana.
     */
    await tx.$executeRaw`
      INSERT INTO "inventory_level" ("tenantId", "variantId", "warehouseId", "onHand", "reserved", "updatedAt")
      VALUES (${c.tenantId}, ${c.variantId}, ${c.warehouseId}, 0, 0, NOW())
      ON CONFLICT ("variantId", "warehouseId") DO NOTHING`;

    const rows = await tx.$queryRaw<{ onHand: number; reserved: number }[]>`
      UPDATE "inventory_level"
         SET "onHand"    = "onHand" + ${onHand},
             "reserved"  = "reserved" + ${reserved},
             "updatedAt" = NOW()
       WHERE "variantId" = ${c.variantId}
         AND "warehouseId" = ${c.warehouseId}
         AND (${allowNegative} OR "onHand" + ${onHand} >= 0)
         AND ("reserved" + ${reserved} >= 0)
         AND ("reserved" + ${reserved} <= "onHand" + ${onHand})
      RETURNING "onHand", "reserved"`;

    // `$queryRaw` devuelve las columnas tal cual las nombra Postgres: hay que mapear a mano,
    // porque el driver las entrega con el nombre físico ("onHand") y no como objeto del modelo.
    const raw = rows[0];
    if (!raw) {
      throw new BadRequestException({
        code: 'OUT_OF_STOCK',
        message: 'No hay existencia suficiente para completar esta operación',
      });
    }
    const level = { onHand: Number(raw.onHand), reserved: Number(raw.reserved) };

    if (onHand !== 0) {
      await tx.stockMovement.create({
        data: {
          tenantId: c.tenantId,
          variantId: c.variantId,
          warehouseId: c.warehouseId,
          delta: onHand,
          balanceAfter: level.onHand,
          type: c.type,
          reason: c.reason ?? null,
          refType: c.refType ?? null,
          refId: c.refId ?? null,
          userId: c.userId ?? null,
        },
      });
    }

    return { ...level, available: level.onHand - level.reserved };
  }

  /** Reserva para un pedido. Si no alcanza, no reserva nada y el pedido nace SIN_STOCK. */
  reserve(
    tx: TxClient,
    args: Omit<StockChange, 'onHandDelta' | 'reservedDelta' | 'type'> & { quantity: number },
  ) {
    return this.apply(tx, { ...args, reservedDelta: args.quantity, type: 'RESERVA' });
  }

  /** Libera una reserva (cancelación o expiración). Nunca toca la existencia física. */
  release(
    tx: TxClient,
    args: Omit<StockChange, 'onHandDelta' | 'reservedDelta' | 'type'> & { quantity: number },
  ) {
    return this.apply(tx, { ...args, reservedDelta: -args.quantity, type: 'LIBERACION' });
  }

  /**
   * Despacho: la pieza sale físicamente. Consume la reserva y la existencia en un solo movimiento,
   * para que `available` no cambie (estaba reservada) y el ledger registre la salida real.
   */
  async commit(
    tx: TxClient,
    args: Omit<StockChange, 'onHandDelta' | 'reservedDelta' | 'type'> & { quantity: number },
  ) {
    return this.apply(tx, {
      ...args,
      onHandDelta: -args.quantity,
      reservedDelta: -args.quantity,
      type: 'VENTA',
    });
  }

  /** Ajuste con motivo obligatorio: es lo que evita "desaparecer" diferencias sin explicación. */
  adjust(tx: TxClient, args: Omit<StockChange, 'onHandDelta' | 'type'> & { delta: number; reason: string }) {
    if (!args.reason?.trim()) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message: 'Todo ajuste necesita un motivo',
      });
    }
    return this.apply(tx, { ...args, onHandDelta: args.delta, type: 'AJUSTE' });
  }
}
