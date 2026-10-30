'use client';

import { cn } from '../lib/cn';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  // Primario: azul taller sólido. Es la acción que mueve el negocio (cobrar, despachar).
  primary:
    'bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)] active:translate-y-px',
  // Secundario: contorno. Se usa para todo lo que no debe competir por atención.
  secondary:
    'border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-sunken)]',
  // Fantasma: solo en barras de herramientas donde el contexto ya dice qué es.
  ghost: 'text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--foreground)]',
  danger: 'bg-[var(--color-stock-out)] text-white hover:brightness-110',
};

const SIZES: Record<ButtonSize, string> = {
  // 36px: densidad de tabla, no de landing.
  sm: 'h-9 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  // 48px: el mínimo real para dedos con guantes en la app de bodega.
  lg: 'h-12 px-5 text-[15px] gap-2',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      // `aria-busy` para lectores de pantalla; el spinner es decoración.
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-[var(--radius-sm)] font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
