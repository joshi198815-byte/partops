import { PartOpsLogo } from '@partops/ui';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireMe } from '@/lib/session';
import { AdminScreen } from './admin-screen';

export const metadata = { title: 'Plataforma', robots: { index: false, follow: false } };

/**
 * Panel interno de PartOps.
 *
 * Vive fuera de `/app` a propósito: no cuelga de un negocio, y quien lo abre puede no pertenecer a
 * ninguno. Por eso tiene su propio marco mínimo —logo y salida— en vez del `AppShell`, que asume
 * negocio activo, selector de sucursal y menú por permisos.
 *
 * Un usuario normal recibe 404 y no 403, igual que en la API: el panel no confirma su existencia.
 * Además va con `noindex`: si alguien adivina la ruta, no debe encontrarla en Google.
 */
export default async function AdminPage() {
  const me = await requireMe().catch(() => null);
  if (!me) redirect('/entrar');
  if (!me.isPlatformAdmin) notFound();

  return (
    <div className="min-h-dvh bg-[var(--background)]">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)]/95 px-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Link href="/admin">
            <PartOpsLogo size={17} />
          </Link>
          <span className="rounded-[var(--radius-xs)] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--foreground-muted)]">
            Plataforma
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="hidden max-w-[180px] truncate text-[12.5px] text-[var(--foreground-muted)] sm:inline">
            {me.user.email}
          </span>
          {me.homePath.startsWith('/app') ? (
            <Link
              href="/app"
              className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[12.5px] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--foreground)]"
            >
              Mi negocio
            </Link>
          ) : null}
        </div>
      </header>

      <main className="px-4 py-5 sm:px-6 sm:py-7">
        <AdminScreen />
      </main>
    </div>
  );
}
