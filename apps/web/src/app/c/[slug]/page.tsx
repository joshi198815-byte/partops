import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchCatalog, parseStorefrontQuery } from '@/lib/public-catalog';
import { CatalogScreen } from './_components/catalog-screen';
import { StorefrontShell } from './_components/storefront-shell';

/**
 * Vitrina de un negocio: `partops.gt/c/<slug>`.
 *
 * Se resuelve entero en el servidor. El cliente que llega desde un estado de WhatsApp abre un
 * enlace en un teléfono con datos móviles: la primera pintura tiene que traer piezas, precios y
 * "hay / últimas / agotado" sin esperar a que hidrate JavaScript.
 *
 * Todo depende del `slug` y de la query, y la API ya cachea 30 segundos en el borde. Aquí se deja
 * que Next revalide con el mismo criterio: un precio puede esperar medio minuto, un pedido no.
 */
export const revalidate = 30;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const [{ slug }, raw] = await Promise.all([params, searchParams]);
  const data = await fetchCatalog(slug, parseStorefrontQuery(raw));
  if (!data) {
    // Un negocio que no existe y uno suspendido responden igual: decir cuál es cuál permitiría
    // enumerar las bodegas que hay en el país.
    return { title: 'Catálogo no disponible', robots: { index: false, follow: false } };
  }
  const title = `${data.shop.name} · Catálogo de repuestos`;
  const description =
    data.shop.tagline ??
    `Piezas por vehículo con existencia confirmada. Pide en línea y la bodega te confirma por WhatsApp.`;
  return {
    title,
    description,
    alternates: { canonical: `/c/${data.shop.slug}` },
    // Cada negocio se instala con su propio nombre y color: el manifest es del catálogo, no del sistema.
    manifest: `/c/${data.shop.slug}/manifest.webmanifest`,
    applicationName: data.shop.name,
    openGraph: { type: 'website', title, description, siteName: data.shop.name },
    robots: { index: true, follow: true },
  };
}

export default async function ShopPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, raw] = await Promise.all([params, searchParams]);
  const query = parseStorefrontQuery(raw);
  const data = await fetchCatalog(slug, query);
  if (!data) notFound();

  // El título de la pestaña también dice en qué se filtró: con cinco pestañas abiertas, "Toyota
  // Corolla 2009" es la única forma de saber cuál es cuál.
  const filtered = [query.brand, query.model, query.year].filter(Boolean).join(' ');

  return (
    <StorefrontShell shop={data.shop} turnstile={data.turnstile}>
      {filtered ? (
        <p className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-1.5 text-center text-[11.5px] text-[var(--foreground-muted)]">
          Mostrando piezas para <span className="font-medium text-[var(--foreground)]">{filtered}</span>
        </p>
      ) : null}
      <CatalogScreen data={data} query={query} />
    </StorefrontShell>
  );
}
