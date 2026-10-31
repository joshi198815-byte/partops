import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { env } from '../config/env.js';
import { DemandService } from '../modules/demand/demand.service.js';
import { FinanceService } from '../modules/finance/finance.service.js';
import { PublicGuardService } from '../modules/public-catalog/public-guard.service.js';
import { DatabaseService } from './database.module.js';

/**
 * Mantenimiento periódico sin infraestructura extra.
 *
 * El plan donde vive esto no tiene Redis ni un servicio de cron aparte, y un `setInterval` suelto
 * tiene dos fallas que importan: si el proceso se reinicia a media corrida no queda constancia, y
 * con dos instancias el trabajo se hace dos veces. Por eso el cerrojo es una fila en
 * `background_job`: la clave única `(queue, singletonKey)` deja que exactamente una instancia
 * reclame la corrida del día, y el estado sobrevive al reinicio.
 *
 * El día se calcula en la zona de Guatemala y no en UTC: a las 18:00 de Guatemala ya es "mañana" en
 * UTC, y el rollup de un día cerraría seis horas antes de que termine el día de la bodega.
 */

/** Cada cuánto se pregunta si toca trabajar. Preguntar es barato; hacer el trabajo, no. */
const TICK_MS = 10 * 60_000;

/** Espera del primer tick: deja que la API termine de arrancar y atender requests. */
const FIRST_TICK_MS = 45_000;

const QUEUE = 'mantenimiento';
const TIMEZONE = 'America/Guatemala';

@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MaintenanceService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DemandService) private readonly demand: DemandService,
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(PublicGuardService) private readonly guard: PublicGuardService,
  ) {}

  onModuleInit() {
    // Solo un rol de worker hace el mantenimiento. En desarrollo el proceso es `api` y el cron
    // queda apagado salvo que se pida con `MAINTENANCE_IN_API=1`; así un `pnpm dev` no dispara
    // agregados contra la base de desarrollo cada vez que se guarda un archivo.
    if (env.PROCESS_ROLE !== 'worker' && process.env.MAINTENANCE_IN_API !== '1') return;
    this.timers.push(setTimeout(() => void this.tick(), FIRST_TICK_MS));
    this.timers.push(setInterval(() => void this.tick(), TICK_MS));
    this.log.log('Mantenimiento programado: rollup de demanda y purga de contadores');
  }

  onModuleDestroy() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /**
   * Reclama la corrida del día y la ejecuta.
   *
   * Idempotente a propósito: si ya está `DONE`, no hace nada; si quedó `RUNNING` de un proceso que
   * murió, la reclama pasados diez minutos. Un trabajo que queda trabado para siempre es peor que
   * uno que corre dos veces, porque nadie lo nota hasta que el reporte lleva un mes congelado.
   */
  async tick(now = new Date()): Promise<{ ran: boolean; reason?: string }> {
    if (this.running) return { ran: false, reason: 'en curso' };
    this.running = true;
    try {
      const key = `diario:${new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(now)}`;
      const claimed = await this.claim(key);
      if (!claimed) return { ran: false, reason: 'ya ejecutado' };

      try {
        const rollup = await this.demand.runDaily();
        const money = await this.finance.runDaily();
        const purgedHits = await this.guard.purgeOlderThan(2);
        await this.finish(key, 'DONE', null);
        this.log.log(
          `Mantenimiento ${key}: ${rollup.tenants} negocios, ${rollup.rolledDays} días agregados, ` +
            `${rollup.purgedEvents} eventos purgados, ${money.generated} gastos fijos generados, ` +
            `${money.days} días de finanzas, ${purgedHits} contadores limpiados`,
        );
        return { ran: true };
      } catch (err) {
        await this.finish(key, 'FAILED', (err as Error).message.slice(0, 500));
        this.log.error(`Mantenimiento ${key} falló: ${(err as Error).message}`);
        return { ran: false, reason: 'error' };
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Intenta quedarse con la corrida del día.
   *
   * `ON CONFLICT DO NOTHING` sobre la clave única resuelve la carrera entre instancias sin
   * transacción larga ni `SELECT ... FOR UPDATE`: la base decide quién gana y el resto se entera por
   * cero filas insertadas.
   */
  private async claim(key: string): Promise<boolean> {
    return this.db.system(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO "background_job" ("id", "queue", "data", "status", "runAt", "attempts", "maxAttempts", "singletonKey", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${QUEUE}, '{}'::jsonb, 'RUNNING', now(), 1, 4, ${key}, now(), now())
        ON CONFLICT ("queue", "singletonKey") DO NOTHING`;
      if (Number(inserted) > 0) return true;

      // Ya existe. Se reclama solo si el dueño anterior murió: `RUNNING` con `lockedAt` viejo.
      const reclaimed = await tx.$executeRaw`
        UPDATE "background_job"
           SET "status" = 'RUNNING', "attempts" = "attempts" + 1, "lockedAt" = now(), "updatedAt" = now()
         WHERE "queue" = ${QUEUE} AND "singletonKey" = ${key}
           AND "status" = 'RUNNING'
           AND "lockedAt" < now() - interval '10 minutes'
           AND "attempts" < "maxAttempts"`;
      return Number(reclaimed) > 0;
    });
  }

  private async finish(key: string, status: 'DONE' | 'FAILED', error: string | null): Promise<void> {
    await this.db.system(
      (tx) =>
        tx.$executeRaw`
        UPDATE "background_job"
           SET "status" = ${status}, "lastError" = ${error}, "lockedAt" = NULL, "updatedAt" = now()
         WHERE "queue" = ${QUEUE} AND "singletonKey" = ${key}`,
    );
  }
}
