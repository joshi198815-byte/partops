import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { InventoryScreen } from './inventory-screen';

export const metadata = { title: 'Inventario' };

/**
 * T7: ledger inmutable, reservas atómicas, traslados entre bodegas y puntos de reorden.
 *
 * Los permisos se resuelven aquí y se pasan como booleanos: la pantalla no decide seguridad, solo
 * deja de ofrecer botones que la API rechazaría. Quien solo puede ver no ve el formulario de
 * traslado, ni siquiera deshabilitado.
 */
export default async function InventarioPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio');

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('inventory.view')) {
    return (
      <EmptyState
        title="No tienes acceso al inventario"
        description="Pide a un administrador que te dé el permiso de ver existencias por bodega."
      />
    );
  }

  return (
    <InventoryScreen
      canAdjust={perms.has('inventory.adjust')}
      canTransfer={perms.has('inventory.transfer')}
    />
  );
}
