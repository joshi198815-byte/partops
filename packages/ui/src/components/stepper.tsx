import { cn } from '../lib/cn';

export interface Step {
  key: string;
  label: string;
}

/**
 * Riel de pasos del alta.
 *
 * Lo hecho se marca con la muesca de cobre, no con un check: el mismo motivo de la marca, sin
 * agregar un ícono nuevo al sistema. El paso actual se distingue por peso tipográfico y borde,
 * así se entiende también en impresión y con daltonismo.
 */
export function Stepper({
  steps,
  current,
  className,
}: {
  steps: Step[];
  current: number;
  className?: string;
}) {
  return (
    <ol className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
      {steps.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step.key} className="flex items-center gap-2">
            {i > 0 ? <span aria-hidden className="h-px w-4 bg-[var(--border-strong)]" /> : null}
            <span
              className={cn(
                'flex items-center gap-1.5 text-[12px]',
                active ? 'font-semibold text-[var(--foreground)]' : 'text-[var(--foreground-muted)]',
              )}
              aria-current={active ? 'step' : undefined}
            >
              <span
                className={cn(
                  'partops-num flex size-5 items-center justify-center rounded-[var(--radius-xs)] border font-mono text-[10.5px]',
                  done && 'border-transparent bg-[var(--accent)] text-white',
                  active && 'border-[var(--border-strong)] bg-[var(--surface)] text-[var(--foreground)]',
                  !done && !active && 'border-[var(--border)] text-[var(--foreground-muted)]',
                )}
              >
                {done ? '✓' : String(i + 1).padStart(2, '0')}
              </span>
              <span className={cn('hidden sm:inline', active && 'inline')}>{step.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
