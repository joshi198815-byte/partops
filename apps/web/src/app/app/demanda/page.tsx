import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { DemandScreen } from './demand-screen';

export const metadata = { title: 'Demanda' };

/**
 * T13: demanda incumplida, avisos de llegada y evolución.
 *
 * Los permisos se resuelven en el servidor y se pasan como booleanos. La bandeja la ve cualquiera
 * con `demand.view` porque saber quién espera una pieza es parte de atender el mostrador; los
 * botones que mandan WhatsApp en lote piden `demand.watch.manage`, que es la acción que el cliente
 * siente.
 */
export default async function DemandaPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio');

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('demand.view')) {
    return (
      <EmptyState
        title="No tienes acceso a la demanda"
        description="Pide a un administrador que te dé el permiso de ver búsquedas sin existencia."
      />
    );
  }

  return (
    <DemandScreen
      canNotify={perms.has('demand.watch.manage')}
      canSeeCost={perms.has('catalog.cost.view')}
      shopSlug={me.tenant.slug}
    />
  );
}
