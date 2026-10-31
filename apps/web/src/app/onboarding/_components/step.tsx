import { Button } from '@partops/ui';

/** Encabezado de un paso. Numerado porque el dueño necesita saber cuánto le falta. */
export function StepHeading({ step, title, body }: { step: string; title: string; body: string }) {
  return (
    <div className="mb-6">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-copper-700)]">
        {step}
      </p>
      <h1 className="mt-1.5 font-[family-name:var(--font-display)] text-[clamp(1.4rem,3vw,1.85rem)] font-bold leading-tight tracking-[-0.02em] text-[var(--foreground)]">
        {title}
      </h1>
      <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">{body}</p>
    </div>
  );
}

/**
 * Acciones al pie. El botón primario avanza; saltar es siempre la opción secundaria y nunca
 * desaparece: un asistente que no se puede saltar se abandona en la mitad.
 */
export function StepActions({
  pending,
  label,
  onSkip,
  skipLabel,
}: {
  pending: boolean;
  label: string;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  return (
    <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-5">
      <Button type="submit" size="lg" loading={pending}>
        {label}
      </Button>
      {onSkip ? (
        <Button type="button" size="lg" variant="ghost" onClick={onSkip} disabled={pending}>
          {skipLabel ?? 'Saltar por ahora'}
        </Button>
      ) : null}
    </div>
  );
}
