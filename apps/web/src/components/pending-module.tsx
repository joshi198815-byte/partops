import { EmptyState } from '@partops/ui';

/**
 * Módulo aún no disponible.
 *
 * Se declara explícitamente en vez de pintar una tabla vacía con ceros: en una herramienta de
 * inventario, una pantalla en blanco se lee como "no tengo piezas". Aquí dice qué falta y cuándo
 * llega, y no se inventa ninguna cifra.
 */
export function PendingModule({ title, what, detail }: { title: string; what: string; detail: string }) {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(1.35rem,2.6vw,1.7rem)] font-bold tracking-[-0.02em] text-[var(--foreground)]">
          {title}
        </h1>
      </header>
      <EmptyState
        title={`${what} todavía no está disponible`}
        description={detail}
        icon={
          <svg
            viewBox="0 0 24 24"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden
          >
            <path
              d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"
              strokeLinecap="round"
            />
            <circle cx="12" cy="12" r="4" />
          </svg>
        }
      />
    </div>
  );
}
