import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { AuditScreen } from './audit-screen';

export const metadata = { title: 'Auditoría' };

/**
 * Bitácora de la Fase 4 (T15).
 *
 * El permiso se comprueba en el servidor y la pantalla no se pinta si falta: enseñar la tabla vacía
 * haría pensar que nunca pasó nada. La IP se muestra solo a quien puede ver la configuración del
 * negocio; a un contador le basta el nombre, la acción y la diferencia.
 */
export default async function AuditoriaPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio');

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('audit.view')) {
    return (
      <EmptyState
        title="No tienes acceso a la auditoría"
        description="Pide a un administrador que te dé el permiso de ver la bitácora de cambios."
      />
    );
  }

  return <AuditScreen canSeeIp={perms.has('settings.manage')} />;
}
