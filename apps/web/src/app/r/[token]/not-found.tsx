import { PartOpsLogo } from '@partops/ui';
import Link from 'next/link';

export const metadata = { title: 'Recibo no encontrado' };

/**
 * 404 del recibo.
 *
 * Se pinta aquí y no con `notFound()` genérico porque quien llega es un cliente, no un empleado:
 * necesita saber que el enlace puede estar incompleto y que quien le vendió puede reenviarlo, no
 * un mensaje técnico de "not found".
 */
export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--background)] px-5 py-10">
      <div className="w-full max-w-[420px]">
        <Link href="/" className="mb-8 inline-flex">
          <PartOpsLogo size={20} />
        </Link>
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-bold tracking-[-0.015em] text-[var(--foreground)]">
          No encontramos ese recibo
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
          Puede que el enlace esté incompleto (a veces WhatsApp corta el final) o que el recibo se haya
          anulado. Pide a la bodega que te lo reenvíe.
        </p>
      </div>
    </main>
  );
}
