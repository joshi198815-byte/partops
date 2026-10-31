import type { ImportJobSummary } from '@partops/contracts';
import { EmptyState } from '@partops/ui';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireMe } from '@/lib/session';
import { ImportHistory, ImportScreen } from './import-screen';

export const metadata = { title: 'Importar catálogo' };

/**
 * T8: importación desde Excel con mapeo, vista previa y reporte de errores por fila.
 *
 * El historial se carga aquí, en el servidor: quien vuelve al día siguiente a revisar qué falló
 * encuentra su archivo listado sin tener que buscarlo en un menú aparte.
 */
export default async function ImportarPage() {
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

  // El historial es un extra: si esa llamada falla, el asistente de carga sigue sirviendo.
  const jobs = perms.has('catalog.import')
    ? await api<ImportJobSummary[]>('/api/catalog/imports').catch(() => [])
    : [];

  return (
    <>
      <ImportScreen canImport={perms.has('catalog.import')} />
      {jobs.length ? (
        <div className="mx-auto max-w-4xl">
          <ImportHistory jobs={jobs} />
        </div>
      ) : null}
    </>
  );
}
