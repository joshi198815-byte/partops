import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { NoAccess, TeamScreen } from './team-screen';

export const metadata = { title: 'Equipo' };

/**
 * Equipo.
 *
 * La comprobación de permisos aquí es de presentación; el servidor vuelve a exigir `team.manage`
 * en cada endpoint. Se hace igual para no mostrar una pantalla que va a fallar en la primera
 * llamada.
 */
export default async function EquipoPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');

  const perms = new Set(me.tenant?.permissions ?? []);
  if (!perms.has('team.manage')) return <NoAccess />;

  return <TeamScreen currentUserId={me.user.id} />;
}
