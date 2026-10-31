import type { MeResponse } from '@partops/contracts';
import { CodeChip, EmptyState, PartOpsMark, StatTile } from '@partops/ui';
import Link from 'next/link';
import { requireMe, serverFetch } from '@/lib/session';

interface Overview {
  parts: number;
  variants: number;
  lowStock: number;
  outOfStock: number;
  missedSearches: number;
  warehouseCount: number;
}

/**
 * Tablero.
 *
 * Las cifras salen de `/api/catalog/overview`, no de un cálculo en el cliente ni de un texto fijo.
 * Antes esta pantalla decía "todavía no hay piezas cargadas" siempre, incluso con catálogo: una
 * afirmación falsa es peor que una pantalla vacía, porque nadie va a buscarla para desmentirla.
 *
 * Lo que no hay todavía (ventas del día, utilidad) no se pinta con ceros: un cero es un dato y
 * aquí sería una mentira.
 */
export default async function Dashboard({ me }: { me?: MeResponse }) {
  const session = me ?? (await requireMe());
  const perms = new Set(session.tenant?.permissions ?? []);
  const firstName = session.user.name.split(' ')[0] ?? session.user.name;

  // Un fallo del resumen no debe tumbar el tablero: se muestra el catálogo como "sin datos" y el
  // resto de la pantalla sigue sirviendo para trabajar.
  const overview = await serverFetch('/api/catalog/overview')
    .then((res) => (res.ok ? (res.json() as Promise<Overview>) : null))
    .catch(() => null);

  const actions = [
    {
      href: '/app/buscar',
      permission: 'catalog.view',
      title: 'Buscar una pieza',
      body: 'Por número OEM, nombre o como lo dice el cliente en el mostrador.',
    },
    {
      href: '/app/ventas/nueva',
      permission: 'orders.create',
      title: 'Nueva venta',
      body: 'Arma el pedido, reserva la pieza y deja la línea lista para despacho.',
    },
    {
      href: '/app/despacho',
      permission: 'orders.dispatch',
      title: 'Preparar pedidos',
      body: 'La lista de lo que hay que sacar del estante, con escáner.',
    },
    {
      href: '/app/catalogo/importar',
      permission: 'catalog.import',
      title: 'Importar catálogo',
      body: 'Sube el Excel que ya tienes. Se revisa antes de guardar nada.',
    },
    {
      href: '/app/finanzas',
      permission: 'finance.view',
      title: 'Ver finanzas',
      body: 'Ventas del mes, costo de lo vendido, gastos y utilidad real.',
    },
  ].filter((a) => perms.has(a.permission));

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          Buen día, {firstName}
        </h1>
        <p className="mt-1 text-[13px] text-[var(--foreground-muted)]">
          {session.tenant?.name} ·{' '}
          <span className="font-mono text-[12px]">partops.gt/{session.tenant?.slug}</span>
        </p>
      </header>

      <section aria-labelledby="empezar" className="mb-8">
        <h2
          id="empezar"
          className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
        >
          Para empezar
        </h2>
        {actions.length ? (
          <ul className="grid gap-px overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
            {actions.map((a) => (
              <li key={a.href} className="bg-[var(--surface)]">
                <Link
                  href={a.href as never}
                  className="block h-full p-4 transition-colors hover:bg-[var(--surface-sunken)]"
                >
                  <span className="block text-[13.5px] font-semibold text-[var(--foreground)]">
                    {a.title}
                  </span>
                  <span className="mt-1 block text-[12.5px] leading-snug text-[var(--foreground-muted)]">
                    {a.body}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="estado" className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <h2
            id="estado"
            className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]"
          >
            Catálogo
          </h2>
          {overview && overview.parts > 0 ? (
            <div className="grid gap-px overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
              <StatTile
                label="Piezas activas"
                value={String(overview.parts)}
                hint={`${overview.variants} ${overview.variants === 1 ? 'variante' : 'variantes'} en ${overview.warehouseCount} ${overview.warehouseCount === 1 ? 'bodega' : 'bodegas'}`}
                className="rounded-none border-0"
              />
              <StatTile
                label="Bajo el mínimo"
                value={String(overview.lowStock)}
                hint={overview.lowStock > 0 ? 'Reponer antes de la próxima venta' : 'Nada por reponer'}
                className="rounded-none border-0"
              />
              <StatTile
                label="Sin existencia"
                value={String(overview.outOfStock)}
                hint={
                  overview.outOfStock > 0
                    ? 'Alguien va a preguntar por esto'
                    : 'Todo lo del catálogo tiene existencia'
                }
                className="rounded-none border-0"
              />
              <StatTile
                label="Búsquedas sin resultado"
                value={String(overview.missedSearches)}
                hint="Últimos 30 días"
                className="rounded-none border-0"
              />
            </div>
          ) : (
            <EmptyState
              icon={<PartOpsMark size={22} />}
              title="Todavía no hay piezas cargadas"
              description="Importa tu Excel actual o captura la primera pieza. En cuanto haya catálogo, aquí aparecen las existencias por bodega y lo que está bajo el mínimo."
              action={
                perms.has('catalog.import') ? (
                  <Link
                    href={'/app/catalogo/importar' as never}
                    className="rounded-[var(--radius-sm)] bg-[var(--primary)] px-4 py-2 text-[13px] font-medium text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]"
                  >
                    Importar catálogo
                  </Link>
                ) : null
              }
            />
          )}

          {overview && overview.missedSearches > 0 && perms.has('demand.view') ? (
            <p className="mt-3 text-[12.5px] leading-snug text-[var(--foreground-muted)]">
              Hay clientes buscando piezas que no tienes. La lista está al pie de{' '}
              <Link
                href={'/app/buscar' as never}
                className="font-medium text-[var(--color-copper-700)] hover:underline"
              >
                Buscar pieza
              </Link>
              .
            </p>
          ) : null}
        </div>

        <div>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
            Tu acceso
          </h2>
          <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-[13px] text-[var(--foreground)]">
              Rol: <span className="font-semibold">{session.tenant?.role}</span>
            </p>
            <p className="mt-2 text-[11.5px] text-[var(--foreground-muted)]">
              {session.tenant?.warehouseIds.length
                ? `Bodegas asignadas: ${session.tenant.warehouseIds.length}`
                : 'Acceso a todas las bodegas'}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {[...perms].slice(0, 6).map((p) => (
                <CodeChip key={p} tone="muted">
                  {p}
                </CodeChip>
              ))}
              {perms.size > 6 ? (
                <span className="self-center text-[11px] text-[var(--foreground-muted)]">
                  +{perms.size - 6}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
