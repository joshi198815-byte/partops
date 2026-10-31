import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
import { withRegionalCache } from '@opennextjs/cloudflare/overrides/incremental-cache/regional-cache';
import doQueue from '@opennextjs/cloudflare/overrides/queue/do-queue';

/**
 * Configuración del adaptador OpenNext para Cloudflare Workers.
 *
 * La app no es estática: `/`, `/c/[slug]` y `/c/[slug]/[partSlug]` declaran `revalidate`, y sin
 * caché incremental esos `revalidate` no tienen dónde escribir y la página se re-renderiza en cada
 * visita (o falla al intentar revalidar en segundo plano). Por eso R2 y no `staticAssets`:
 * `staticAssets` es de solo lectura y no soporta revalidación.
 *
 * La cola en Durable Object deduplica las revalidaciones por tiempo. Sin ella, diez visitantes
 * simultáneos sobre una página vencida disparan diez renderizados contra la API en el mismo
 * segundo, que es exactamente el pico que la API free (0.1 CPU) no aguanta.
 *
 * La caché regional `long-lived` evita ir a R2 en cada visita: las respuestas se reutilizan hasta
 * que se revalidan, y las de ISR hasta 30 minutos.
 *
 * No hay tag cache (D1) porque la app no llama `revalidateTag` ni `revalidatePath`: solo
 * revalidación por tiempo.
 */
export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: 'long-lived' }),
  queue: doQueue,
  // Sirve los aciertos de caché sin arrancar el servidor de Next: menos CPU en el arranque en frío.
  enableCacheInterception: true,
});
