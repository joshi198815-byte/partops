import type { Metadata } from 'next';
import { RecuperarScreen } from './recuperar-screen';

export const metadata: Metadata = { title: 'Recuperar acceso' };

/**
 * El token llega en la query porque así lo arma Better Auth al crear el enlace del correo. Se lee
 * en el servidor para que la pantalla no dependa de `useSearchParams` y pueda pintarse de una vez.
 */
export default async function RecuperarPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <RecuperarScreen token={token ?? null} />;
}
