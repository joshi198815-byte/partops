import { cn } from '../lib/cn';

/**
 * Código en monoespaciada con barra de cobre.
 *
 * SKU, número OEM, folio y código de barras se leen carácter por carácter cuando algo no cuadra.
 * La monoespaciada no es estética: es lo que evita confundir 0/O y 1/l en una llamada telefónica.
 */
export function CodeChip({
  children,
  label,
  className,
  tone = 'default',
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
  tone?: 'default' | 'muted';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] border border-[var(--border)]',
        'bg-[var(--surface-sunken)] py-0.5 pl-1.5 pr-2 text-[12px] leading-5',
        tone === 'muted' && 'opacity-70',
        className,
      )}
    >
      <span aria-hidden className="h-3 w-0.5 shrink-0 rounded-full bg-[var(--accent)]" />
      {label ? (
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
          {label}
        </span>
      ) : null}
      <span className="partops-num font-mono text-[var(--foreground)]">{children}</span>
    </span>
  );
}

/**
 * Existencia. El número es lo primero que se lee; el punto de color es refuerzo, no la señal.
 * Por eso nunca es un semáforo de fondo: en bodega hay poca luz y el color solo engaña.
 */
export function StockPill({
  quantity,
  reorderPoint,
  unit = 'u',
  className,
}: {
  quantity: number;
  reorderPoint?: number | null;
  unit?: string;
  className?: string;
}) {
  const state = quantity <= 0 ? 'out' : reorderPoint != null && quantity <= reorderPoint ? 'low' : 'ok';
  const tone =
    state === 'out'
      ? 'text-[var(--color-stock-out)] border-[color-mix(in_oklch,var(--color-stock-out)_35%,transparent)]'
      : state === 'low'
        ? 'text-[var(--color-stock-low)] border-[color-mix(in_oklch,var(--color-stock-low)_35%,transparent)]'
        : 'text-[var(--color-stock-ok)] border-[color-mix(in_oklch,var(--color-stock-ok)_30%,transparent)]';
  const dot =
    state === 'out'
      ? 'bg-[var(--color-stock-out)]'
      : state === 'low'
        ? 'bg-[var(--color-stock-low)]'
        : 'bg-[var(--color-stock-ok)]';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-medium',
        tone,
        className,
      )}
      title={
        state === 'out' ? 'Agotado' : state === 'low' ? `Bajo el mínimo (${reorderPoint})` : 'Disponible'
      }
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
      <span className="partops-num">
        {quantity} {unit}
      </span>
      <span className="sr-only">
        {state === 'out' ? 'agotado' : state === 'low' ? 'bajo el mínimo' : 'disponible'}
      </span>
    </span>
  );
}

/** Ruta de vehículo: el pan de cada día del vendedor. Se lee como una frase, no como un formulario. */
export function VehicleBreadcrumb({
  brand,
  model,
  year,
  className,
}: {
  brand: string;
  model: string;
  year?: number | null;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex items-baseline gap-1 text-[13px] text-[var(--foreground-muted)]', className)}
    >
      <span className="font-medium text-[var(--foreground)]">{brand}</span>
      <span aria-hidden>›</span>
      <span className="font-medium text-[var(--foreground)]">{model}</span>
      {year ? (
        <>
          <span aria-hidden>›</span>
          <span className="partops-num">{year}</span>
        </>
      ) : null}
    </span>
  );
}

/** Estado vacío con la trama de muesca. Dice qué hacer, no solo que no hay nada. */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border)] px-6 py-12 text-center">
      <div className="partops-hatch flex size-12 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--foreground-muted)]">
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-[var(--foreground)]">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-[13px] text-[var(--foreground-muted)]">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Cifra grande del tablero. La etiqueta va arriba; el delta, abajo, con su signo. */
export function StatTile({
  label,
  value,
  hint,
  delta,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: { value: string; positive: boolean } | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4',
        className,
      )}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
        {label}
      </p>
      <p className="partops-num mt-1.5 font-[family-name:var(--font-display)] text-[26px] font-bold leading-none text-[var(--foreground)]">
        {value}
      </p>
      {delta || hint ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--foreground-muted)]">
          {delta ? (
            <span
              className={cn(
                'partops-num font-medium',
                delta.positive ? 'text-[var(--color-stock-ok)]' : 'text-[var(--color-stock-out)]',
              )}
            >
              {delta.value}
            </span>
          ) : null}
          {hint}
        </p>
      ) : null}
    </div>
  );
}
