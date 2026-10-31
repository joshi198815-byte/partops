#!/usr/bin/env node
/**
 * Copia la marca a los recursos de Android.
 *
 * Cinco densidades × (icono, round, foreground) + once splash = treinta y tres archivos que nadie va
 * a exportar a mano cada vez que cambie el logo, y que se desincronizan en silencio si se hace a
 * mano: el teléfono del dueño enseña una tuerca vieja y el resto una nueva.
 *
 * Los PNG fuente viven en `apps/mobile/assets/` y los produce `pnpm brand` en la raíz. Este script
 * solo reescala: no inventa la marca.
 *
 * Android adaptativo: `ic_launcher_foreground` va **sin fondo** y con el logo al 55% del lienzo. El
 * sistema recorta con la máscara del fabricante (círculo, squircle…) y un foreground a sangre
 * perdería los vértices del hexágono.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, '..');
const assets = join(mobile, 'assets');
const res = join(mobile, 'android', 'app', 'src', 'main', 'res');

if (!existsSync(res)) {
  console.error('No existe android/. Corre primero: pnpm --filter @partops/mobile add:android');
  process.exit(1);
}

/** Densidades de Android y su factor. El launcher usa 48 dp, el splash cubre la pantalla. */
const DENSITIES = [
  { name: 'mdpi', factor: 1 },
  { name: 'hdpi', factor: 1.5 },
  { name: 'xhdpi', factor: 2 },
  { name: 'xxhdpi', factor: 3 },
  { name: 'xxxhdpi', factor: 4 },
];

/**
 * Splash por orientación y densidad.
 *
 * Capacitor busca `splash.png` en cada `drawable-port-*` y `drawable-land-*`. Se generan del mismo
 * cuadrado 2732 con `fit: 'cover'`: recortar el centro deja la marca centrada en cualquier relación
 * de aspecto, mientras que `contain` dejaría franjas del color de fondo del sistema.
 */
const SPLASHES = [
  { dir: 'drawable', width: 480, height: 320 },
  { dir: 'drawable-port-mdpi', width: 320, height: 480 },
  { dir: 'drawable-port-hdpi', width: 480, height: 800 },
  { dir: 'drawable-port-xhdpi', width: 720, height: 1280 },
  { dir: 'drawable-port-xxhdpi', width: 960, height: 1600 },
  { dir: 'drawable-port-xxxhdpi', width: 1280, height: 1920 },
  { dir: 'drawable-land-mdpi', width: 480, height: 320 },
  { dir: 'drawable-land-hdpi', width: 800, height: 480 },
  { dir: 'drawable-land-xhdpi', width: 1280, height: 720 },
  { dir: 'drawable-land-xxhdpi', width: 1600, height: 960 },
  { dir: 'drawable-land-xxxhdpi', width: 1920, height: 1280 },
];

const sources = {
  icon: join(assets, 'icon-only.png'),
  background: join(assets, 'icon-background.png'),
  foreground: join(assets, 'icon-foreground.png'),
  splash: join(assets, 'splash.png'),
};

for (const [name, path] of Object.entries(sources)) {
  if (!existsSync(path)) {
    console.error(`Falta ${name}: ${path}. Corre «pnpm brand» en la raíz del repo.`);
    process.exit(1);
  }
}

// ── Iconos ────────────────────────────────────────────────────────────────────
for (const { name, factor } of DENSITIES) {
  const dir = join(res, `mipmap-${name}`);
  await mkdir(dir, { recursive: true });
  const size = Math.round(48 * factor);

  await sharp(sources.icon).resize(size, size, { fit: 'cover' }).png().toFile(join(dir, 'ic_launcher.png'));
  await sharp(sources.icon)
    .resize(size, size, { fit: 'cover' })
    .png()
    .toFile(join(dir, 'ic_launcher_round.png'));

  // Foreground del adaptativo: 108 dp de lienzo para 48 dp de icono, con el logo ya centrado al 55%
  // en el PNG fuente. `contain` conserva la transparencia del borde.
  const fg = Math.round(108 * factor);
  await sharp(sources.foreground)
    .resize(fg, fg, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(dir, 'ic_launcher_foreground.png'));
}

// El fondo del adaptativo es un color plano; se declara en `values/ic_launcher_background.xml` en
// vez de arrastrar otro PNG por densidad. Ese XML lo escribe el scaffold y este script no lo toca:
// si cambia el color de marca, cambia en `render-brand.mjs` y en ese XML.

// ── Splash ───────────────────────────────────────────────────────────────────
for (const { dir, width, height } of SPLASHES) {
  const target = join(res, dir);
  await mkdir(target, { recursive: true });
  await sharp(sources.splash)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .png()
    .toFile(join(target, 'splash.png'));
}

console.log(`Iconos y splash sincronizados: ${DENSITIES.length} densidades, ${SPLASHES.length} splash.`);
