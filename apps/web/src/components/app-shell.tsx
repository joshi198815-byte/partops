'use client';

import type { MeResponse } from '@partops/contracts';
import { PartOpsLogo } from '@partops/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { signOut } from '@/lib/auth';
import { CommandPalette } from './command-palette';

/**
 * Marco de la aplicación.
 *
 * La navegación se arma desde los permisos que devuelve `/me`, no desde el rol: un rol propio
 * creado en Equipo con solo `orders.create` ve Ventas y nada más, sin que haya que tocar este
 * archivo. El servidor vuelve a comprobar cada permiso en cada request — esto es comodidad, no
 * seguridad.
 */
interface NavItem {
  href: string;
  label: string;
  permission?: string;
  /** Se dibuja separado, abajo, porque es otra clase de cosa: no opera, configura. */
  group: 'operar' | 'negocio';
}

const NAV: NavItem[] = [
  { href: '/app', label: 'Tablero', permission: 'dashboard.view', group: 'operar' },
  { href: '/app/buscar', label: 'Buscar pieza', permission: 'catalog.view', group: 'operar' },
  { href: '/app/demanda', label: 'Demanda', permission: 'demand.view', group: 'operar' },
  { href: '/app/inventario', label: 'Inventario', permission: 'inventory.view', group: 'operar' },
  { href: '/app/ventas', label: 'Ventas', permission: 'orders.view', group: 'operar' },
  { href: '/app/despacho', label: 'Despacho', permission: 'orders.dispatch', group: 'operar' },
  { href: '/app/catalogo', label: 'Catálogo', permission: 'catalog.view', group: 'negocio' },
  { href: '/app/finanzas', label: 'Finanzas', permission: 'finance.view', group: 'negocio' },
  { href: '/app/equipo', label: 'Equipo', permission: 'team.manage', group: 'negocio' },
  { href: '/app/auditoria', label: 'Auditoría', permission: 'audit.view', group: 'negocio' },
  { href: '/app/configuracion', label: 'Configuración', permission: 'settings.manage', group: 'negocio' },
];
export function AppShell({ me, children }: { me: MeResponse; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const perms = new Set(me.tenant?.permissions ?? []);
  const visible = NAV.filter((item) => !item.permission || perms.has(item.permission));
  const operating = visible.filter((i) => i.group === 'operar');
  const managing = visible.filter((i) => i.group === 'negocio');

  return (
    <div className="min-h-dvh bg-[var(--background)] lg:grid lg:grid-cols-[208px_1fr]">
      {/* Barra lateral. En móvil se colapsa a una fila horizontal con scroll: el bodeguero trabaja
          con una mano y el menú completo le quitaría media pantalla. */}
      <aside className="border-b border-[var(--border)] bg-[var(--surface)] lg:sticky lg:top-0 lg:h-dvh lg:border-b-0 lg:border-r">
        <div className="flex h-14 items-center justify-between px-4">
          <Link href="/app" className="inline-flex">
            <PartOpsLogo size={17} />
          </Link>
          <button
            type="button"
            className="rounded-[var(--radius-sm)] px-2 py-1 text-[12px] text-[var(--foreground-muted)] lg:hidden"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
          >
            {menuOpen ? 'Cerrar' : 'Menú'}
          </button>
        </div>

        <nav
          className={`${menuOpen ? 'block' : 'hidden'} border-t border-[var(--border)] px-2 py-2 lg:block lg:border-t-0`}
        >
          <NavGroup items={operating} pathname={pathname} onNavigate={() => setMenuOpen(false)} />
          {managing.length ? (
            <>
              <p className="mt-4 px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">
                Negocio
              </p>
              <NavGroup items={managing} pathname={pathname} onNavigate={() => setMenuOpen(false)} />
            </>
          ) : null}
        </nav>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)]/95 px-4 backdrop-blur-sm">
          <TenantSwitcher me={me} />
          <div className="flex items-center gap-1">
            <CommandPalette />
            {/* Solo el dueño de PartOps ve esta puerta. Es un enlace, no un permiso: la API vuelve
                a comprobar `user.role === 'admin'` y responde 404 a cualquier otro. */}
            {me.isPlatformAdmin ? (
              <Link
                href={'/admin' as never}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-[11.5px] font-medium text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--foreground)]"
              >
                Plataforma
              </Link>
            ) : null}
            <span className="hidden max-w-[180px] truncate text-[12.5px] text-[var(--foreground-muted)] sm:inline">
              {me.user.name}
            </span>
            <button
              type="button"
              className="rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[12.5px] text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--foreground)]"
              onClick={async () => {
                await signOut().catch(() => undefined);
                router.replace('/entrar');
                router.refresh();
              }}
            >
              Salir
            </button>
          </div>
        </header>

        <main className="px-4 py-5 sm:px-6 sm:py-7">{children}</main>
      </div>
    </div>
  );
}

function NavGroup({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        // `/app` solo coincide exacto; el resto coincide por prefijo para que las subpantallas
        // sigan marcando su sección.
        const active = item.href === '/app' ? pathname === '/app' : pathname.startsWith(item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href as never}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-[13px] transition-colors ${
                active
                  ? 'bg-[var(--surface-sunken)] font-semibold text-[var(--foreground)]'
                  : 'text-[var(--foreground-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--foreground)]'
              }`}
            >
              <span
                aria-hidden
                className={`h-3 w-0.5 rounded-full ${active ? 'bg-[var(--accent)]' : 'bg-transparent'}`}
              />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Selector de negocio. Solo aparece si hay más de uno: a quien tiene una sola bodega no se le
 * muestra un menú de una opción.
 */
function TenantSwitcher({ me }: { me: MeResponse }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!me.tenant) return <span className="text-[13px] text-[var(--foreground-muted)]">Sin negocio</span>;
  if (me.memberships.length <= 1) {
    return (
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-[var(--foreground)]">{me.tenant.name}</p>
        <p className="truncate font-mono text-[10.5px] text-[var(--foreground-muted)]">
          partops.autos/{me.tenant.slug}
        </p>
      </div>
    );
  }

  return (
    <label className="min-w-0">
      <span className="sr-only">Negocio activo</span>
      <select
        className="max-w-[240px] truncate rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[13px] font-medium text-[var(--foreground)]"
        value={me.tenant.id}
        disabled={busy}
        onChange={async (event) => {
          const tenantId = event.target.value;
          setBusy(true);
          try {
            await api('/api/me/tenant', { method: 'POST', body: { tenantId } });
            router.refresh();
            router.push('/app' as never);
          } finally {
            setBusy(false);
          }
        }}
      >
        {me.memberships.map((m) => (
          <option key={m.tenantId} value={m.tenantId} disabled={m.suspended}>
            {m.tenantName}
            {m.suspended ? ' (suspendido)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
