import { EmptyState } from '@partops/ui';
import type { Route } from 'next';
import Link from 'next/link';

/**
 * Pieza que ya no está.
 *
 * La causa más común no es un enlace mal escrito sino una pieza que se archivó o se vendió y la
 * bodega quitó de la vitrina. Por eso el camino que se ofrece es el catálogo completo —donde el
 * cliente puede filtrar por su vehículo— y no un "vuelve atrás" que lo dejaría en el mismo punto.
 *
 * No se dice el nombre de la pieza ni del negocio: la página no consultó nada, y adivinarlo con el
 * slug de la URL sería inventar.
 */
export default function PartNotFound() {
  return (
    <main className="mx-auto grid min-h-[60dvh] max-w-xl place-items-center px-4">
      <EmptyState
        title="Esta pieza ya no está publicada"
        description="Puede que se haya vendido o que la bodega la haya quitado del catálogo. Mira el resto de piezas o pregúntanos por WhatsApp."
        action={
          <Link
            href={'/' as Route}
            className="rounded-[var(--radius-sm)] px-3.5 py-2 text-[13px] font-semibold"
            style={{ backgroundColor: 'var(--shop-primary)', color: 'var(--shop-on-primary)' }}
          >
            Volver al catálogo
          </Link>
        }
      />
    </main>
  );
}
