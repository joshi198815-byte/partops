import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { SearchScreen } from './search-screen';

export const metadata = { title: 'Buscar pieza' };

/**
 * T5: búsqueda determinista por OEM, nombre y año, con facetas de vehículo y registro de demanda.
 *
 * Los permisos se resuelven en el servidor y se pasan como booleanos: la pantalla no decide nada
 * de seguridad, solo deja de pedir datos que no puede mostrar (el costo, la demanda incumplida).
 */
export default async function BuscarPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio');

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('catalog.view')) {
    return (
      <EmptyState
        title="No tienes acceso al catálogo"
        description="Pide a un administrador que te dé el permiso de ver piezas y compatibilidades."
      />
    );
  }

  return <SearchScreen canSeeDemand={perms.has('demand.view')} canSeeCost={perms.has('catalog.cost.view')} />;
}
