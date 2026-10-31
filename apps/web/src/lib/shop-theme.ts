import type { PublicShop } from '@partops/contracts';

/**
 * Tema de la vitrina.
 *
 * Cada negocio entra con su color, y el catálogo tiene que verse suyo, no de PartOps. Pero un color
 * de marca elegido a ojo puede ser casi blanco: si se usa tal cual sobre el texto del botón, el
 * "Pedir" desaparece. Por eso el color del negocio se aplica al FONDO y el texto se elige por
 * luminancia —blanco o casi negro—, nunca al revés.
 *
 * Los tokens se sobrescriben dentro del contenedor de la tienda, así los componentes compartidos
 * (`Button`, `Alert`) heredan la marca sin saber que existe.
 */

const FALLBACK_PRIMARY = '#16324F';
const FALLBACK_ACCENT = '#B4703A';

/** Luminancia relativa (WCAG). Se usa para decidir si encima va tinta clara u oscura. */
function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0.15;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(hex)) return null;
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** Un color de marca válido o el de la casa: una cadena rota no puede dejar la tienda sin botones. */
export function safeColor(value: string | null | undefined, fallback: string): string {
  return value && parseHex(value) ? value : fallback;
}

export function readableOn(background: string): string {
  return luminance(background) > 0.46 ? '#141A21' : '#FFFFFF';
}

/**
 * Variables CSS de la tienda.
 *
 * Se tipa como `Record<string, string>` porque React exige un índice para propiedades `--*`; el
 * cast queda en un solo lugar en vez de repetirse en cada componente.
 */
export function shopTheme(shop: Pick<PublicShop, 'brandPrimary' | 'brandAccent'>): Record<string, string> {
  const primary = safeColor(shop.brandPrimary, FALLBACK_PRIMARY);
  const accent = safeColor(shop.brandAccent, FALLBACK_ACCENT);
  const onPrimary = readableOn(primary);
  return {
    '--primary': primary,
    '--primary-foreground': onPrimary,
    '--primary-hover': `color-mix(in oklch, ${primary} 86%, ${onPrimary === '#FFFFFF' ? 'black' : 'white'})`,
    '--accent': accent,
    '--accent-foreground': readableOn(accent),
    '--focus-ring': accent,
    '--shop-primary': primary,
    '--shop-accent': accent,
    '--shop-on-primary': onPrimary,
  };
}
