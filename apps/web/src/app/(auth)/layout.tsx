import { PartOpsLogo } from '@partops/ui';
import Link from 'next/link';

/**
 * Marco de las pantallas de cuenta.
 *
 * Panel izquierdo oscuro con la trama de muesca: la marca ocupa el espacio que el dueño de la
 * bodega ve mientras escribe la contraseña. En móvil desaparece y queda solo el formulario, que es
 * lo que importa cuando se entra desde el teléfono en el mostrador.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-[var(--background)] lg:grid-cols-[1fr_1.15fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-[var(--color-steel-900)] p-10 lg:flex">
        <div aria-hidden className="partops-hatch absolute inset-0 opacity-[0.18]" />
        <div className="relative">
          <Link href="/" className="inline-flex">
            <PartOpsLogo size={24} variant="inverse" />
          </Link>
        </div>

        <div className="relative max-w-sm">
          <p className="font-[family-name:var(--font-display)] text-[26px] font-bold leading-[1.15] tracking-[-0.02em] text-[var(--color-steel-50)]">
            Escribe «cubierta corolla 2009». Aparece la pieza, el estante y si hay.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-[var(--color-steel-300)]">
            El mismo parser que ves en la portada. Existencias por bodega, reservas que vencen en 20 minutos y
            recibos con NIT. Hecho para bodegas de repuestos en Guatemala.
          </p>
          <div className="mt-6 flex flex-wrap gap-1.5 text-[11px] text-[var(--color-steel-300)]">
            <span className="rounded-[var(--radius-xs)] border border-white/15 px-2 py-1">Quetzales</span>
            <span className="rounded-[var(--radius-xs)] border border-white/15 px-2 py-1">IVA incluido</span>
            <span className="rounded-[var(--radius-xs)] border border-white/15 px-2 py-1">NIT</span>
            <span className="rounded-[var(--radius-xs)] border border-white/15 px-2 py-1">WhatsApp</span>
          </div>
        </div>

        <p className="relative text-[11px] text-[var(--color-steel-400)]">partopsgt@gmail.com · Guatemala</p>
      </aside>

      <main className="flex flex-col px-5 py-8 sm:px-8">
        <div className="mb-8 lg:hidden">
          <Link href="/" className="inline-flex">
            <PartOpsLogo size={20} />
          </Link>
        </div>
        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center pb-10">
          {children}
        </div>
      </main>
    </div>
  );
}
