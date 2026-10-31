# Seguridad en PartOps

PartOps guarda inventario, ventas y dinero de negocios que compiten entre sí. Una fuga entre
negocios no es un bug incómodo: es la razón por la que un cliente se va y no vuelve. Este documento
dice qué se protege, cómo, y dónde está el punto débil conocido.

## Modelo de amenaza

| Amenaza                      | Quién                      | Cómo se defiende                                                                         |
| ---------------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| Leer datos de otro negocio   | Cliente con sesión válida  | RLS en Postgres, rol sin `BYPASSRLS`, `tenantId` nunca viene del cliente                 |
| Adivinar contraseñas         | Bot                        | 10 intentos/min por IP en `/auth`, límite propio de Better Auth, Turnstile en la vitrina |
| Robar la sesión              | XSS, red abierta           | Cookie `HttpOnly`+`Secure`+`SameSite`, CSP con nonce, HSTS                               |
| Inyectar script              | XSS reflejado o almacenado | CSP con `strict-dynamic`, React escapa por defecto, cero `dangerouslySetInnerHTML`       |
| Abusar de la API             | Script, scraping           | Límites por ruta, por IP y por negocio; caché de borde en la vitrina                     |
| Sacar el respaldo            | Acceso a R2                | Credenciales solo en el entorno del job, bucket privado, sin URL pública                 |
| Adivinar el secreto del cron | Internet                   | 32+ bytes aleatorios, `timingSafeEqual`, 404 si no está configurado                      |
| Reemplazar la app Android    | APK falso                  | Firma de release en CI, keystore fuera del repo, `usesCleartextTraffic` solo en debug    |

Fuera de alcance declarado: un atacante con acceso root al servidor de base de datos. Contra eso no
hay aplicación que defienda; lo que hay es respaldo y rotación de credenciales.

## Aislamiento entre negocios

Es la propiedad central y se apoya en cuatro capas, no en una:
1. **La base decide.** Cada tabla de negocio tiene RLS con `FORCE ROW LEVEL SECURITY`, y la política
   compara `tenantId` contra `current_setting('app.tenant_id')`. `FORCE` importa: sin él, el dueño de
   la tabla —el rol que corre las migraciones— ve todo.
2. **La conexión de la aplicación no puede saltarse la política.** `DATABASE_URL` usa el rol
   `partops_app`, con `NOBYPASSRLS` y sin ser dueño de ninguna tabla. Si mañana alguien conecta la API
   con el rol dueño, `/health/ready` devuelve 503 y el balanceador la saca de rotación.
3. **El código fija el tenant en cada transacción.** `tenantTx` ejecuta `set_config('app.tenant_id', …)`
   antes de la consulta del usuario. Un `findMany` al que se le olvidó el `where` sigue viendo solo su
   negocio.
4. **El tenant nunca viene del cuerpo.** Se resuelve del header `x-tenant-id` **validado contra la
   membresía** del usuario, o del negocio activo de la sesión. Un `tenantId` en el JSON se ignora.

El acceso de sistema (`db.system`) es explícito y está limitado a: provisionamiento, el panel de
plataforma y los trabajos globales. Cualquier uso en un endpoint de negocio es un defecto de
aislamiento y así se revisa en el código.

## Sesiones y autenticación

- Cookie `partops.session_token`, `HttpOnly`, `Secure` en producción, `SameSite=Lax`. `Lax` y no
  `Strict` porque el retorno del enlace de recuperación tiene que conservar la sesión.
- Better Auth rechaza peticiones sin `Origin` (defensa CSRF). El APK manda `capacitor://localhost`,
  que está en la lista de orígenes confiables.
- Contraseña temporal obligatoria al primer ingreso: el guard corta todo salvo `/me` y el cambio de
  clave. La clave que dictó el dueño no sirve para operar.
- Sesiones revocables: cambiar la contraseña cierra las demás (`revokeOtherSessions`).

## Secretos

Nada de secretos en el repo. `.env` está ignorado; `.env.example` lleva valores vacíos y es el único
lugar con nombres de variables.

| Secreto                  | Dónde vive                    | Cómo se rota                                                                               |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`     | Render (sync: false)          | Nuevo valor → reiniciar. **Invalida todas las sesiones**: avisar antes.                    |
| `DIRECT_DATABASE_URL`    | Render + GitHub (environment) | Rotar en Neon, actualizar los dos lados en la misma hora.                                  |
| `R2_*`                   | Render + GitHub               | Crear token nuevo en Cloudflare, desplegar, revocar el viejo.                              |
| `CRON_SECRET`            | Render + Worker               | `wrangler secret put` y Render, en ese orden; el 401 del log confirma la desincronización. |
| VAPID (push web)         | Render                        | Par nuevo invalida las suscripciones existentes: los usuarios vuelven a aceptar el aviso.  |
| FCM (cuenta de servicio) | Render                        | Crear clave nueva en Google Cloud, actualizar, borrar la anterior.                         |
| Keystore Android         | GitHub Secrets (base64)       | No se rota: si se pierde, el APK no se puede actualizar. Guardar copia fuera del repo.     |

`gitleaks` corre en cada PR sobre el historial completo y `check-secrets.mjs` en el hook de pre-commit
sobre lo preparado. El segundo es la red local; el primero, la de verdad.

## Cabeceras y CSP

La web manda `content-security-policy` con nonce por petición (`apps/web/src/proxy.ts`):
`default-src 'self'`, `script-src 'self' 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`,
`object-src 'none'`, `base-uri 'self'`. Más `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy` (cámara solo propio origen, necesaria para el escáner) y HSTS.

La API no sirve HTML: su CSP es `default-src 'none'` y `frame-ancestors 'none'`.

## Límites de peticiones

Por IP y por negocio (`apps/api/src/common/throttle.ts`), con la ruta en la clave:

| Ruta                | Límite  | Por qué                                                 |
| ------------------- | ------- | ------------------------------------------------------- |
| `/auth/*`           | 10/min  | Presupuesto de adivinar contraseñas                     |
| `/public/catalog/*` | 60/min  | Frena el flood de la vitrina anónima                    |
| `/search`           | 90/min  | La paleta dispara con debounce; un bucle no             |
| `/dispatch/*`       | 600/min | Un teléfono que vuelve sin señal manda su cola de golpe |
| Resto               | 120/min | Techo general                                           |

La clave incluye el negocio activo: cinco teléfonos detrás de la misma IP de oficina no compiten
entre sí.

## Datos y privacidad

- **Sentinel de errores sin PII.** `dataCollection` desactiva usuario, cookies, cabeceras, cuerpos,
  query params y variables locales. La URL se redacta: el slug del negocio y el token del recibo se
  reemplazan por `:slug` y `:token`.
- **Recibos por token.** El enlace público lleva un UUID v7 firmado por la ruta; no se puede enumerar
  y no expone el `tenantId`.
- **Imágenes.** Bucket privado con URL firmada de vida corta; el dominio público de R2 solo sirve el
  catálogo, nunca documentos.
- **Bitácora.** `audit_log` guarda quién, qué, cuándo y el antes/después de las mutaciones sensibles.
  Es append-only por trigger: corregir es un registro nuevo.

## Reportar una vulnerabilidad

Correo a **partopsgt@gmail.com** con asunto `SEGURIDAD`. Incluir: qué se puede hacer, cómo
reproducirlo y el impacto que se le atribuye. Compromiso de respuesta en 72 horas.

No abrir un issue público con el detalle. No probar contra datos de negocios reales: hay un entorno
de desarrollo y se puede pedir una cuenta de prueba.
