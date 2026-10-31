import { fetchCatalog } from '@/lib/public-catalog';
import { safeColor } from '@/lib/shop-theme';

/**
 * Manifest por negocio.
 *
 * El catálogo se instala en el teléfono del cliente y tiene que abrirse como "Repuestos El
 * Tornillo", no como "PartOps": quien lo instala quiere la bodega, no el sistema que la sirve. El
 * nombre, el color y la pantalla de arranque salen del negocio; los iconos son los mismos de la
 * plataforma mientras la bodega no suba los suyos, porque un manifest sin iconos no se puede
 * instalar en Android.
 *
 * `start_url` apunta a la portada del negocio sin filtros: instalar una búsqueda concreta dejaría al
 * cliente entrando siempre a "capo corolla 2009".
 */
export const revalidate = 3600;

const ICONS = [
  { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await fetchCatalog(slug);
  // Sin negocio no hay manifest que instalar. 404 y no una marca genérica: instalar "PartOps" desde
  // un enlace roto confunde más que no poder instalar nada.
  if (!data) return new Response('Not found', { status: 404 });

  const { shop } = data;
  const manifest = {
    name: `${shop.name} · Catálogo`,
    short_name: shop.name.slice(0, 12),
    description: shop.tagline ?? `Catálogo de repuestos de ${shop.name}.`,
    lang: 'es-GT',
    dir: 'ltr',
    start_url: `/c/${shop.slug}`,
    scope: `/c/${shop.slug}`,
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#F7F5F1',
    theme_color: safeColor(shop.brandPrimary, '#16324F'),
    icons: ICONS,
  };

  return Response.json(manifest, {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
