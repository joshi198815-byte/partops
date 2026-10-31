import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { DispatchScreen } from './dispatch-screen';

export const metadata = { title: 'Despacho' };

/**
 * T10: lista de preparación con realtime, escáner y cola offline en el teléfono del bodeguero.
 *
 * Los permisos se resuelven en el servidor y se pasan como banderas: la pantalla no decide
 * seguridad, solo deja de ofrecer lo que la API rechazaría. `canTransfer` no autoriza nada por sí
 * solo —solo cambia el texto de ayuda cuando la pieza falta—, pero evita sugerir un traslado que la
 * persona no puede crear.
 */
export default async function DespachoPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio' as never);

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('orders.dispatch')) {
    return (
      <EmptyState
        title="No tienes acceso al despacho"
        description="Pide a un administrador que te dé el permiso de preparar y despachar pedidos."
      />
    );
  }

  return <DispatchScreen canTransfer={perms.has('inventory.transfer')} soundDefault />;
}
