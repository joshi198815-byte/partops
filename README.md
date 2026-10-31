# PartOps

Sistema de inventario, venta y despacho para bodegas de repuestos automotrices en Guatemala.
Multi-tenant, en quetzales, con precios que ya incluyen IVA.

## Arranque

```bash
pnpm install
cp .env.example .env      # completar BETTER_AUTH_SECRET
pnpm db:migrate           # crea tablas, RLS, índices de búsqueda y el rol partops_app
pnpm dev
```

- Web: http://localhost:3000
- API: http://localhost:4000/api/health/live

## Reglas del proyecto

Estas no son preferencias de estilo; cada una existe porque su ausencia rompe algo concreto.
1. **Toda tabla de negocio lleva `tenantId` y RLS forzado.** La migración `0002_rls` activa
   `FORCE ROW LEVEL SECURITY` y la API corre con un rol sin privilegios de dueño. Si agregas una
   tabla y no la incluyes ahí, se filtra entre negocios: es el bug más caro posible.
2. **Dinero en centavos enteros.** Nunca `float`, nunca `Decimal` para sumar. El IVA se desglosa
   por diferencia (`total - base`) para que las líneas siempre sumen el total.
3. **El inventario se mueve solo por `InventoryService`.** Hace un `UPDATE` condicional atómico y
   escribe en el ledger. El ledger es append-only por trigger: corregir es un movimiento nuevo.
4. **El costo se congela en la línea de venta.** La utilidad histórica no cambia cuando cambia el
   precio del proveedor.
5. **Nada de datos falsos en la interfaz.** Ni cifras, ni testimonios, ni "12,000 negocios".

## Estructura

```
apps/
  api/        NestJS 11 · REST + WebSocket
  web/        Next.js 16 (App Router) · Render con `output: 'standalone'`
  mobile/     Capacitor 8 · shell Android sobre la web
packages/
  contracts/  Zod, dinero, búsqueda, permisos, estados — puro y probado
  db/         Prisma 7, migraciones RLS, cliente con contexto de tenant
  ui/         Tokens OKLCH y componentes de marca
infra/        Postgres local, Worker de keepalive
scripts/      Generación de marca, verificación de secretos, humo, respaldo y simulacro
```

## Producción

La API y el worker de mantenimiento salen de la misma imagen (`apps/api/Dockerfile`) y se despliegan
en Render desde `render.yaml`. La web es Next.js con imagen propia (`apps/web/Dockerfile`,
`output: 'standalone'`); el CSP con nonce y la cabecera que prueba el commit del build viven en
`apps/web/src/proxy.ts` y `apps/web/next.config.mjs`.

```bash
pnpm smoke        # dominio, salud, RLS, commit desplegado, CSP y sesión privada
pnpm backup       # dump verificado a var/backups y a R2 (retención 14 días)
pnpm restore:drill -- var/backups/partops-YYYY-MM-DD.dump   # simulacro en base limpia
```

Piezas que no se ven en el código:
- **Sentry es opcional.** Sin `SENTRY_DSN` la API no carga el SDK ni hace una sola llamada de red.
  Con DSN, errores al 100 % y trazas al 10 %, sin PII.
- **La API y el worker son el mismo artefacto**, separados por `PROCESS_ROLE`. El worker no abre
  puerto; su trabajo es el mantenimiento diario.
- **El latido de Neon lo da un Worker de Cloudflare** cada 10 minutos (`infra/keepalive`), porque el
  `setInterval` interno se congela si el proveedor duerme el proceso.
- **La web se despliega después de la API y se verifica.** Render traduce las variables del servicio
  a _build args_, así que `render.yaml` basta: no hay que pasar nada a mano en el build. La imagen
  hornea `x-partops-commit` y el workflow no avanza al humo hasta que esa cabecera coincide con el
  SHA, igual que hace `/api/health/ready` para la API.

Procedimientos de incidente: [`RUNBOOK.md`](RUNBOOK.md). Política de seguridad: [`SECURITY.md`](SECURITY.md).

## Verificación

```bash
pnpm typecheck
pnpm test        # incluye aislamiento RLS y la carrera por la última pieza
pnpm build
```

Los tests de `packages/db` y `apps/api` necesitan Postgres. Sin `DATABASE_URL` se saltan en lugar
de fallar, para que un clon nuevo no se rompa en el primer `pnpm test`.
