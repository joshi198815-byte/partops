import type { PublicCatalogResponse, PublicPartResponse } from '@partops/contracts';
import type { Route } from 'next';

/**
 * Lectura del catálogo público desde el servidor de Next.
 *
 * La vitrina se cachea en el borde (`s-maxage=30` en la API) y aquí se deja que Next reuse la
 * respuesta esos mismos 30 segundos: el precio de una pieza puede esperar medio minuto, pero un
 * pedido no —por eso `order` va siempre por el cliente y sin caché.
 *
 * Un negocio inexistente, deshabilitado o suspendido devuelve lo mismo desde la API. Aquí solo se
 * traduce a `null` y la página responde 404; no hay una rama distinta por motivo, porque contarla
 * sería decir qué bodegas existen.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export const SHOP_SLUG_RE = /^[a-z0-9-]{2,48}$/;

export interface StorefrontQuery {
  q: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  page: number;
}

export const EMPTY_QUERY: StorefrontQuery = { q: '', brand: null, model: null, year: null, page: 1 };

type RawParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Lee la URL sin confiar en ella: un `page=abc` es la página 1, no una pantalla de error. */
export function parseStorefrontQuery(raw: RawParams): StorefrontQuery {
  const page = Number(first(raw.page));
  const year = Number(first(raw.year));
  return {
    q: (first(raw.q) ?? '').trim().slice(0, 120),
    brand: (first(raw.brand) ?? '').trim().slice(0, 60) || null,
    model: (first(raw.model) ?? '').trim().slice(0, 60) || null,
    year: Number.isInteger(year) && year >= 1950 && year <= 2100 ? year : null,
    page: Number.isInteger(page) && page >= 1 && page <= 200 ? page : 1,
  };
}

/** Query string canónica: sin parámetros vacíos, para que el enlace que se comparte sea corto. */
export function storefrontQueryString(query: Partial<StorefrontQuery>): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.brand) params.set('brand', query.brand);
  if (query.model) params.set('model', query.model);
  if (query.year) params.set('year', String(query.year));
  if (query.page && query.page > 1) params.set('page', String(query.page));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function fetchCatalog(
  slug: string,
  query: Partial<StorefrontQuery> = {},
): Promise<PublicCatalogResponse | null> {
  const clean = slug.trim().toLowerCase();
  if (!SHOP_SLUG_RE.test(clean)) return null;
  const res = await fetch(
    `${API_URL}/api/public/catalog/${encodeURIComponent(clean)}${storefrontQueryString(query)}`,
    { next: { revalidate: 30 }, headers: { accept: 'application/json' } },
  );
  if (!res.ok) return null;
  return (await res.json()) as PublicCatalogResponse;
}

/** Ficha por slug o por SKU/OEM. Es el enlace que el cliente recibe por WhatsApp. */
export async function fetchPublicPart(slug: string, key: string): Promise<PublicPartResponse | null> {
  const clean = slug.trim().toLowerCase();
  const partKey = key.trim();
  if (!SHOP_SLUG_RE.test(clean) || !partKey || partKey.length > 120) return null;
  const res = await fetch(
    `${API_URL}/api/public/catalog/${encodeURIComponent(clean)}/part/${encodeURIComponent(partKey)}`,
    { next: { revalidate: 120 }, headers: { accept: 'application/json' } },
  );
  if (!res.ok) return null;
  return (await res.json()) as PublicPartResponse;
}

/** Ruta de la ficha, usada en enlaces y en el mensaje de WhatsApp. */
export function partPath(slug: string, partSlug: string): Route {
  return `/c/${encodeURIComponent(slug)}/${encodeURIComponent(partSlug)}` as Route;
}

/** Portada de la tienda. */
export function shopPath(slug: string): Route {
  return `/c/${encodeURIComponent(slug)}` as Route;
}
