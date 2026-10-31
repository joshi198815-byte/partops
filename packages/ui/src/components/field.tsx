import { cn } from '../lib/cn';

/**
 * Controles de formulario.
 *
 * Altura de 44 px: se llenan con el teléfono en una mano, de pie en el mostrador. La etiqueta va
 * arriba en versalitas y el error pegado al campo que lo causó, no en una lista al final del
 * formulario donde nadie sabe a qué campo se refiere.
 */
const CONTROL =
  'w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[14px] text-[var(--foreground)] ' +
  'placeholder:text-[color-mix(in_oklch,var(--foreground-muted)_70%,transparent)] ' +
  'disabled:cursor-not-allowed disabled:bg-[var(--surface-sunken)] disabled:text-[var(--foreground-muted)]';

export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string;
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={htmlFor}
          className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-muted)]"
        >
          {label}
          {required ? (
            <span aria-hidden className="ml-0.5 text-[var(--color-copper-700)]">
              *
            </span>
          ) : null}
        </label>
        {hint ? <span className="text-[11px] text-[var(--foreground-muted)]">{hint}</span> : null}
      </div>
      {children}
      {error ? (
        <p
          id={`${htmlFor}-error`}
          role="alert"
          className="text-[12px] leading-snug text-[var(--color-stock-out)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({
  className,
  invalid,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${rest.id}-error` : rest['aria-describedby']}
      className={cn(CONTROL, 'h-11', invalid && 'border-[var(--color-stock-out)]', className)}
    />
  );
}

export function TextArea({
  className,
  invalid,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        'min-h-[76px] py-2.5 leading-relaxed',
        invalid && 'border-[var(--color-stock-out)]',
        className,
      )}
    />
  );
}

export function Select({
  className,
  invalid,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        'h-11 appearance-none pr-8',
        invalid && 'border-[var(--color-stock-out)]',
        className,
      )}
      style={{
        // Flecha dibujada con el token de borde: el control nativo de Windows se ve fuera de lugar
        // junto al resto de la interfaz, y el de macOS desaparece.
        backgroundImage:
          'linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)',
        backgroundPosition: 'calc(100% - 15px) 19px, calc(100% - 10px) 19px',
        backgroundSize: '5px 5px, 5px 5px',
        backgroundRepeat: 'no-repeat',
      }}
    >
      {children}
    </select>
  );
}

export function Checkbox({
  label,
  description,
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-3',
        'hover:border-[var(--border-strong)]',
        className,
      )}
    >
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" {...rest} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[var(--foreground)]">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[12px] leading-snug text-[var(--foreground-muted)]">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** Aviso de formulario. El tono nunca es decorativo: rojo es un error que impide continuar. */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'error' | 'info' | 'success';
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const accent =
    tone === 'error'
      ? 'var(--color-stock-out)'
      : tone === 'success'
        ? 'var(--color-stock-ok)'
        : 'var(--color-copper-600)';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5',
        'border-l-2 text-[13px] leading-snug text-[var(--foreground)]',
        className,
      )}
      style={{ borderLeftColor: accent }}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? (
        <div className={cn(title && 'mt-0.5', 'text-[var(--foreground-muted)]')}>{children}</div>
      ) : null}
    </div>
  );
}
