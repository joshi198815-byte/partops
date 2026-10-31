import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchPublicPart } from '@/lib/public-catalog';
import { StorefrontShell } from '../_components/storefront-shell';
import { PartDetailScreen } from './_components/part-detail-screen';

/**
 * Ficha de pieza: `/c/<slug>/<slug-de-pieza>` — y también por SKU u OEM, que es lo que llega por
 * WhatsApp cuando el vendedor pega una referencia en vez de un enlace.
 *
 * `noindex`: la ficha de una pieza agotada no debe quedarse en Google con un precio viejo. La
 * portada del negocio sí se indexa; la pieza concreta se comparte por enlace.
 */
export const revalidate = 120;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; partSlug: string }>;
}): Promise<Metadata> {
  const { slug, partSlug } = await params;
  const data = await fetchPublicPart(slug, partSlug);
  if (!data) {
    return { title: 'Pieza no encontrada', robots: { index: false, follow: false } };
  }
  const { part, shop } = data;
  const title = `${part.name} · ${shop.name}`;
  const description = [
    part.brand,
    part.vehicles[0]
      ? `para ${part.vehicles[0].brand} ${part.vehicles[0].model} ${part.vehicles[0].yearStart}–${part.vehicles[0].yearEnd}`
      : null,
    part.variants[0] ? `SKU ${part.variants[0].sku}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    title,
    description,
    openGraph: {
      type: 'website',
      title,
      description,
      siteName: shop.name,
      images: part.imageUrl ? [{ url: part.imageUrl }] : undefined,
    },
    alternates: { canonical: `/c/${shop.slug}/${partSlug}` },
    manifest: `/c/${shop.slug}/manifest.webmanifest`,
    applicationName: shop.name,
    robots: { index: false, follow: true },
  };
}

export default async function PublicPartPage({
  params,
}: {
  params: Promise<{ slug: string; partSlug: string }>;
}) {
  const { slug, partSlug } = await params;
  const data = await fetchPublicPart(slug, partSlug);
  if (!data) notFound();

  return (
    <StorefrontShell shop={data.shop} turnstile={data.turnstile}>
      <PartDetailScreen
        part={data.part}
        shopSlug={data.shop.slug}
        shopName={data.shop.name}
        currency={data.shop.currency}
        whatsappE164={data.shop.whatsappE164}
        pricesIncludeTax={data.shop.pricesIncludeTax}
      />
    </StorefrontShell>
  );
}
