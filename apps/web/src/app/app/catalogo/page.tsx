import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { CatalogScreen } from './catalog-screen';

export const metadata = { title: 'Catálogo' };

/**
 * T6: piezas con variantes, compatibilidad por vehículo e imágenes optimizadas.
 *
 * Los permisos se resuelven en el servidor y se pasan como booleanos. La pantalla no decide nada
 * de seguridad; solo deja de ofrecer botones que la API rechazaría. El costo viaja como `null`
 * desde el backend, así que ni siquiera está en el HTML de quien no puede verlo.
 */
export default async function CatalogoPage() {
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

  return (
    <CatalogScreen
      canCreate={perms.has('catalog.create')}
      canUpdate={perms.has('catalog.update')}
      canArchive={perms.has('catalog.archive')}
      canAdjust={perms.has('inventory.adjust')}
      canSeeCost={perms.has('catalog.cost.view')}
    />
  );
}
