import Link from 'next/link';
import { SiteFooter, SiteHeader } from '../_landing/sections';

/**
 * Privacidad.
 *
 * Dice dónde vive cada dato con nombre y apellido, porque «podemos compartir tu información con
 * socios comerciales» es exactamente el párrafo que nadie debería tener que leer dos veces. Si no
 * hay publicidad ni venta de datos, se dice así de corto.
 */
export const metadata = {
  title: 'Privacidad',
  description: 'Qué datos guarda PartOps, dónde y por cuánto tiempo.',
};

const UPDATED = '31 de octubre de 2026';

export default function PrivacidadPage() {
  return (
    <main className="min-h-dvh bg-[var(--background)]">
      <SiteHeader />

      <article className="mx-auto max-w-2xl px-5 py-14">
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--color-copper-700)]">
          Privacidad
        </p>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-[clamp(1.8rem,3.2vw,2.4rem)] font-extrabold leading-[1.08] tracking-[-0.026em] text-[var(--foreground)]">
          Qué se guarda, dónde, y qué no se hace con eso
        </h1>
        <p className="mt-2 text-[12px] text-[var(--foreground-muted)]">Última actualización: {UPDATED}</p>

        <Section title="Qué datos se guardan">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong className="font-medium text-[var(--foreground)]">De tu cuenta:</strong> nombre, correo y
              la contraseña cifrada. Nada de teléfono si no lo escribes.
            </li>
            <li>
              <strong className="font-medium text-[var(--foreground)]">De tu negocio:</strong> nombre, NIT,
              dirección, teléfono y WhatsApp, para que salgan en el recibo.
            </li>
            <li>
              <strong className="font-medium text-[var(--foreground)]">Del catálogo e inventario:</strong>{' '}
              piezas, números OEM, compatibilidades, existencias y movimientos.
            </li>
            <li>
              <strong className="font-medium text-[var(--foreground)]">De las ventas:</strong> pedidos,
              líneas, precios, pagos y los datos del cliente que tú registres para el recibo.
            </li>
            <li>
              <strong className="font-medium text-[var(--foreground)]">Búsquedas:</strong> el texto que se
              teclea buscando una pieza, para mostrar qué se pidió y no había.
            </li>
          </ul>
        </Section>

        <Section title="Dónde vive">
          <p>
            La base de datos está en Neon (PostgreSQL, región este de Estados Unidos). Las imágenes de piezas
            están en Cloudflare R2 y se sirven por un dominio de PartOps. La aplicación corre en Render. Los
            correos transaccionales salen por el proveedor que esté configurado en ese momento.
          </p>
          <p>
            Ninguno de esos proveedores recibe datos para publicidad. Se usan para operar el servicio, no para
            perfilarte.
          </p>
        </Section>

        <Section title="Qué no se hace">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>No se venden datos a nadie.</li>
            <li>No hay publicidad ni rastreadores de terceros dentro del producto.</li>
            <li>
              Un negocio no puede ver los datos de otro. El aislamiento lo aplica la base de datos en cada
              consulta, incluida la vitrina pública.
            </li>
            <li>
              El catálogo público nunca muestra costo, márgenes ni existencia exacta: solo si hay, quedan
              pocas o no hay.
            </li>
          </ul>
        </Section>

        <Section title="Cuánto tiempo">
          <p>
            El historial de inventario y los recibos se conservan mientras exista el negocio: son el respaldo
            de una venta y no se pueden reescribir. El texto de cada búsqueda se borra a los 30 días; lo que
            queda es el conteo agregado por día, sin el texto original.
          </p>
          <p>
            Al borrar la cuenta se elimina el negocio con su catálogo, su equipo y sus sesiones. Si necesitas
            una copia antes, expórtala desde el producto.
          </p>
        </Section>

        <Section title="Tus derechos">
          <p>
            Puedes pedir acceso, corrección o borrado de tus datos escribiendo a{' '}
            <a href="mailto:partopsgt@gmail.com" className="text-[var(--color-copper-700)] hover:underline">
              partopsgt@gmail.com
            </a>
            . Se responde en días hábiles.
          </p>
          <p>
            Para dejar de usar el servicio, deja de entrar. Para borrar la cuenta, pídelo por correo desde la
            dirección de la cuenta: se confirma antes de borrar para que nadie elimine un negocio ajeno.
          </p>
        </Section>

        <p className="mt-10 text-[12px] text-[var(--foreground-muted)]">
          Ver también{' '}
          <Link href="/terminos" className="text-[var(--color-copper-700)] hover:underline">
            los términos de uso
          </Link>
          .
        </p>
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
