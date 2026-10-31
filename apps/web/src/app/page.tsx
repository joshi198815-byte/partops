import type { VehicleVocabulary } from '@partops/contracts';
import Link from 'next/link';
import { ParseDemo } from './_landing/parse-demo';
import { ImportStory, PlansTeaser, Rules, SiteFooter, SiteHeader, Workflow } from './_landing/sections';

/**
 * Portada de PartOps.
 *
 * Regla de la casa: ninguna cifra, ningún logo de cliente y ningún testimonio inventado. Lo que se
 * afirma es lo que el producto hace hoy, y la prueba está en el hero: el parser real del mostrador
 * corriendo en el navegador contra la tabla vehicular curada de la API.
 *
 * La única decisión de diseño que importa aquí: **un solo CTA**. «Crear cuenta» es lo que se pide;
 * «Entrar» va como enlace de texto porque el que ya es cliente no necesita un botón para volver.
 */
export const revalidate = 3600;

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/**
 * Vocabulario de la tabla curada (`GET /api/public/vocabulary`).
 *
 * Si falla, la portada se pinta igual y el demo avisa de que no tiene la referencia: nunca se
 * finge un acierto con un vocabulario inventado.
 */
async function loadVocabulary(): Promise<VehicleVocabulary | null> {
  try {
    const res = await fetch(`${API_URL}/api/public/vocabulary`, {
      next: { revalidate: 3600 },
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<VehicleVocabulary>;
    if (!Array.isArray(data.brands) || !Array.isArray(data.models)) return null;
    return { brands: data.brands, models: data.models };
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const vocabulary = await loadVocabulary();

  return (
    <main className="min-h-dvh bg-[var(--background)]">
      <SiteHeader />
      <Hero vocabulary={vocabulary} />
      <Workflow />
      <Rules />
      <PlansTeaser />
      <ImportStory />
      <SiteFooter />
    </main>
  );
}

/**
 * El hero.
 *
 * Antes había aquí dos cifras grandes («4,812 piezas», «18,940 aplicaciones») que describían un
 * negocio que no existe. Se fueron. Lo que las reemplaza es el demo: la misma frase que el vendedor
 * escucha en el mostrador, partida en cuatro campos por el código que corre en producción.
 *
 * El titular escribe «corolla» con dos eles, que es como está en la tabla curada. «corola» también
 * funciona —el parser la reconoce como errata y la ofrece—, pero el titular no puede empezar
 * enseñando un error como si fuera lo correcto.
 */
function Hero({ vocabulary }: { vocabulary: VehicleVocabulary | null }) {
  return (
    <section className="relative overflow-hidden border-b border-[var(--border)]">
      {/* Regla de estante a todo lo ancho: el único ornamento, y es el motivo de la marca. */}
      <div aria-hidden className="partops-shelf absolute inset-x-0 top-0 opacity-70" />

      <div className="mx-auto grid max-w-6xl items-start gap-12 px-5 py-14 lg:grid-cols-[1.02fr_0.98fr] lg:py-20">
        <div>
          <p className="inline-flex items-center gap-2 rounded-[var(--radius-xs)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--foreground-muted)]">
            <span aria-hidden className="size-1.5 rounded-full bg-[var(--accent)]" />
            Hecho para bodegas de Guatemala
          </p>

          <h1 className="mt-5 font-[family-name:var(--font-display)] text-[clamp(2.1rem,4.6vw,3.35rem)] font-extrabold leading-[1.03] tracking-[-0.028em] text-[var(--foreground)]">
            Escribe «cubierta corolla 2009».
            <br />
            <span className="text-[var(--color-copper-700)]">Aparece la pieza, el estante y si hay.</span>
          </h1>

          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-[var(--foreground-muted)]">
            PartOps entiende la jerga del mostrador, no solo el número OEM. Sabe en qué bodega está, aparta lo
            que se está vendiendo y le dice al bodeguero qué preparar. Sin hojas de Excel paralelas.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link
              href="/registro"
              className="inline-flex h-12 items-center rounded-[var(--radius-sm)] bg-[var(--primary)] px-6 text-[15px] font-medium text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary-hover)]"
            >
              Empezar con mi bodega
            </Link>
            <Link
              href="/entrar"
              className="text-[13.5px] font-medium text-[var(--foreground-muted)] underline-offset-4 hover:text-[var(--foreground)] hover:underline"
            >
              Ya tengo cuenta
            </Link>
          </div>

          <p className="mt-4 text-[12px] text-[var(--foreground-muted)]">
            Se configura en una tarde. Se importa el Excel actual: no hay que capturar el catálogo otra vez.
          </p>
        </div>

        <div>
          <ParseDemo vocabulary={vocabulary} />
          <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--foreground-muted)]">
            Escrito a mano, sin catálogo de por medio. Esto es el parser que corre en la búsqueda real; el
            inventario aparece cuando entras con tu cuenta.
          </p>
        </div>
      </div>
    </section>
  );
}
