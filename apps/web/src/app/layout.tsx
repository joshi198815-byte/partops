import type { Metadata, Viewport } from 'next';
import { Archivo, JetBrains_Mono, Public_Sans } from 'next/font/google';
import './globals.css';

/**
 * Tres tipografías, cada una con un trabajo:
 *  - Archivo (display): titulares y cifras. Condensada y de pesos altos, aguanta números grandes.
 *  - Public Sans (texto): interfaz y tablas. Probada en pantallas malas y a pleno sol.
 *  - JetBrains Mono (datos): SKU, OEM, folios. Cero ambigüedad entre 0/O y 1/l.
 */
const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  weight: ['500', '600', '700', '800'],
  display: 'swap',
});

const publicSans = Public_Sans({
  subsets: ['latin'],
  variable: '--font-public-sans',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'PartOps — Inventario y venta de repuestos',
    template: '%s · PartOps',
  },
  description:
    'Sistema de inventario, venta y despacho para bodegas de repuestos automotrices en Guatemala. Catálogo por vehículo, existencias por bodega y recibos en segundos.',
  applicationName: 'PartOps',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/brand/apple-icon-180.png', sizes: '180x180' }],
  },
  openGraph: {
    type: 'website',
    locale: 'es_GT',
    siteName: 'PartOps',
    title: 'PartOps — Inventario y venta de repuestos',
    description:
      'Catálogo por vehículo, existencias por bodega y despacho sin sobresaltos. Hecho para bodegas de repuestos en Guatemala.',
    images: [{ url: '/brand/og-image.png', width: 1200, height: 630 }],
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F5F1' },
    { media: '(prefers-color-scheme: dark)', color: '#0E2233' },
  ],
  width: 'device-width',
  initialScale: 1,
  // El vendedor hace zoom con dos dedos sobre una tabla de precios: no se bloquea.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-GT" suppressHydrationWarning>
      <body className={`${archivo.variable} ${publicSans.variable} ${jetbrains.variable}`}>{children}</body>
    </html>
  );
}
