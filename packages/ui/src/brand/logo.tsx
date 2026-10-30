/**
 * Marca PartOps: "la tuerca abierta".
 *
 * Un hexágono de cabeza de perno con un corte en el vértice inferior derecho. El negativo del
 * corte dibuja la contraforma de una P; la muesca va en cobre: la pieza que sale de bodega.
 *
 * Por qué así y no un ícono de llave inglesa: la marca tiene que leerse a 16 px en la barra de
 * tareas y a 512 px en la tienda. Una silueta sólida con un solo corte aguanta ambas escalas;
 * un ícono detallado no.
 */

const BLUE = '#16324F';
const COPPER = '#B4703A';
const TILE = '#0E2233';

export interface LogoProps {
  /** Tamaño en px. El SVG escala sin pérdida; esto fija la caja. */
  size?: number;
  /** 'color' sobre fondo claro, 'inverse' sobre fondo oscuro, 'mono' una sola tinta. */
  variant?: 'color' | 'inverse' | 'mono';
  /** Cuadrado redondeado de fondo (icono de app, favicon). */
  tile?: boolean;
  className?: string;
  title?: string;
}

function palette(variant: LogoProps['variant']) {
  switch (variant) {
    case 'inverse':
      return { body: '#F7F5F1', notch: COPPER, hole: TILE };
    case 'mono':
      return { body: 'currentColor', notch: 'currentColor', hole: 'transparent' };
    default:
      return { body: BLUE, notch: COPPER, hole: '#FFFFFF' };
  }
}

/** Hexágono regular plano-arriba, con vértices en 0°, 60°, 120°… para que el corte sea exacto. */
function hexPath(cx: number, cy: number, r: number): string {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });
  return `${pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')} Z`;
}

export function PartOpsMark({
  size = 32,
  variant = 'color',
  tile = false,
  className,
  title = 'PartOps',
}: LogoProps) {
  const { body, notch } = palette(variant);
  const cx = 24;
  const cy = 24;
  const r = 18.4;
  // Vértice inferior derecho del hexágono (30°) y los dos puntos del corte, a 45% sobre las
  // aristas que salen de él. El triángulo queda INSCRITO: si se sale del cuerpo, a 16 px se
  // convierte en una mancha y el logo deja de leerse.
  const vy = 33.2;
  const vx = 39.9;

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {tile ? <rect width="48" height="48" rx="11" fill={TILE} /> : null}

      {/* Cuerpo del perno. */}
      <path d={hexPath(cx, cy, r)} fill={body} />

      {/* Contraforma de la P, recortada del cuerpo. */}
      <path
        d="M17.6 13.4h5.9c4.6 0 7.7 2.6 7.7 6.6 0 4-3.1 6.6-7.7 6.6h-2.5v6.8h-3.4V13.4Zm3.4 3.1v6.9h2.3c2.6 0 4.3-1.3 4.3-3.4s-1.7-3.5-4.3-3.5h-2.3Z"
        fill={tile ? TILE : '#FFFFFF'}
      />

      {/* Muesca: el vértice cortado, en cobre. Es la pieza saliendo de bodega. */}
      <path
        d={`M${vx} ${vy} L${vx} ${vy - 7.2} L${(vx - 7.17).toFixed(2)} ${(vy + 4.14).toFixed(2)} Z`}
        fill={notch}
      />
    </svg>
  );
}

export function PartOpsWordmark({
  size = 22,
  variant = 'color',
  className,
}: {
  size?: number;
  variant?: LogoProps['variant'];
  className?: string;
}) {
  const { body, notch } = palette(variant);
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '0.02em',
        fontFamily: 'var(--font-display), Archivo, ui-sans-serif, sans-serif',
        fontWeight: 800,
        fontSize: size,
        letterSpacing: '-0.022em',
        lineHeight: 1,
        color: body,
      }}
    >
      PART
      <span style={{ color: notch }}>OPS</span>
    </span>
  );
}

/** Marca completa: símbolo + palabra. La forma que se usa en cabeceras y en el login. */
export function PartOpsLogo({
  size = 26,
  variant = 'color',
  className,
}: {
  size?: number;
  variant?: LogoProps['variant'];
  className?: string;
}) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.34 }}>
      <PartOpsMark size={size * 1.24} variant={variant} />
      <PartOpsWordmark size={size} variant={variant} />
    </span>
  );
}
