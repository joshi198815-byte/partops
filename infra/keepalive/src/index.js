/**
 * Keepalive y mantenimiento.
 *
 * Dos trabajos en un Worker, porque comparten el mismo cron y el mismo secreto:
 *
 *  **Latido cada 10 minutos.** Neon suspende el cómputo tras cinco minutos sin consultas. El primer
 *  request después de la suspensión tarda segundos y, de paso, el proveedor puede dormir el servicio
 *  web por inactividad. Un `GET /health/live` cada 10 minutos mantiene las dos cosas despiertas por
 *  centavos. Se pega a `/live` y no a `/ready` a propósito: `/live` no toca la base, así que el
 *  latido cuesta cero y no compite con las conexiones del mostrador.
 *
 *  **Mantenimiento diario a las 06:10 de Guatemala.** El rollup de demanda y los gastos fijos del día
 *  anterior. Corre a las 06:10 y no a medianoche porque a medianoche alguien está cerrando la caja y
 *  una transacción larga ahí sí molesta; a las seis de la mañana la bodega todavía no abrió.
 *
 * Por qué hace falta: el `setInterval` de la API vive dentro del proceso. Si el proveedor la duerme
 * por inactividad, el temporizador se congela con ella y el reporte del día no corre nunca. Un cron
 * exterior despierta el servicio y dispara el trabajo en la misma pasada.
 *
 * Este Worker no tiene lógica de negocio ni acceso a la base. Si el trabajo falla, el error queda en
 * `background_job` y se ve en `/admin`; aquí solo se registra el estado HTTP.
 */

const TIMEOUT_MS = 10_000;
const GUATEMALA_OFFSET_HOURS = -6;

/** Reloj de Guatemala: UTC-6 todo el año (Guatemala no aplica horario de verano). */
function guatemalaNow(date) {
  return new Date(date.getTime() + GUATEMALA_OFFSET_HOURS * 60 * 60 * 1000);
}

/**
 * Una petición con timeout y un reintento.
 *
 * Un solo reintento y no tres: el objetivo es absorber un 502 momentáneo de la plataforma, no
 * tapar una caída. Reintentar más solo gasta subrequests y retrasa el aviso.
 */
async function request(url, init = {}) {
  const attempt = async () => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res;
  };

  try {
    return await attempt();
  } catch (first) {
    try {
      return await attempt();
    } catch (second) {
      throw new Error(`${url} falló dos veces: ${first?.message} / ${second?.message}`);
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    const apiUrl = (env.API_URL || 'https://api.partops.autos').replace(/\/+$/, '');

    ctx.waitUntil(
      (async () => {
        // 1 · Latido. Cualquier respuesta HTTP cuenta como "vivo": un 503 de /ready significa que la
        // base está mal, pero el proceso está despierto y no hace falta reintentar.
        try {
          const res = await request(`${apiUrl}/api/health/live`);
          console.log(`latido: ${res.status}`);
        } catch (err) {
          console.error(`latido falló: ${err.message}`);
        }

        // 2 · Mantenimiento, solo en la pasada de las 06:10 de Guatemala.
        //
        // El cron de Cloudflare dispara cada 10 minutos, así que la pasada exacta cae en el minuto
        // en que `scheduledTime` termina en :10. Se compara contra hora y minuto y no contra "después
        // de las 06:10": un "después de" dispararía el trabajo en cada pasada del resto del día.
        const gt = guatemalaNow(new Date(event.scheduledTime));
        const hour = Number(env.MAINTENANCE_HOUR_GT ?? 6);
        const minute = Number(env.MAINTENANCE_MINUTE_GT ?? 10);

        if (gt.getUTCHours() !== hour || gt.getUTCMinutes() !== minute) return;

        if (!env.CRON_SECRET) {
          // Sin secreto el endpoint responde 404 por diseño. Se avisa aquí y no se insiste.
          console.warn('mantenimiento: falta CRON_SECRET en el Worker; no se dispara');
          return;
        }

        try {
          const res = await request(`${apiUrl}/api/maintenance/run`, {
            method: 'POST',
            headers: { 'x-cron-secret': env.CRON_SECRET },
          });
          // 202 es lo esperado. 401 es secreto desincronizado; 404, que la API no tiene la ruta o no
          // tiene `CRON_SECRET`. Los dos se ven en el log del Worker y se distinguen por el código.
          console.log(`mantenimiento: ${res.status}`);
        } catch (err) {
          console.error(`mantenimiento falló: ${err.message}`);
        }
      })(),
    );
  },

  /**
   * Sonda manual: abrir la URL del Worker en un navegador responde el estado en vez de un error.
   * Sirve para confirmar la configuración sin esperar diez minutos al cron.
   */
  async fetch(request, env) {
    const apiUrl = (env.API_URL || 'https://api.partops.autos').replace(/\/+$/, '');
    let status = 'sin respuesta';
    try {
      const res = await request(`${apiUrl}/api/health/ready`);
      status = `${res.status}`;
    } catch (err) {
      status = `error: ${err.message}`;
    }
    return new Response(
      JSON.stringify({
        worker: 'partops-keepalive',
        api: apiUrl,
        ready: status,
        cronSecretConfigured: Boolean(env.CRON_SECRET),
      }),
      { headers: { 'content-type': 'application/json' }, status: 200 },
    );
  },
};
