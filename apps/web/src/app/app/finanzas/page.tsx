import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { FinanceScreen } from './finance-screen';

export const metadata = { title: 'Finanzas' };

/**
 * T14: ventas, costo congelado, gastos y utilidad con exportación.
 *
 * Los permisos se resuelven en el servidor:
 *
 *  - `finance.view` abre la pantalla. Sin él, el enlace ni siquiera aparece en el menú.
 *  - `finance.cost.view` decide si los márgenes se ven. Un vendedor con `finance.view` ve ventas
 *    del día —lo que necesita para cobrar— sin ver cuánto gana el negocio.
 *  - `finance.expenses.manage` habilita capturar y borrar gastos. Ver un gasto no es poder
 *    inventarlo.
 *  - `finance.export` habilita descargar. El archivo sale del sistema y se reenvía por correo.
 */
export default async function FinanzasPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.tenant) redirect('/onboarding/negocio');

  const perms = new Set(me.tenant.permissions);
  if (!perms.has('finance.view')) {
    return (
      <EmptyState
        title="No tienes acceso a finanzas"
        description="Pide a un administrador que te dé el permiso de ver ventas, costos y utilidad."
      />
    );
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala' }).format(new Date());

  return (
    <FinanceScreen
      canManageExpenses={perms.has('finance.expenses.manage')}
      canExport={perms.has('finance.export')}
      canSeeCost={perms.has('finance.cost.view')}
      from={`${today.slice(0, 7)}-01`}
      to={today}
    />
  );
}
