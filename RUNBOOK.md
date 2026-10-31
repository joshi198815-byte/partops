# Runbook

Lo que se rompe en producción, con cómo se detecta, qué se hace y cómo se confirma que quedó.
En ese orden: el error común es arreglar sin haber confirmado el síntoma y sin haber comprobado que
de verdad se resolvió. La introducción dice «cinco» porque eran cinco; hoy son ocho, y las tres
últimas —correo, despliegue automático y cambio de CDN— son las que más se van a usar el primer mes.

Antes de tocar nada: **anotar la hora y qué se vio**. Un incidente sin línea de tiempo se repite.

```bash
# Estado rápido, en un comando.
pnpm smoke        # dominio, salud, RLS, CSP, sesión privada
curl -s https://api.partops.autos/api/health/ready | jq
```

---

## 1 · Neon suspendió la base

**Cómo se detecta.** `/api/health/ready` devuelve 503 con `database: false`, o tarda más de 10 s. El
log de la API dice `connection timeout` o `Timed out fetching a new connection from the pool`. Las
pantallas muestran el error genérico de red.

**Por qué pasa.** Neon free suspende el cómputo tras unos minutos sin consultas. Si el Worker de
keepalive dejó de latir (secreto mal, cron apagado, `wrangler deploy` olvidado), la base se duerme y
el primer request paga el arranque en frío o falla.

**Qué se hace.**

```bash
# 1. ¿El Worker está latiendo?
npx wrangler tail --config infra/keepalive/wrangler.toml
# Salida esperada cada 10 min: "latido: 200"

# 2. Despertar la base a mano (un solo request, tarda lo que tarde).
curl -s --max-time 60 https://api.partops.autos/api/health/ready | jq

# 3. Si sigue dormida, el panel de Neon dice el estado real; despertarla desde ahí.
```

Si el Worker es el problema: `npx wrangler deploy --config infra/keepalive/wrangler.toml` y revisar
que el secreto esté puesto (`wrangler secret list`).

**Cómo se confirma.** `/health/ready` en 200 con `rlsEnforced: true` y latencia < 200 ms, dos veces
seguidas con un minuto de diferencia (una sola vez puede ser el arranque en frío).

---

## 2 · Render durmió o cayó la API

**Cómo se detecta.** El dominio responde 502/503, o el certificado falla. `pnpm smoke` falla en el
primer bloque. Cloudflare muestra error 521/522.

**Qué se hace.**

```bash
# 1. ¿Es la API, es la web, o las dos? Son dos servicios distintos en Render.
curl -s -o /dev/null -w "%{http_code}\n" https://api.partops.autos/api/health/live
curl -s -o /dev/null -w "%{http_code}\n" https://app.partops.autos/entrar
#    Si la web responde y la API no, la web sigue sirviendo login y assets: no la reinicies.
curl -sI https://app.partops.autos/entrar | findstr /i "x-partops-commit"

# 2. Logs del servicio en Render → partops-api. Buscar "Configuración inválida" primero:
#    un secreto faltante tumba el arranque y el log lo dice con el nombre del campo.

# 3. Redeploy manual desde el panel, o disparar el hook.
curl -X POST "$RENDER_API_DEPLOY_HOOK"
```

**Si lo que falló fue la web** (`partops-web`, Dockerfile en `apps/web/`), el síntoma típico es
`/entrar` en 502 mientras la API está sana. Revisar el log del **build**, no el del runtime: casi
siempre es un `API_URL` mal puesto o un `pnpm install` que no encontró el lockfile. El servicio
tiene su propio hook (`RENDER_WEB_DEPLOY_HOOK`).

**Si el arranque falla por configuración** —el caso más común después de rotar un secreto—: la API
valida `env` al arrancar y se niega a correr sin `BETTER_AUTH_SECRET` o `DATABASE_URL`. Es a
propósito. Corregir la variable en Render y redeploy; no "arreglar" relajando la validación.

**Cómo se confirma.** `/health/live` en 200, `/health/ready` en 200 con el `commit` del último
despliegue, la cabecera `x-partops-commit` de la web con el mismo SHA, y `pnpm smoke` verde completo.

---

## 3 · R2 sin dominio (las imágenes no cargan)

**Cómo se detecta.** Las fotos de piezas muestran el `alt` o el ícono de imagen rota; los logos de la
vitrina tampoco. La API responde bien, el catálogo también: solo faltan los binarios.

**Por qué pasa.** `R2_PUBLIC_URL` apunta a un dominio personalizado cuyo DNS no está o cuyo
certificado no se emitió. O el bucket perdió el acceso público de lectura.

**Qué se hace.**

```bash
# 1. ¿El objeto existe? (desde una máquina con las credenciales)
pnpm --filter @partops/api exec node -e "
  import('@aws-sdk/client-s3').then(async ({S3Client, HeadObjectCommand}) => {
    const s3 = new S3Client({region:'auto',
      endpoint:'https://'+process.env.R2_ACCOUNT_ID+'.r2.cloudflarestorage.com',
      credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID, secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
    await s3.send(new HeadObjectCommand({Bucket:process.env.R2_BUCKET, Key:'parts/<id>.webp'}));
    console.log('objeto ok');
  })"

# 2. ¿El dominio responde?
curl -sI https://cdn.partops.autos/parts/<id>.webp | head -3
```

Si el objeto existe y el dominio no responde: revisar el DNS del dominio en Cloudflare (registro CNAME
al bucket) y el estado del certificado en R2 → Settings → Custom Domains.

**Conectarlo (una vez).** El script es idempotente y no fuerza un estado a medias:

```bash
export CF_API_TOKEN=…   # Zone:Read + R2:Edit; nunca en el repo
export CF_ACCOUNT_ID=…
export CF_ZONE_ID=…
node scripts/r2-custom-domain.mjs          # conecta y espera a que el certificado quede activo
node scripts/r2-custom-domain.mjs --check  # solo verifica, no escribe nada
```

Después de que quede `active`: `R2_PUBLIC_URL=https://cdn.partops.autos` en la API y redesplegar. Las
URLs ya guardadas seguirán saliendo por `pub-*.r2.dev`: **deja ese subdominio activo una semana** y
después apágalo en R2 → Settings → Public access.

**Cómo se confirma.** `curl -I` del dominio devuelve 200 con `content-type: image/webp` y una imagen
carga en `/app/catalogo`.

---

## 3b · Cambiar el dominio de las fotos sin romper las viejas

**El problema, en una frase.** La URL de cada foto se guarda **en la base** dentro de
`part_image.url`. Las fotos subidas hoy apuntan a `https://pub-<hash>.r2.dev/...`; si mañana se apaga
ese subdominio, esas fotos dejan de cargar aunque `R2_PUBLIC_URL` ya diga `cdn.partops.autos`. Y el
borrado también se rompe: `keyFromUrl` solo puede extraer la `key` de una URL que reconoce.

**Por eso el orden es este y no otro:**
1. Conectar `cdn.partops.autos` (`node scripts/r2-custom-domain.mjs`) y esperar a `active`.
2. Poner `R2_PUBLIC_URL=https://cdn.partops.autos` en la API. **Las fotos nuevas ya salen por ahí.**
3. Dejar `pub-*.r2.dev` encendido. No es pereza: es lo que mantiene visibles las fotos ya guardadas.
4. Migrar las filas viejas cuando convenga (abajo).
5. Solo entonces apagar `pub-*.r2.dev` en R2 → Settings → Public access.

**Migrar las URLs guardadas** (idempotente, se puede correr dos veces). Cambia el host y deja la
`key` intacta, que es lo que hace que el borrado siga funcionando:

```sql
-- Antes: cuántas quedan apuntando al subdominio de terceros (principal + respaldo WebP).
SELECT count(*) FROM "part_image"
 WHERE "url" LIKE 'https://pub-%.r2.dev/%' OR "fallbackUrl" LIKE 'https://pub-%.r2.dev/%';

UPDATE "part_image"
   SET "url" = regexp_replace("url", '^https://pub-[a-z0-9]+\.r2\.dev/', 'https://cdn.partops.autos/'),
       "fallbackUrl" = CASE
         WHEN "fallbackUrl" LIKE 'https://pub-%.r2.dev/%'
         THEN regexp_replace("fallbackUrl", '^https://pub-[a-z0-9]+\.r2\.dev/', 'https://cdn.partops.autos/')
         ELSE "fallbackUrl"
       END
 WHERE "url" LIKE 'https://pub-%.r2.dev/%' OR "fallbackUrl" LIKE 'https://pub-%.r2.dev/%';
```

El `^` no es adorno: sin él, una `key` que contenga `https://pub-…r2.dev/` también se reescribiría.
Correr la primera consulta después del `UPDATE` tiene que dar `0`.

**Cómo se confirma.** Abrir una pieza con foto vieja y su miniatura carga; borrar una imagen desde
`/app/catalogo` la quita del bucket (no deja huérfana).

---

## 4 · El respaldo falló

**Cómo se detecta.** El workflow `Backup` en rojo. El correo de GitHub llega con el paso que falló: casi
siempre `pg_dump` o el simulacro.

**Qué se hace.**

```bash
# Reproducir en local con las mismas credenciales.
DIRECT_DATABASE_URL="postgres://..." pnpm backup

# Errores y qué significan:
#  "query would be affected by row-level security policy"
#     → se está usando el rol de la app. Hace falta el rol dueño (DIRECT_DATABASE_URL).
#  "El dump pesa X KB, menos del mínimo"
#     → base vacía o URL equivocada. NO se subió: el de ayer sigue en R2.
#  "Al dump le faltan tablas obligatorias"
#     → el dump es de otra base.
#  "No se encontró pg_dump"
#     → instalar postgresql-client (o `brew install libpq`).
```

**Restaurar de verdad** (incidente real, no simulacro):

```bash
# 1. Bajar el último respaldo del bucket.
aws s3 cp s3://partops/backups/partops-2026-10-30.dump . \
  --endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com

# 2. Restaurar en una base NUEVA, nunca encima de la que está sirviendo.
pg_restore --clean --if-exists --no-owner --dbname="$NEW_DATABASE_URL" partops-2026-10-30.dump

# 3. Verificar antes de apuntar la API a la nueva.
pg_restore --list partops-2026-10-30.dump | grep -c "TABLE DATA"
psql "$NEW_DATABASE_URL" -c "SELECT count(*) FROM tenant"

# 4. Cambiar DATABASE_URL en Render y redesplegar.
```

**Cómo se confirma.** El workflow verde y `var/restore-drill.json` con `"ok": true`. El informe queda
como artefacto 30 días: ese archivo es la evidencia de que el respaldo de esa noche sirve.

---

## 5 · Fuga entre negocios (el incidente grave)

**Cómo se detecta.** Un cliente ve una pieza, un pedido o un cliente que no es suyo. También puede
llegar como reporte: "me aparece el nombre de otra bodega".

**Esto no se arregla con un parche rápido. Primero se contiene, después se investiga.**

**Contención, en orden.**

```bash
# 1. Cortar el acceso a la pantalla afectada (Cloudflare → WAF → bloquear la ruta).
#    Un negocio sin sistema un día es mejor que cien negocios filtrados un día.

# 2. Confirmar que la RLS sigue forzada en TODAS las tablas con tenantId.
psql "$DIRECT_DATABASE_URL" -c "
  SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = c.relname AND column_name = 'tenantId')
   ORDER BY relforcerowsecurity, relname;"
# Cualquier fila con false/false es la causa o una causa más.
```

```sql
-- 3. ¿Quién vio qué? La bitácora dice qué se leyó y qué se cambió.
SELECT "createdAt", "tenantId", "userId", action, entity, "entityId"
  FROM audit_log
 WHERE "createdAt" > now() - interval '24 hours'
 ORDER BY "createdAt" DESC LIMIT 100;

-- 4. Aplicar la política que falte (esto SÍ puede correr con la API arriba).
ALTER TABLE "tabla" FORCE ROW LEVEL SECURITY;
```

**Después.** Rotar `BETTER_AUTH_SECRET` (invalida todas las sesiones), revisar cómo entró el acceso
—un endpoint nuevo sin `tenantTx`, una consulta con `db.system`, una política que faltó en una
migración—, escribir la prueba que lo habría detectado y solo entonces reabrir.

**Cómo se confirma.** La consulta del paso 2 devuelve `true` en las dos columnas para todas las
tablas con `tenantId`, y una prueba con dos cuentas reales —una de cada negocio— confirma que ninguna
ve los datos de la otra. Esa prueba está en `packages/db/src/rls.test.ts` y también se corre contra
producción a mano con dos cuentas de prueba antes de dar por cerrado.

---

## 6 · El login deja de funcionar (cookie entre subdominios)

**Cómo se detecta.** El formulario de `/entrar` responde 200, la pantalla siguiente expulsa al usuario,
y al recargar vuelve a pedir contraseña. O entra, navega a `/app` y la primera petición da 401.

**Las tres causas, en orden de frecuencia.**
1. **La cookie no lleva dominio.** Debe decir `Domain=.partops.autos` en DevTools → Application →
   Cookies. Si dice `app.partops.autos` o `api.partops.autos`, falta `COOKIE_DOMAIN` en la API o está
   escrito sin el punto inicial.
2. **El CSP bloquea la API.** La consola dice `Refused to connect`. `connect-src` en `proxy.ts`
   incluye el origen de `NEXT_PUBLIC_API_URL`; si la variable apunta a otro host, se bloquea.
3. **`NEXT_PUBLIC_API_URL` y `COOKIE_DOMAIN` se contradicen.** El navegador llama a la API directo
   pero la cookie es del host de la web, o al revés.

**Qué se hace.**

```bash
# 1. ¿Qué cookie está emitiendo la API?
curl -sI https://api.partops.autos/api/auth/get-session | grep -i set-cookie

# 2. Volver al rewrite mientras se corrige (no requiere tocar código):
#    vaciar NEXT_PUBLIC_API_URL en el servicio web y redesplegar.
```

El rewrite de `/api/*` se deja puesto a propósito: es el respaldo de un solo cambio de variable. Con
la variable vacía la app funciona como antes, pasando por el servidor de la web.

**Cómo se confirma.** Entrar, navegar a `/app`, recargar, cambiar de negocio y salir — todo sin que
nadie sea expulsado. En DevTools, la cookie dice `Domain=.partops.autos` y las peticiones van a
`api.partops.autos`.

---

## 7 · Un correo no llegó (invitación o recuperación)

**Cómo se detecta.** El sistema dice "invitación enviada" y la persona jura que no le llegó nada. O
alguien pulsa "Olvidé mi contraseña" y el enlace nunca aparece.

**Lo primero: mirar el proveedor, no el código.** El log del servicio `partops-api` dice al arrancar
por dónde sale el correo:

```
Correo saliendo por gmail          ← configurado
MAIL_PROVIDER=log: los correos NO se envían…   ← en ROJO: nadie recibe nada
MAIL_PROVIDER=resend sin RESEND_API_KEY…       ← en ROJO: todo envío falla
```

Si dice `log`, no hay nada que depurar: **no se envía**. La pantalla de Equipo ya no miente en ese
caso —dice "la invitación quedó creada, pero el correo no salió" y ofrece el enlace— pero el enlace
de recuperación de contraseña no tiene ese respaldo: con `log` la recuperación no funciona y hay que
cambiarla a mano desde la base o esperar a tener correo.

| Síntoma en el log                        | Causa                                       | Qué hacer                                                                    |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| `535 Username and Password not accepted` | Contraseña de aplicación revocada o vencida | Generar otra en la cuenta de Gmail (requiere 2FA) y actualizar el secreto.   |
| `Resend rechazó el envío: 401`           | Token revocado                              | Token nuevo en Resend → `RESEND_API_KEY` → redesplegar.                      |
| `Resend rechazó el envío: 403` (dominio) | Dominio sin verificar en Resend             | Verificar `partops.autos` en Resend (DNS) **antes** de cambiar el remitente. |
| Nada en el log y el correo no llega      | Spam o remitente `@gmail.com`               | Revisar spam; migrar a `resend` con dominio verificado.                      |

**El remitente importa.** Con Gmail, `MAIL_FROM` debe ser la misma cuenta que `GMAIL_USER`: Gmail
rechaza un `From` de otro dominio. Con el dominio propio, `MAIL_FROM="PartOps <no-reply@partops.autos>"`
y el dominio verificado en Resend.

**Cómo se confirma.** Invitar a un correo real propio desde `/app/equipo`, ver el correo, abrir el
enlace en una ventana privada y canjear. Y una recuperación completa desde `/recuperar`.

---

## 8 · El despliegue automático no corre

**Cómo se detecta.** Un push a `main` no dispara nada, o el run falla en el primer paso.

El workflow `Deploy` tiene una compuerta (`preflight`) que **no toca la base** hasta confirmar que
está la configuración del entorno `production`. Si falta algo, el run falla en segundos y el resumen
del run dice exactamente qué. Eso es a propósito: antes, un valor faltante se descubría a mitad del
despliegue, con la migración ya aplicada y la API ya disparada.

**Tres secretos y dos variables.** Las URLs son públicas: guardarlas como secreto no protege nada y
hace que nadie pueda leerlas al depurar un run. Los hooks sí son credenciales —quien tiene uno
despliega— y la cadena de conexión también.

```bash
# Ver qué hay (los valores de los secretos no se muestran nunca)
gh secret list --env production -R joshi198815-byte/partops
gh variable list --env production -R joshi198815-byte/partops

# Variables: no hay prompt, el valor va en el comando y es público.
gh variable set PRODUCTION_API_URL --env production -R joshi198815-byte/partops --body "https://api.partops.autos"
gh variable set PRODUCTION_WEB_URL --env production -R joshi198815-byte/partops --body "https://app.partops.autos"

# Secretos: el valor se pega en el prompt, no queda en el historial del shell.
gh secret set PRODUCTION_DIRECT_DATABASE_URL -R joshi198815-byte/partops --env production
gh secret set RENDER_API_DEPLOY_HOOK        -R joshi198815-byte/partops --env production
gh secret set RENDER_WEB_DEPLOY_HOOK        -R joshi198815-byte/partops --env production
```

| Dato                             | Tipo     | De dónde sale                                   | Ojo                                                                             |
| -------------------------------- | -------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `PRODUCTION_DIRECT_DATABASE_URL` | secreto  | Neon → Connection string, rol **dueño**         | No el rol de la app: las migraciones crean tablas y políticas y fallan con RLS. |
| `PRODUCTION_API_URL`             | variable | `https://api.partops.autos`                     | Sin `/api` al final; el workflow lo añade.                                      |
| `PRODUCTION_WEB_URL`             | variable | `https://app.partops.autos`                     | Es la base del humo.                                                            |
| `RENDER_API_DEPLOY_HOOK`         | secreto  | Render → `partops-api` → Settings → Deploy Hook | Un hook por servicio; cruzarlos despliega lo viejo.                             |
| `RENDER_WEB_DEPLOY_HOOK`         | secreto  | Render → `partops-web` → Settings → Deploy Hook | Igual.                                                                          |

**Probar sin migrar** (lo más seguro la primera vez):

```bash
gh workflow run deploy.yml -f skip_migrations=true
gh run watch
```

**Cómo se confirma.** El run termina en verde y el paso "Humo de producción" pasa. La web sirve
`x-partops-commit` con el SHA del push; la API lo devuelve en `/api/health/ready`.

**Si el run se queda esperando el SHA.** Render puede tardar; el workflow espera 10 minutos y falla
diciendo qué versión está sirviendo. Antes de relanzar, mirar el log del build en Render: casi
siempre es un build roto, no un problema del workflow.

---

## Contactos y escalamiento

| Situación                      | A quién                                   | Cuándo                                |
| ------------------------------ | ----------------------------------------- | ------------------------------------- |
| Fuga entre negocios confirmada | Dueño de PartOps, de inmediato            | Antes de investigar                   |
| Pérdida de datos               | Dueño + revisar respaldo del día anterior | En la primera hora                    |
| Caída > 30 min                 | Dueño                                     | Con el estado de Render y Neon a mano |
| Vulnerabilidad reportada       | `partopsgt@gmail.com`                     | 72 h de respuesta                     |

## Rutina que evita la mitad de esto

- Lunes: revisar el workflow `Backup` de la semana y el último `restore-drill.json`.
- Mensual: correr `pnpm restore:drill` contra un dump real y mirar el informe, no solo el color verde.
- Al rotar un secreto: actualizar los dos lados (Render y GitHub / Render y Worker) en la misma hora.
- Antes de cada despliegue grande: `pnpm smoke` contra producción para tener línea base.

## Nota sobre los workflows que fallan solos

Dos fallos se veían en cada push y no eran del producto, sino de la configuración del propio GitHub.
Vale la pena reconocerlos porque volverán a aparecer con otro archivo:

| Síntoma                                                        | Causa                                                                         | Arreglo                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Un workflow aparece con `failure` en **0 s** y **sin jobs**.   | El YAML es inválido para Actions. Consultar `secrets` en un `if` lo invalida. | Copiar los secretos al `env` del job y condicionar sobre `env`.           |
| La CI falla en los tests de búsqueda pero pasan en tu máquina. | Falta sembrar la referencia vehicular en la base del runner.                  | `pnpm --filter @partops/db seed` después de migrar (ya está en `ci.yml`). |
