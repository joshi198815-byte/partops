import type { Metadata } from 'next';
import { EntrarForm } from './entrar-form';

export const metadata: Metadata = { title: 'Entrar' };

/**
 * Entrada.
 *
 * `next` se lee en el servidor: quien llega desde un enlace de invitación vuelve a ese enlace
 * después de autenticarse, y quien entra por su cuenta va a donde el servidor decida.
 */
export default async function EntrarPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Solo rutas internas: un `next` absoluto convertiría el login en un redirector abierto.
  const safe = next?.startsWith('/') && !next.startsWith('//') ? next : null;
  return <EntrarForm next={safe} />;
}
