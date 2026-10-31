import { EmptyState, PartOpsMark } from '@partops/ui';
import Link from 'next/link';

/**
 * Catálogo inexistente.
 *
 * La misma pantalla para un slug que no existe, uno apagado y uno suspendido. Es deliberado: si el
 * mensaje distinguiera los casos, cualquiera podría recorrer slugs y sacar la lista de bodegas del
 * país —y cuáles están al día con el pago.
 *
 * La marca de PartOps va aquí porque en este punto no hay negocio que mostrar: lo único honesto es
 * decir quién sirve el catálogo y ofrecer el camino de vuelta.
 */
export default function CatalogNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--background)] px-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <div className="flex justify-center">
          <PartOpsMark size={40} />
        </div>
        <EmptyState
          title="Este catálogo no está disponible"
          description="El enlace puede estar mal escrito, o la bodega todavía no publicó su catálogo en línea. Si te lo compartieron por WhatsApp, pide que te lo vuelvan a enviar."
          action={
            <Link
              href="/"
              className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2 text-[13px] font-medium hover:bg-[var(--surface-sunken)]"
            >
              Ir a PartOps
            </Link>
          }
        />
      </div>
    </main>
  );
}
