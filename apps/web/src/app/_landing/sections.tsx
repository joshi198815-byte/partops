import { formatMoney, PLANS, type PlanTier } from '@partops/contracts';
import { PartOpsLogo } from '@partops/ui';
import type { Route } from 'next';
import Link from 'next/link';

/**
 * Las secciones de la portada.
 *
 * Todo lo que se afirma aquí es comprobable en el código de al lado: los precios salen de `PLANS`,
 * los minutos de reserva de `RESERVATION_TTL_MS` (20) y el tope de filas de importación del mismo
 * `PLANS`. Ninguna cifra está escrita a mano en el JSX.
 */

const RESERVATION_MINUTES = 20;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--background)]/94 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
        <Link href="/" className="inline-flex" aria-label="PartOps, inicio">
          <PartOpsLogo size={20} />
        </Link>
        <nav className="hidden items-center gap-6 text-[13px] text-[var(--foreground-muted)] sm:flex">
          {/* Rutas absolutas: `/planes` también monta esta cabecera, y un `#flujo` suelto ahí no
              lleva a ninguna parte. Con `/` delante, el ancla funciona en las dos páginas. */}
          <Link href="/#flujo" className="hover:text-[var(--foreground)]">
            Cómo funciona
          </Link>
          <Link href="/#reglas" className="hover:text-[var(--foreground)]">
            Lo que no deja pasar
          </Link>
          <Link href="/planes" className="hover:text-[var(--foreground)]">
            Planes
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Link
            href="/entrar"
            className="text-[13px] font-medium text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
          >
            Entrar
          </Link>
          <Link
            href="/registro"
            className="inline-flex h-9 items-center rounded-[var(--radius-sm)] bg-[var(--primary)] px-3.5 text-[13px] font-medium text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary-hover)]"
          >
            Crear cuenta
          </Link>
        </div>
      </div>
    </header>
  );
}

export function Workflow() {
  const steps = [
    {
      n: '01',
      title: 'Busca como habla el cliente',
      body: '“cubierta”, “focos”, “balatas”, “el capó del corolla 2009”. Separa pieza, marca, modelo y año sin pedirle al vendedor que traduzca nada.',
    },
    {
      n: '02',
      title: 'Ve dónde está, no solo si hay',
      body: 'Existencia por bodega, pasillo y estante. Lo que no hay queda anotado como demanda: al cerrar el mes sabes qué comprar.',
    },
    {
      n: '03',
      title: 'Reserva y despacha',
      body: `La venta aparta la pieza al instante. El bodeguero la ve en su teléfono, escanea y entrega. Si nadie la prepara en ${RESERVATION_MINUTES} minutos, vuelve sola al estante.`,
    },
    {
      n: '04',
      title: 'Entrega el recibo',
      body: 'Con NIT, folio y garantía, en carta o en 80 mm. Se comparte por WhatsApp con un enlace que el cliente abre sin crear cuenta.',
    },
  ];

  return (
    <section id="flujo" className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <div className="max-w-2xl">
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.6vw,2rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Una venta, cuatro momentos donde hoy se pierde plata
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--foreground-muted)]">
            Existencia que no aparece, la misma pieza reservada dos veces y recibos escritos a mano. El
            sistema cubre el recorrido completo, no una parte.
          </p>
        </div>

        <ol className="partops-shelf mt-9 grid gap-px overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s) => (
            <li key={s.n} className="bg-[var(--surface)] p-5">
              <span className="partops-num font-mono text-[11px] font-semibold text-[var(--color-copper-700)]">
                {s.n}
              </span>
              <h3 className="mt-2 text-[14px] font-semibold text-[var(--foreground)]">{s.title}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function Rules() {
  const rules = [
    {
      title: 'Una pieza, una reserva',
      body: 'Dos vendedores no pueden apartar la misma unidad. La segunda venta ve la existencia real, no la de hace un minuto.',
    },
    {
      title: 'El historial no se reescribe',
      body: 'Cada movimiento de existencia es una fila nueva. No hay edición ni borrado: si algo se ajustó, se ajusta con otro movimiento.',
    },
    {
      title: 'El costo queda congelado',
      body: 'La línea de venta guarda el costo del día. Si el proveedor sube el precio mañana, la utilidad del mes pasado no cambia.',
    },
    {
      title: 'Cada bodega ve solo lo suyo',
      body: 'El aislamiento no es una condición en el código: la base de datos lo impone por negocio, incluso si alguien se equivoca.',
    },
    {
      title: 'El recibo no se corrige por dentro',
      body: 'Se emite una nota. El folio que ya salió con el cliente sigue siendo el mismo documento.',
    },
  ];

  return (
    <section id="reglas" className="border-b border-[var(--border)]">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.6vw,2rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
              Las reglas que un Excel no puede sostener
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-[var(--foreground-muted)]">
              Son cinco y están en la base, no en un manual. Si una se rompe, se rompe para todos y se nota el
              mismo día.
            </p>
          </div>

          <ol className="space-y-px overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--border)]">
            {rules.map((rule, i) => (
              <li key={rule.title} className="flex gap-4 bg-[var(--surface)] p-4">
                <span className="partops-num mt-0.5 shrink-0 font-mono text-[11px] font-semibold text-[var(--color-copper-700)]">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="text-[13.5px] font-semibold text-[var(--foreground)]">{rule.title}</h3>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">
                    {rule.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

const PLAN_ORDER: PlanTier[] = ['FREE', 'PRO', 'TALLER'];

/** Tope con separador de miles, o «sin tope». La misma idea que `usageLabel` sin el consumo. */
function limitLabel(limit: number | null, unit: string): string {
  if (limit === null) return 'sin tope';
  return `${limit.toLocaleString('es-GT')} ${unit}`;
}

export function PlansTeaser() {
  return (
    <section id="planes" className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.6vw,2rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
              Tres planes, sin letra chica
            </h2>
            <p className="mt-2 text-[14px] leading-relaxed text-[var(--foreground-muted)]">
              Lo que cambia es cuánto cabe: piezas, usuarios, filas de Excel y si tu catálogo se publica.
              Ventas, inventario y recibos van en los tres.
            </p>
          </div>
          <Link
            href="/planes"
            className="text-[13px] font-medium text-[var(--color-copper-700)] hover:underline"
          >
            Comparar los tres →
          </Link>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {PLAN_ORDER.map((tier) => {
            const plan = PLANS[tier];
            return (
              <article
                key={tier}
                className="partops-ticket rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--background)] p-5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-[13px] font-bold uppercase tracking-[0.06em] text-[var(--foreground)]">
                    {plan.name}
                  </h3>
                  <p className="partops-num font-[family-name:var(--font-display)] text-[22px] font-extrabold leading-none tracking-[-0.02em] text-[var(--foreground)]">
                    {plan.priceCentsPerMonth === 0 ? 'Q 0' : formatMoney(plan.priceCentsPerMonth, 'GTQ')}
                    <span className="ml-1 font-sans text-[11px] font-normal text-[var(--foreground-muted)]">
                      /mes
                    </span>
                  </p>
                </div>
                <p className="mt-2 min-h-[2.5rem] text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">
                  {plan.tagline}
                </p>

                <dl className="mt-4 space-y-1.5 border-t border-[var(--border)] pt-3 text-[12px]">
                  <Row label="Piezas" value={limitLabel(plan.limits.parts, 'piezas')} />
                  <Row label="Usuarios" value={limitLabel(plan.limits.members, 'usuarios')} />
                  <Row label="Excel por archivo" value={limitLabel(plan.limits.importRowsPerFile, 'filas')} />
                  <Row label="Catálogo público" value={plan.limits.publicCatalog ? 'Sí' : 'No'} />
                </dl>

                <Link
                  href={(tier === 'FREE' ? '/registro' : '/planes') as Route}
                  className="mt-4 inline-flex text-[12.5px] font-medium text-[var(--color-copper-700)] hover:underline"
                >
                  {tier === 'FREE' ? 'Empezar gratis' : 'Ver qué incluye'}
                </Link>
              </article>
            );
          })}
        </div>

        <p className="mt-4 text-[11.5px] text-[var(--foreground-muted)]">
          Precios en quetzales, IVA incluido. Se paga por transferencia o tarjeta con factura.
        </p>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--foreground-muted)]">{label}</dt>
      <dd className="partops-num font-medium text-[var(--foreground)]">{value}</dd>
    </div>
  );
}

export function ImportStory() {
  return (
    <section className="border-b border-[var(--border)]">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 lg:grid-cols-[1fr_1fr]">
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.5rem,2.6vw,2rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Tu Excel entra tal como está
          </h2>
          <p className="mt-3 text-[14px] leading-relaxed text-[var(--foreground-muted)]">
            No hay que capturar el catálogo otra vez. Se sube el archivo, el sistema muestra fila por fila qué
            entendió —marca, modelo, años, existencia, bodega— y lo que no cuadra se corrige antes de guardar.
            Nada se escribe hasta que se confirma.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-[var(--foreground-muted)]">
            Una pieza que ya existe se actualiza; una nueva se crea. Y si el plan ya no da para más piezas, lo
            dice antes de empezar, no a la mitad.
          </p>
        </div>

        <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <span className="font-mono text-[11px] text-[var(--foreground-muted)]">
              catalogo-octubre.xlsx
            </span>
            <span className="partops-num text-[11px] text-[var(--foreground-muted)]">
              {PLANS.PRO.limits.importRowsPerFile?.toLocaleString('es-GT')} filas máx.
            </span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {[
              {
                sku: 'CAP-COR-0913',
                name: 'Capó Corolla',
                vehicle: 'Toyota · Corolla · 2009–2013',
                ok: true,
              },
              { sku: 'FAR-HIL-15', name: 'Faro delantero', vehicle: 'Toyota · Hilux · 2015–2020', ok: true },
              {
                sku: 'BAL-SEN-07',
                name: 'Balatas delanteras',
                vehicle: 'Nissan · Sentra · 2007–2012',
                ok: true,
              },
              { sku: 'AMO-???', name: 'Amortiguador', vehicle: 'marca sin reconocer', ok: false },
            ].map((row) => (
              <div key={row.sku} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: row.ok ? 'var(--color-stock-ok)' : 'var(--color-stock-low)' }}
                />
                <span className="w-[104px] shrink-0 font-mono text-[11px] text-[var(--foreground-muted)]">
                  {row.sku}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--foreground)]">
                  {row.name}
                </span>
                <span className="hidden truncate text-[11.5px] text-[var(--foreground-muted)] sm:block sm:w-[190px]">
                  {row.vehicle}
                </span>
              </div>
            ))}
          </div>
          <p className="border-t border-[var(--border)] px-4 py-2.5 text-[11.5px] text-[var(--foreground-muted)]">
            El archivo de ejemplo es inventado. El reporte por fila, no.
          </p>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="mx-auto max-w-6xl px-5 py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <PartOpsLogo size={16} variant="color" />
          <span className="text-[11.5px] text-[var(--foreground-muted)]">
            Guatemala · Quetzales · IVA incluido
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-[11.5px] text-[var(--foreground-muted)]">
          <Link href="/planes" className="hover:text-[var(--foreground)]">
            Planes
          </Link>
          <Link href="/terminos" className="hover:text-[var(--foreground)]">
            Términos
          </Link>
          <Link href="/privacidad" className="hover:text-[var(--foreground)]">
            Privacidad
          </Link>
          <a href="mailto:partopsgt@gmail.com" className="hover:text-[var(--foreground)]">
            partopsgt@gmail.com
          </a>
        </div>
      </div>
    </footer>
  );
}
