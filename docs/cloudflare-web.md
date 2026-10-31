# Preparar el Worker de la web en Cloudflare

Se corre **una vez**, a mano, antes del primer despliegue de `partops-web` en Workers. `deploy.yml`
no lo hace porque crear infraestructura compartida no es trabajo de un despliegue continuo: si se
dispara dos veces, un error de red se convierte en un bucket duplicado.

## Qué crea

| Recurso        | Nombre              | Para qué                                                                                        |
| -------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| R2 bucket      | `partops-web-cache` | Caché incremental de ISR (`revalidate` en `/`, `/c/[slug]`, …)                                  |
| Durable Object | `DOQueueHandler`    | Cola que deduplica revalidaciones. La crea `wrangler` con las `migrations` de `wrangler.jsonc`. |

El bucket de fotos (`partops`) **no** se toca: son datos del negocio, no caché. Mezclarlos haría que
un `deploy` pudiera borrar fotos al limpiar caché.

## Pasos

```powershell
cd apps/web

# 1 · Cuenta explícita. Sin esto, `wrangler` resuelve otra cuenta del token y las llamadas fallan
#     con `Authentication error [code: 10000]` sobre un id que no es el tuyo.
$env:CLOUDFLARE_ACCOUNT_ID = "<account id>"

# 2 · Bucket de caché. Si ya existe, responde `already exists` y no pasa nada.
npx wrangler r2 bucket create partops-web-cache

# 3 · El dominio tiene que estar en la zona `partops.autos` para que el `custom_domain` del
#     `wrangler.jsonc` se cree solo. Ya lo está (nameservers jacob/kimora de Cloudflare).
npx wrangler deploy --dry-run
```

## El dominio

`wrangler.jsonc` declara `app.partops.autos` como `custom_domain`. Al desplegar, Cloudflare crea el
registro DNS y emite el certificado.

**Antes de eso hay que quitar el registro que apunta a Render**, o el despliegue falla porque el
nombre ya está en uso. Quitar `partops-web` de `render.yaml` **no lo borra**: Render nunca elimina un
recurso por quitarlo del Blueprint, lo deja huérfano y vivo, todavía reclamando el dominio. Hay que
borrarlo a mano.

El orden seguro es:
1. Desplegar el Worker con `wrangler deploy` (sin dominio: comentar `routes` temporalmente) y probar
   por la URL `*.workers.dev` que la app arranca y el login funciona.
2. En Render: borrar el servicio `partops-web` desde el panel. En Cloudflare: borrar el registro `app`
   (CNAME a `onrender.com`) de la zona `partops.autos`.
3. Reactivar `routes` en `wrangler.jsonc` y desplegar otra vez.

Así el corte dura segundos y hay un punto de retorno claro: hasta el paso 3, `app.partops.autos`
sigue sirviendo la versión de Render.

## Secretos

```powershell
npx wrangler secret put NEXT_PUBLIC_SENTRY_DSN
```

`API_URL`, `NEXT_PUBLIC_API_URL` y `NEXT_PUBLIC_APP_URL` van en `vars` del `wrangler.jsonc`: no son
secretos y verlos en el repo ayuda a detectar un despliegue apuntando a la API equivocada.

## Cuota

Workers Free da 100 000 peticiones al día y 10 ms de CPU por petición. Un SSR de Next en frío puede
pasarse de 10 ms; el plan free tolera picos ocasionales pero **no** tráfico sostenido por encima del
límite. Si el log muestra `Exceeded CPU Limit`, el plan Workers Paid ($5/mes) sube el techo a 5
minutos de CPU y 10 000 000 de peticiones al mes.
