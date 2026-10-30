/**
 * Genera los PNG de marca desde el SVG fuente.
 *
 * Android adaptativo necesita foreground y background SEPARADOS: el launcher recorta el
 * foreground con una máscara (círculo, squircle, lo que el fabricante use) y lo anima. Si se
 * rasteriza el logo plano, el hexágono pierde los vértices en cuanto el teléfono aplica su
 * máscara. Por eso el foreground lleva el logo al 55% del lienzo y el fondo va aparte.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const BLUE = '#16324F';
const COPPER = '#B4703A';
const TILE = '#0E2233';
const CHALK = '#F7F5F1';

/** El mismo path que `packages/ui/src/brand/logo.tsx`. Si cambia allá, cambia acá. */
function markSvg({ size, bg, fg, notch, padding }) {
  const scale = (size - padding * 2) / 48;
  const body = 'M24 5.6 39.9 14.8 39.9 33.2 24 42.4 8.1 33.2 8.1 14.8Z';
  const pPath =
    'M17.6 13.4h5.9c4.6 0 7.7 2.6 7.7 6.6 0 4-3.1 6.6-7.7 6.6h-2.5v6.8h-3.4V13.4Zm3.4 3.1v6.9h2.3c2.6 0 4.3-1.3 4.3-3.4s-1.7-3.5-4.3-3.5h-2.3Z';
  // Corte inscrito en el vértice inferior derecho: nunca sobresale del cuerpo.
  const wedge = 'M39.9 33.2 39.9 26 32.73 37.34Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="PartOps">
  <title>PartOps</title>
  ${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ''}
  <g transform="translate(${padding} ${padding}) scale(${scale})">
    <path d="${body}" fill="${fg}"/>
    <path d="${pPath}" fill="${bg ?? '#FFFFFF'}"/>
    <path d="${wedge}" fill="${notch}"/>
  </g>
</svg>`;
}

const svg = (o) => sharp(Buffer.from(markSvg(o)));
const out = (...p) => resolve(root, ...p);

const assets = out('apps', 'mobile', 'assets');
const webBrand = out('apps', 'web', 'public', 'brand');
await mkdir(assets, { recursive: true });
await mkdir(webBrand, { recursive: true });

// ── Iconos de app ──────────────────────────────────────────────────────────────
await svg({ size: 1024, bg: TILE, fg: CHALK, notch: COPPER, padding: 150 })
  .png()
  .toFile(out(assets, 'icon-only.png'));

// Android adaptativo: fondo plano + foreground con safe area del 20%.
await svg({ size: 1024, bg: TILE, fg: CHALK, notch: COPPER, padding: 150 })
  .png()
  .toFile(out('apps', 'mobile', 'assets', 'icon-background.png'));
await svg({ size: 1024, bg: null, fg: CHALK, notch: COPPER, padding: 300 })
  .png()
  .toFile(out(assets, 'icon-foreground.png'));

// Splash: marca centrada sobre azul profundo, sin degradado.
for (const name of ['splash.png', 'splash-dark.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: TILE } })
    .composite([
      {
        input: await svg({ size: 700, bg: null, fg: CHALK, notch: COPPER, padding: 20 }).png().toBuffer(),
        gravity: 'center',
      },
    ])
    .png()
    .toFile(out(assets, name));
}

// ── Web / PWA ─────────────────────────────────────────────────────────────────
await svg({ size: 192, bg: TILE, fg: CHALK, notch: COPPER, padding: 22 })
  .png()
  .toFile(out(webBrand, 'icon-192.png'));
await svg({ size: 512, bg: TILE, fg: CHALK, notch: COPPER, padding: 58 })
  .png()
  .toFile(out(webBrand, 'icon-512.png'));
// Maskable: el logo ocupa el 60% central para sobrevivir al recorte del sistema.
await sharp({ create: { width: 512, height: 512, channels: 4, background: TILE } })
  .composite([
    {
      input: await svg({ size: 320, bg: null, fg: CHALK, notch: COPPER, padding: 10 }).png().toBuffer(),
      gravity: 'center',
    },
  ])
  .png()
  .toFile(out(webBrand, 'icon-maskable-512.png'));
await svg({ size: 180, bg: TILE, fg: CHALK, notch: COPPER, padding: 20 })
  .png()
  .toFile(out(webBrand, 'apple-icon-180.png'));

// Tarjeta para compartir: 1200x630, la proporción que no recorta ninguna red.
await sharp({ create: { width: 1200, height: 630, channels: 4, background: BLUE } })
  .composite([
    {
      input: await svg({ size: 300, bg: null, fg: CHALK, notch: COPPER, padding: 10 }).png().toBuffer(),
      left: 120,
      top: 165,
    },
  ])
  .png()
  .toFile(out(webBrand, 'og-image.png'));

// SVG vectorial para favicon y usos donde el PNG pierde nitidez. Se escribe el texto tal cual:
// sharp no produce SVG, y no hace falta — el fuente ya lo es.
await writeFile(
  out(webBrand, 'mark.svg'),
  markSvg({ size: 64, bg: TILE, fg: CHALK, notch: COPPER, padding: 8 }),
  'utf8',
);

console.log(
  'Marca generada: iconos 192/512/maskable/apple, foreground+background Android, splash 2732, og 1200x630, mark.svg',
);
