import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { SalesScreen } from './sales-screen';

export const metadata = { title: 'Ventas' };

/**
 * T9: pedidos con surtido por línea, reservas atómicas e idempotencia por clave de cliente.
 *
 * Los permisos se resuelven aquí y se pasan como booleanos: la pantalla no decide seguridad, solo
 * deja de ofrecer botones que la API rechazaría.
 */
export default async function VentasPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio');

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('orders.view')) {
    return (
      <EmptyState
        title="No tienes acceso a las ventas"
        description="Pide a un administrador que te dé el permiso de ver pedidos."
      />
    );
  }

  return (
    <SalesScreen
      canCreate={perms.has('orders.create')}
      canDispatch={perms.has('orders.dispatch')}
      canCancel={perms.has('orders.cancel')}
      canSeeCost={perms.has('catalog.cost.view')}
      canResendReceipt={perms.has('orders.receipt.resend')}
    />
  );
}
