# Runbook

Cinco cosas que se rompen. Cada una con cómo se detecta, qué se hace y cómo se confirma que quedó.
En ese orden: el error común es arreglar sin haber confirmado el síntoma y sin haber comprobado que
de verdad se resolvió.

Antes de tocar nada: **anotar la hora y qué se vio**. Un incidente sin línea de tiempo se repite.

```bash
# Estado rápido, en un comando.
pnpm smoke        # dominio, salud, RLS, CSP, sesión privada
curl -s https://api.partops.gt/api/health/ready | jq
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
curl -s --max-time 60 https://api.partops.gt/api/health/ready | jq

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
curl -s -o /dev/null -w "%{http_code}\n" https://api.partops.gt/api/health/live
curl -s -o /dev/null -w "%{http_code}\n" https://app.partops.gt/entrar
#    Si la web responde y la API no, la web sigue sirviendo login y assets: no la reinicies.
curl -sI https://app.partops.gt/entrar | findstr /i "x-partops-commit"

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
curl -sI https://cdn.partops.gt/parts/<id>.webp | head -3
```

Si el objeto existe y el dominio no responde: revisar el DNS del dominio en Cloudflare (registro CNAME
al bucket) y el estado del certificado en R2 → Settings → Custom Domains.

**Cómo se confirma.** `curl -I` del dominio devuelve 200 con `content-type: image/webp` y una imagen
carga en `/app/catalogo`.

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
