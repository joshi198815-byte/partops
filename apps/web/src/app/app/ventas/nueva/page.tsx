import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { NewSaleForm } from './new-sale-form';

export const metadata = { title: 'Nueva venta' };

/** T9: armar el pedido, ver el disponible por bodega y confirmar con reserva atómica. */
export default async function NuevaVentaPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio');

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('orders.create')) {
    return (
      <EmptyState
        title="No puedes crear ventas"
        description="Pide a un administrador que te dé el permiso de crear pedidos y cotizar."
      />
    );
  }

  return <NewSaleForm canOverride={perms.has('orders.price.override')} />;
}
