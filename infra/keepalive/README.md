# Keepalive de PartOps

Un Worker de Cloudflare con un solo cron cada 10 minutos. Hace dos cosas:
1. **Latido** a `GET /api/health/live` para que Neon no suspenda el cómputo y el proveedor no duerma
   la API por inactividad.
2. **Mantenimiento diario** a las 06:10 de Guatemala: `POST /api/maintenance/run` con el secreto
   compartido. Dispara el rollup de demanda y los gastos fijos del día anterior.

## Por qué existe

El mantenimiento de la API es un `setInterval` dentro del proceso. Eso funciona mientras el proceso
esté despierto. En un plan donde el servicio se duerme por inactividad, el temporizador se congela con
él y el trabajo del día no corre. El cron externo lo despierta y lo dispara en la misma pasada.

No requiere acceso a la base ni guarda estado: si la API está caída, lo único que hace es anotarlo en
su log.

## Instalación

```bash
cd infra/keepalive
npx wrangler login                                   # una vez por máquina
npx wrangler secret put CRON_SECRET                  # pegar el MISMO valor que en Render
npx wrangler deploy
```

El secreto tiene que ser idéntico al `CRON_SECRET` de Render. Si difieren, la API responde **401** y
el log del Worker lo dice. Si falta en la API, responde **404** —el endpoint no existe para nadie,
que es el estado seguro— y también queda en el log.

## Verificación

```bash
# La sonda manual responde el estado de la API y si el secreto está configurado.
curl -s https://partops-keepalive.<cuenta>.workers.dev | jq

# Disparar el mantenimiento sin esperar a las 06:10 (mismo header que usa el Worker).
curl -s -X POST https://api.partops.gt/api/maintenance/run \
  -H "x-cron-secret: $(op read op://partops/cron/secret)" -i | head -1
# Esperado: HTTP/2 202
```

El resultado real del trabajo queda en `background_job` y se consulta en `/admin` → trabajos.

## Desarrollo local

```bash
cd infra/keepalive
npx wrangler dev            # cron y fetch, con recarga en caliente
npx wrangler tail           # seguir el log del Worker publicado
```

`wrangler dev` no ejecuta el cron hasta que pasa el minuto; para probar el disparo manual se usa la
URL de `wrangler dev` en el navegador.
