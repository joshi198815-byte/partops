import Link from 'next/link';
import { SiteFooter, SiteHeader } from '../_landing/sections';

/**
 * Términos.
 *
 * Prosa corta y comprobable. Nada de párrafos copiados de una plantilla en inglés: quien lee esto
 * es el dueño de una bodega que quiere saber qué contrata, cuánto cuesta y qué pasa si deja de pagar.
 *
 * La fecha se escribe a mano y se actualiza cuando cambia el texto. Un «última actualización»
 * generado automáticamente con la fecha del build diría que los términos cambiaron a diario, que es
 * justo lo contrario de lo que este documento promete.
 */
export const metadata = {
  title: 'Términos',
  description: 'Condiciones de uso de PartOps para bodegas de repuestos en Guatemala.',
};

const UPDATED = '31 de octubre de 2026';

export default function TerminosPage() {
  return (
    <main className="min-h-dvh bg-[var(--background)]">
      <SiteHeader />

      <article className="mx-auto max-w-2xl px-5 py-14">
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--color-copper-700)]">
          Términos de uso
        </p>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(1.8rem,3.2vw,2.4rem)] font-extrabold leading-[1.08] tracking-[-0.026em] text-[var(--foreground)]">
          Lo que contratas cuando usas PartOps
        </h1>
        <p className="mt-2 text-[12px] text-[var(--foreground-muted)]">Última actualización: {UPDATED}</p>

        <Section title="Quién opera el servicio">
          <p>
            PartOps es un sistema de inventario, venta y despacho para bodegas de repuestos automotrices. Lo
            opera PartOps en Guatemala. Para cualquier asunto de estas condiciones se escribe a{' '}
            <a href="mailto:partopsgt@gmail.com" className="text-[var(--color-copper-700)] hover:underline">
              partopsgt@gmail.com
            </a>
            .
          </p>
        </Section>

        <Section title="Qué incluye cada plan">
          <p>
            Los planes y sus límites están publicados en{' '}
            <Link href="/planes" className="text-[var(--color-copper-700)] hover:underline">
              /planes
            </Link>{' '}
            y son los mismos que el sistema aplica: piezas, usuarios, filas por archivo de Excel y si el
            catálogo se publica. Si un límite cambiara, se avisa antes y no se aplica hacia atrás sobre lo que
            ya cargaste.
          </p>
        </Section>

        <Section title="Precio y pago">
          <p>
            Los precios están en quetzales con IVA incluido y se cobran por mes. Hoy el pago es por
            transferencia o tarjeta con factura; el plan se activa el mismo día que entra el pago. No hay
            cobro automático: si no se renueva, el negocio no se apaga, baja al plan Bodega y conserva todo lo
            que ya tenía cargado.
          </p>
        </Section>

        <Section title="Tu información es tuya">
          <p>
            El catálogo, las existencias, las ventas y los clientes que registres son de tu negocio. No los
            vendemos, no los usamos para publicidad y no los compartimos con otros negocios. El aislamiento
            entre negocios lo impone la base de datos, no una condición del código.
          </p>
          <p>
            Para exportar tus datos usa «Exportar» dentro del producto. Para irte, escribe a
            partopsgt@gmail.com: se entrega una copia y se borra la cuenta.
          </p>
        </Section>

        <Section title="Uso correcto">
          <p>
            No se permite usar el servicio para vender piezas robadas o falsificadas, para suplantar a otro
            negocio, ni para intentar acceder a datos de otra bodega. Tampoco automatizar el catálogo público
            con rastreadores que degraden el servicio para los demás.
          </p>
        </Section>

        <Section title="Disponibilidad">
          <p>
            El servicio corre sobre infraestructura de terceros y puede tener interrupciones. Se mantiene un
            registro de incidentes y un procedimiento de recuperación documentado. No se promete un porcentaje
            de disponibilidad que no se pueda medir hoy.
          </p>
          <p>
            Los movimientos de inventario y los recibos son inmutables: si algo se registró mal, se corrige
            con un movimiento o una nota, no editando el historial. Eso también aplica a nosotros.
          </p>
        </Section>

        <Section title="Cambios en estas condiciones">
          <p>
            Si el texto cambia, cambia la fecha de arriba y se avisa por correo a la dirección de la cuenta.
            Lo que no va a pasar es un cambio retroactivo que convierta en incumplimiento algo que ya hiciste
            bajo las condiciones anteriores.
          </p>
        </Section>
      </article>

      <SiteFooter />
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.05em] text-[var(--foreground)]">{title}</h2>
      <div className="mt-2 space-y-2 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
        {children}
      </div>
    </section>
  );
}
