import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import Dashboard from './dashboard';

/**
 * Raíz de la aplicación.
 *
 * Aquí solo se decide si esta persona entra al tablero o si su oficio la manda a otra pantalla
 * (despacho para el bodeguero, ventas para el vendedor). La regla vive en `homePath`, que calcula
 * el servidor; duplicarla en el login y en el enlace del correo acabaría en dos listas distintas.
 */
export default async function AppIndex() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (me.homePath !== '/app') redirect(me.homePath as never);
  return <Dashboard me={me} />;
}
