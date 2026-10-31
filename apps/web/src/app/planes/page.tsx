import { formatMoney, MULTI_LOCATION_PRICE_CENTS, PLANS, type PlanTier } from '@partops/contracts';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '../_landing/sections';

/**
 * Planes.
 *
 * Los tres precios y los tres topes salen de `PLANS` (`packages/contracts/src/plans.ts`), que es la
 * misma tabla que la API usa para cortar. No hay un número escrito a mano en esta página: si mañana
 * cambia el tope de PRO, cambia aquí y en el candado a la vez.
 *
 * No hay pasarela de pago. Por eso el botón de PRO y TALLER no dice «Pagar» sino que abre un correo:
 * cobrar en línea y activar el mismo día es un proceso manual, y decir lo contrario sería la primera
 * mentira de la relación.
 */
export const metadata = {
  title: 'Planes',
  description:
    'Tres planes para bodegas de repuestos en Guatemala: Bodega, Mostrador y Cadena. Precios en quetzales, IVA incluido.',
};

const ORDER: PlanTier[] = ['FREE', 'PRO', 'TALLER'];

const COMPARISON: { label: string; value: (tier: PlanTier) => string }[] = [
  { label: 'Piezas en el catálogo', value: (t) => limit(PLANS[t].limits.parts, 'piezas') },
  { label: 'Usuarios', value: (t) => limit(PLANS[t].limits.members, 'usuarios') },
  { label: 'Filas por archivo de Excel', value: (t) => limit(PLANS[t].limits.importRowsPerFile, 'filas') },
  { label: 'Catálogo público en tu dirección', value: (t) => (PLANS[t].limits.publicCatalog ? 'Sí' : 'No') },
  { label: 'Exportar ventas y gastos', value: (t) => (PLANS[t].limits.exportData ? 'Sí' : 'No') },
  { label: 'Ventas, inventario y recibos con NIT', value: () => 'Sí' },
  { label: 'Despacho con escáner', value: () => 'Sí' },
  {
    label: 'Demanda no atendida',
    value: (t) => (t === 'FREE' ? 'Resumen del mes' : 'Por pieza y por vehículo'),
  },
  {
    label: 'Roles con permisos a la medida',
    value: (t) => (t === 'TALLER' ? 'Sí, roles propios' : 'Cinco roles fijos'),
  },
  { label: 'Soporte', value: (t) => (t === 'TALLER' ? 'WhatsApp el mismo día' : 'Correo') },
];

function limit(value: number | null, unit: string): string {
  if (value === null) return 'Sin tope';
  return `${value.toLocaleString('es-GT')} ${unit}`;
}

export default function PlanesPage() {
  return (
    <main className="min-h-dvh bg-[var(--background)]">
      <SiteHeader />

      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--color-copper-700)]">
            Planes
          </p>
          <h1 className="mt-3 max-w-3xl font-[family-name:var(--font-display)] text-[clamp(1.9rem,3.6vw,2.7rem)] font-extrabold leading-[1.06] tracking-[-0.026em] text-[var(--foreground)]">
            Lo que cambia entre planes es cuánto cabe, no qué puedes hacer.
          </h1>
          <p className="mt-4 max-w-2xl text-[14.5px] leading-relaxed text-[var(--foreground-muted)]">
            Buscar por vehículo, mover existencia, cobrar, despachar y emitir recibo va en los tres. Arriba de
            Bodega se agrega espacio, catálogo público y exportación. Precios en quetzales, IVA incluido.
          </p>
        </div>
      </section>

      <section className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto grid max-w-6xl gap-4 px-5 py-12 md:grid-cols-3">
          {ORDER.map((tier) => {
            const plan = PLANS[tier];
            return (
              <article
                key={tier}
                className="partops-ticket flex flex-col rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--background)] p-5"
              >
                <h2 className="text-[12px] font-bold uppercase tracking-[0.07em] text-[var(--foreground)]">
                  {plan.name}
                </h2>
                <p className="partops-num mt-2 font-[family-name:var(--font-display)] text-[34px] font-extrabold leading-none tracking-[-0.03em] text-[var(--foreground)]">
                  {plan.priceCentsPerMonth === 0 ? 'Q 0' : formatMoney(plan.priceCentsPerMonth, 'GTQ')}
                </p>
                <p className="mt-1 text-[11.5px] text-[var(--foreground-muted)]">
                  {plan.priceCentsPerMonth === 0 ? 'para siempre' : 'al mes · IVA incluido'}
                </p>
                <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">
                  {plan.tagline}
                </p>

                <ul className="mt-4 flex-1 space-y-1.5 border-t border-[var(--border)] pt-3">
                  {plan.includes.map((item) => (
                    <li key={item} className="flex gap-2 text-[12.5px] leading-snug text-[var(--foreground)]">
                      <span
                        aria-hidden
                        className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--accent)]"
                      />
                      {item}
                    </li>
                  ))}
                </ul>

                <Link
                  href={
                    tier === 'FREE' ? '/registro' : 'mailto:partopsgt@gmail.com?subject=Quiero%20el%20plan'
                  }
                  className={
                    tier === 'FREE'
                      ? 'mt-5 inline-flex h-11 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--primary)] px-4 text-[14px] font-medium text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]'
                      : 'mt-5 inline-flex h-11 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-[14px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-sunken)]'
                  }
                >
                  {tier === 'FREE' ? 'Crear cuenta gratis' : 'Escribir para activarlo'}
                </Link>
              </article>
            );
          })}
        </div>
      </section>

      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.3rem,2.4vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
            Comparación completa
          </h2>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--border-strong)] text-left">
                  <th scope="col" className="py-2 pr-4 font-medium text-[var(--foreground-muted)]">
                    {' '}
                  </th>
                  {ORDER.map((tier) => (
                    <th
                      key={tier}
                      scope="col"
                      className="py-2 pr-4 text-[12px] font-semibold text-[var(--foreground)]"
                    >
                      {PLANS[tier].name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.label} className="border-b border-[var(--border)]">
                    <th
                      scope="row"
                      className="py-2 pr-4 text-left font-normal text-[var(--foreground-muted)]"
                    >
                      {row.label}
                    </th>
                    {ORDER.map((tier) => (
                      <td key={tier} className="partops-num py-2 pr-4 text-[var(--foreground)]">
                        {row.value(tier)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto max-w-3xl px-5 py-12">
          <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.2rem,2.2vw,1.5rem)] font-bold text-[var(--foreground)]">
            Cómo se paga
          </h2>
          <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
            Todavía no hay cobro automático en línea, y no vamos a poner un botón de «pagar» que no cobre. Se
            paga por transferencia o tarjeta, con factura, y el plan se activa el mismo día que entra el pago.
            Al vencer, el negocio no se apaga: baja a Bodega, conserva todo lo que cargó y sigue vendiendo.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
            ¿Varios locales con inventario separado? Hoy el sistema atiende una bodega con varias ubicaciones
            internas. La cuenta para cadenas con catálogos independientes está en diseño; si la necesitas,
            escríbenos y la conversamos antes de prometerte algo que no existe.
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">
            Cuando esa cuenta exista, su precio será de {formatMoney(MULTI_LOCATION_PRICE_CENTS, 'GTQ')} al
            mes. Hoy no se ofrece: el producto todavía no separa catálogos por sucursal, y cobrarlo antes de
            entregarlo sería vender lo que no hay.
          </p>
          <p className="mt-5 text-[13px]">
            <a
              href="mailto:partopsgt@gmail.com"
              className="font-medium text-[var(--color-copper-700)] hover:underline"
            >
              partopsgt@gmail.com
            </a>
          </p>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
