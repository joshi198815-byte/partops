import { AVAILABILITY_LABEL, type AvailabilityBucket } from '@partops/contracts';
import { cn } from '@partops/ui';

/**
 * Disponibilidad como cubo, nunca como número.
 *
 * El catálogo público no dice "quedan 3": le dice a la competencia cuánto inventario hay y le
 * promete al cliente una pieza que otra persona puede estar comprando en ese instante. El número
 * exacto vive en el sistema interno; aquí solo hay tres estados.
 *
 * El color refuerza, no informa: el texto dice lo mismo con la pantalla en gris.
 */
const TONE: Record<AvailabilityBucket, string> = {
  HAY: 'text-[var(--color-stock-ok)] border-[color-mix(in_oklch,var(--color-stock-ok)_32%,transparent)] bg-[color-mix(in_oklch,var(--color-stock-ok)_8%,transparent)]',
  POCAS:
    'text-[var(--color-stock-low)] border-[color-mix(in_oklch,var(--color-stock-low)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-stock-low)_10%,transparent)]',
  AGOTADO:
    'text-[var(--color-stock-out)] border-[color-mix(in_oklch,var(--color-stock-out)_32%,transparent)] bg-[color-mix(in_oklch,var(--color-stock-out)_7%,transparent)]',
};

const DOT: Record<AvailabilityBucket, string> = {
  HAY: 'bg-[var(--color-stock-ok)]',
  POCAS: 'bg-[var(--color-stock-low)]',
  AGOTADO: 'bg-[var(--color-stock-out)]',
};

export function AvailabilityPill({ bucket, className }: { bucket: AvailabilityBucket; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium',
        TONE[bucket],
        className,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', DOT[bucket])} />
      {AVAILABILITY_LABEL[bucket]}
    </span>
  );
}
