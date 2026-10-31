# Fase 4 — Dinero, plataforma y entrega · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar la Fase 4 de PartOps v1: tablero del día con acciones reales, paleta de comandos, auditoría visible, panel de plataforma, shell Android con escáner y push, y el camino a producción (límites, observabilidad, respaldos, despliegue).

**Architecture:** Todo lo nuevo entra por los patrones existentes: contrato Zod en `packages/contracts`, controlador NestJS con `@RequirePermissions`/`@PlatformAdmin`, lectura bajo `db.tx(tenantId, …)` (RLS) salvo el panel de plataforma que usa `db.system(…)`, y pantalla Next del servidor con `requireMe()`. La paleta reutiliza el buscador existente; el escáner ya existe en despacho y solo se le añade el puente nativo.

**Tech Stack:** NestJS 11 · Prisma 7 · PostgreSQL (RLS forzado) · Next.js 16 · Capacitor 8 · Socket.IO · Web Push + FCM HTTP v1 · GitHub Actions · Render/Neon/Cloudflare/R2.

**Spec:** `docs/arquitectura-partops-v1.md` (T14–T17, §7 y §8).

## Estado real antes de este plan

| Tarea de la spec                                     | Estado      | Evidencia                                                                                                                      |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| T14 Finanzas, COGS congelado, `daily_metric`, export | **Hecha**   | `apps/api/src/modules/finance/*`, `apps/web/src/app/app/finanzas/*`, 10 tests                                                  |
| T15 Tablero, ⌘K, auditoría, `/admin`                 | **Parcial** | Tablero solo cuenta catálogo; `audit()` escribe pero nadie lee; no existe ⌘K ni `/admin`                                       |
| T16 Android Capacitor                                | **Falta**   | Solo `apps/mobile/assets/*` (iconos/splash)                                                                                    |
| T17 Producción                                       | **Falta**   | Sin `Dockerfile`, `render.yaml`, workflows de deploy/backup, keepalive, smoke, `RUNBOOK.md`, Sentry, throttling, CSP con nonce |

## Global Constraints

- Dinero en centavos enteros (`*Cents`); nunca `number` flotante para importes ni formateo en la capa de datos.
- Toda lectura/escritura de negocio dentro de `db.tx(tenantId, …)` — RLS `FORCE` ya está activo; `db.system` solo en onboarding y en el panel de plataforma.
- Fechas de negocio en la zona del tenant (`America/Guatemala`), con `localDay`/`localBoundary`/`todayIn` de `apps/api/src/common/time.ts`. Nunca UTC para cortes de día.
- Mutaciones sensibles escriben `audit()` **dentro** de la misma transacción.
- UI en español de Guatemala (`es-GT`). Cero cifras, usuarios o pedidos inventados: lo que no hay se dice, no se pinta en cero.
- Cobre `#B4703A` solo como filete, muesca o serie de gráfica. Radios 4/8 px, sin blur, sin glow, sin botones píldora.
- Los permisos se resuelven en el servidor; el menú es comodidad, no seguridad.
- Planes gratuitos: Neon 0.5 GB, Render 512 MB y duerme a los 15 min, R2 10 GB. Nada puede depender de Redis ni de un cron pago.
- Sin pasarela de pago en v1: los planes se conceden a mano desde `/admin`.

## Review Focus

Las cinco fallas que la spec implica pero ningún test de tarea cubre por sí solo. Cada una lleva su test en la tarea dueña.
1. **Fuga en la paleta de comandos**: un resultado cacheado o una URL mal construida puede mostrar el teléfono de un cliente de otro negocio. Esperado: cero filas ajenas.
2. **El rate limit corta la sincronización offline**: el teléfono del bodeguero reconecta y manda 40 operaciones de golpe. Esperado: `/api/dispatch/sync` y `/api/dispatch/orders/:id/lines/:itemId/scan` con presupuesto alto, nunca 429 en uso real.
3. **Auditoría huérfana**: un registro escrito antes del commit o en otra transacción sobrevive a un rollback. Esperado: se revierte con el cambio.
4. **Concesión de plan ambigua**: `expiresAt` nulo o en el pasado. Esperado: nulo = sin vencimiento declarado; pasado = rechazo con mensaje.
5. **Respaldo vacío**: el job dice "ok" con un dump de 0 bytes o sin tablas. Esperado: el respaldo se verifica (tamaño + conteo de tablas) y falla ruidosamente.
6. **Shell Android con red inestable**: con `server.url` y el túnel caído la app no debe quedar en blanco. Esperado: `offline.html` con reintento.

---

## Bloque A — T15 · Tablero, paleta, auditoría y plataforma

### Task 1: Tablero «Hoy» con cifras reales

**Files:**
- Create: `packages/contracts/src/dashboard.ts`
- Modify: `packages/contracts/src/index.ts` (añadir `export * from './dashboard.js';`)
- Create: `apps/api/src/modules/dashboard/dashboard.service.ts`
- Create: `apps/api/src/modules/dashboard/dashboard.controller.ts`
- Create: `apps/api/src/modules/dashboard/dashboard.service.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/web/src/app/app/dashboard.tsx`

**Interfaces:**
- Consumes: `DatabaseService.tx`, `localDay`, `localBoundary`, `todayIn`, `shiftDay`; `DispatchQueueResponse.pendingUnits` como forma de referencia.
- Produces: `DashboardToday` (contrato) y `GET /api/dashboard/today` (`dashboard.view`).

```ts
export interface DashboardToday {
  /** `YYYY-MM-DD` en la zona del negocio. */
  day: string;
  /** `null` sin `finance.view`: no es cero, es «no te toca verlo». */
  salesCents: number | null;
  ordersTodayCount: number | null;
  /** Unidades por preparar y listas, en las bodegas visibles. */
  pendingUnits: number;
  readyUnits: number;
  lowStock: number;
  outOfStock: number;
  missedSearches: number;
  openOrders: number;
}
```

- [ ] **Step 1: Escribir el test que falla (Postgres real, mismo patrón que `finance.service.test.ts`)**

```ts
it('el tablero cuenta solo el día local y solo las bodegas asignadas', async () => {
  // Dos ventas entregadas: una hoy 23:30 local, otra ayer 23:30 local (mañana UTC).
  // Una tercera línea EN_PREPARACION en otra bodega no asignada.
  const hoy = await service.today(ctxConBodegaA);
  expect(hoy.day).toBe(todayIn('America/Guatemala'));
  expect(hoy.salesCents).toBe(ventaDeHoyCents);
  expect(hoy.ordersTodayCount).toBe(1);
  expect(hoy.pendingUnits).toBe(0); // la línea está en la bodega no asignada
});

it('sin finance.view las ventas llegan en null, no en cero', async () => {
  const data = await service.today(ctxSinFinanzas);
  expect(data.salesCents).toBeNull();
  expect(data.outOfStock).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm --filter @partops/api test dashboard`
Expected: FAIL — `Cannot find module './dashboard.service.js'`.
- [ ] **Step 3: Implementar `DashboardService.today(ctx: Ctx): Promise<DashboardToday>`**

Una sola `db.tx(ctx.tenant.tenantId, …)` con cuatro consultas en `Promise.all`:
ventas del día (`sales_order_item.deliveredAt` entre `localBoundary(day)` y `localBoundary(nextDay(day))`, `status = 'ENTREGADO'`),
unidades por estado (líneas con `status IN ('PENDIENTE','EN_PREPARACION','LISTO')` y `warehouseId = ANY(allowed)` cuando `allowed` no está vacío),
agotados/bajo mínimo (misma consulta que `CatalogController.overview`, reutilizada tal cual),
búsquedas sin resultado de los últimos 30 días.
`salesCents`/`ordersTodayCount` solo si `ctx.tenant.permissions.has('finance.view')`.
- [ ] **Step 4: Controlador y cableado**

`@Controller('dashboard')`, `@Get('today')`, `@RequirePermissions('dashboard.view')`, provider en `app.module.ts`.
- [ ] **Step 5: Test en verde**

Run: `pnpm --filter @partops/api test dashboard`
Expected: PASS.
- [ ] **Step 6: Pintar el tablero**

En `apps/web/src/app/app/dashboard.tsx`, `serverFetch('/api/dashboard/today')` junto a `/api/catalog/overview`. Cuatro `StatTile` nuevos arriba: «Vendido hoy», «Por despachar», «Sin existencia», «Búsquedas sin respuesta», cada uno enlazando a su pantalla (`/app/finanzas`, `/app/despacho`, `/app/inventario`, `/app/buscar`). Si `salesCents === null`, la tarjeta muestra «—» y el texto «Necesitas permiso de finanzas», nunca `Q 0.00`. Sin datos: `EmptyState` actual intacto.
- [ ] **Step 7: Verificar y commitear**

Run: `pnpm lint && pnpm typecheck && pnpm --filter @partops/api test dashboard`
Expected: sin diagnósticos; tests PASS.

```bash
git add packages/contracts/src/dashboard.ts packages/contracts/src/index.ts apps/api/src/modules/dashboard apps/api/src/app.module.ts apps/web/src/app/app/dashboard.tsx
git commit -m "feat(dashboard): cifras del día con ventas, despacho, agotados y demanda"
```

### Task 2: Paleta de comandos ⌘K

**Files:**
- Create: `packages/contracts/src/command.ts`, `packages/contracts/src/command.test.ts`
- Create: `apps/api/src/modules/search/command.controller.ts`, `apps/api/src/modules/search/command.service.ts`, `apps/api/src/modules/search/command.service.test.ts`
- Create: `apps/web/src/components/command-palette.tsx`
- Create: `apps/web/src/lib/scanner.ts`, `apps/web/src/lib/scanner.test.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/web/src/components/app-shell.tsx`, `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `search.run` (texto y OEM), `orders.list`, `customer` (tabla ya usada por `orders.service`).
- Produces: `GET /api/command?q=` (`catalog.view`), `CommandResponse`, `commandQuerySchema`, `rankHits(hits, q)`, y `scanCode(): Promise<string | null>` en `@/lib/scanner`.

```ts
export type CommandKind = 'part' | 'order' | 'customer' | 'action';
export interface CommandHit {
  id: string;
  kind: CommandKind;
  title: string;
  subtitle: string | null;
  code: string | null;
  href: string;
}
export interface CommandResponse {
  query: string;
  groups: Array<{ kind: CommandKind; label: string; hits: CommandHit[] }>;
}
export const commandQuerySchema = z.object({ q: z.string().trim().max(120).default('') });
/** Deduplica por `kind:id`, ordena por coincidencia exacta de código y corta a `limit` por grupo. */
export function rankHits(hits: readonly CommandHit[], q: string, limit = 5): CommandHit[];
```

- [ ] **Step 1: Test de contrato**

```ts
it('el código exacto gana sobre el nombre y no se duplica', () => {
  const hits = [
    {
      id: '1',
      kind: 'part',
      title: 'Faro delantero',
      subtitle: 'TY-100',
      code: 'TY-100',
      href: '/app/buscar?q=TY-100',
    },
    {
      id: '1',
      kind: 'part',
      title: 'Faro delantero',
      subtitle: 'TY-100',
      code: 'TY-100',
      href: '/app/buscar?q=TY-100',
    },
    {
      id: '2',
      kind: 'part',
      title: 'TY-100 reforzado',
      subtitle: null,
      code: null,
      href: '/app/buscar?q=TY-100',
    },
  ] as CommandHit[];
  expect(rankHits(hits, 'ty100').map((h) => h.id)).toEqual(['1', '2']);
});
```

- [ ] **Step 2: Correr y verlo fallar**

Run: `pnpm --filter @partops/contracts test command`
Expected: FAIL — módulo inexistente.
- [ ] **Step 3: Implementar `rankHits` y el `CommandService`**

`CommandService.find(ctx, q)`: con `q` vacío devuelve solo acciones permitidas (Nueva venta, Despacho, Importar, Finanzas, según permisos). Con texto: `SearchService.run` limit 5 para piezas, `SELECT id, number, customerName FROM sales_order … ILIKE` limit 5 para pedidos, `SELECT id, name, phone FROM customer … ILIKE` limit 5 para clientes — las tres bajo `ctx.tenant.tenantId`. Devuelve `CommandResponse` agrupado por `rankHits`.
- [ ] **Step 4: Test de aislamiento**

```ts
it('la paleta no ve clientes de otro negocio', async () => {
  const res = await command.find(ctxA, 'María');
  expect(res.groups.flatMap((g) => g.hits).every((h) => !h.href.includes(tenantBId))).toBe(true);
  expect(res.groups.flatMap((g) => g.hits).some((h) => h.id === customerDeB)).toBe(false);
});
```

Run: `pnpm --filter @partops/api test command`
Expected: PASS con el servicio; FAIL antes.
- [ ] **Step 5: `scanner.ts` con dos rutas**

```ts
/** Nativo (Capacitor) primero; `BarcodeDetector` del navegador después; `null` si no hay cámara. */
export async function scanCode(): Promise<string | null>;
```
Test: sin `window` ni puente nativo devuelve `null` y no lanza.
- [ ] **Step 6: Componente y montaje**

`CommandPalette` cliente: se abre con ⌘K/Ctrl+K y con un botón en la barra superior; input con debounce 180 ms contra `/api/command`; navegación con flechas y Enter; Esc cierra; `role="dialog"`, `aria-modal`, foco atrapado. Botón «Escanear» llama `scanCode()` y rellena el input; si devuelve `null` el botón no aparece. Se monta dentro de `AppShell`.
- [ ] **Step 7: Verificar y commitear**

Run: `pnpm lint && pnpm typecheck && pnpm --filter @partops/contracts test && pnpm --filter @partops/api test command`
Expected: verde.

```bash
git commit -am "feat(command): paleta ⌘K con piezas, OEM, pedidos, clientes y escáner"
```

### Task 3: Bitácora de auditoría visible

**Files:**
- Create: `packages/contracts/src/audit.ts`, `packages/contracts/src/audit.test.ts`
- Create: `apps/api/src/modules/account/audit.query.service.ts`, `apps/api/src/modules/account/audit.controller.ts`, `apps/api/src/modules/account/audit.query.service.test.ts`
- Create: `apps/web/src/app/app/auditoria/page.tsx`, `apps/web/src/app/app/auditoria/audit-screen.tsx`
- Modify: `apps/api/src/app.module.ts`, `apps/web/src/components/app-shell.tsx`, `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `audit_log` (ya escrito por finanzas, equipo, catálogo, inventario, importador, configuración, pedidos).
- Produces: `GET /api/audit?entity&action&from&to&actorId&limit&offset` (`audit.view`) y `AuditResponse`.

```ts
export const auditQuerySchema = z.object({
  entity: z.string().trim().max(40).optional(),
  action: z.string().trim().max(80).optional(),
  actorId: z.string().max(64).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export interface AuditRow {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
  actorName: string | null;
}
export interface AuditResponse {
  items: AuditRow[];
  total: number;
  actions: string[];
  entities: string[];
}
```

- [ ] **Step 1: Test de contrato** — rango invertido (`from > to`) falla con mensaje «La fecha inicial va antes de la final».
- [ ] **Step 2: Correr y verlo fallar** — `pnpm --filter @partops/contracts test audit` → FAIL.
- [ ] **Step 3: Implementar** `AuditQueryService.list(ctx, query)` en `db.tx`: join a `user` para `actorName`, filtros por fechas con `localBoundary`, `total` con `count(*)`, y las listas `actions`/`entities` distintas del tenant para poblar los selects.
- [ ] **Step 4: Test de aislamiento y de rollback**

```ts
it('un cambio revertido no deja bitácora', async () => {
  await expect(
    db.tx(tenantId, async (tx) => {
      await audit(tx, { tenantId, action: 'test.rollback', entity: 'part' });
      throw new Error('falla a propósito');
    }),
  ).rejects.toThrow();
  const { total } = await service.list(ctx, { limit: 1, offset: 0 });
  expect(await countAction('test.rollback')).toBe(0);
});
```
Run: `pnpm --filter @partops/api test audit` → PASS.
- [ ] **Step 5: Pantalla** `/app/auditoria` con filtros, tabla de 36 px, `CodeChip` para acción y entidad, desplegable con `before`/`after` en mono. Nav: `{ href: '/app/auditoria', label: 'Auditoría', permission: 'audit.view', group: 'negocio' }`. Sin permiso: `EmptyState` de acceso, igual que finanzas.
- [ ] **Step 6: Verificar y commitear** — `pnpm lint && pnpm typecheck && pnpm test`; commit `feat(audit): bitácora consultable con filtros`.

### Task 4: Panel de plataforma `/admin`

**Files:**
- Create: `packages/contracts/src/platform.ts`, `packages/contracts/src/platform.test.ts`
- Create: `apps/api/src/modules/platform/platform.controller.ts`, `apps/api/src/modules/platform/platform.service.ts`, `apps/api/src/modules/platform/platform.service.test.ts`
- Create: `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/admin/admin-screen.tsx`
- Modify: `apps/api/src/app.module.ts`, `apps/web/src/components/app-shell.tsx`, `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `@PlatformAdmin()`, `db.system`, `audit()`, `plan_grant` (RLS ya forzado).
- Produces:
```ts
export interface AdminTenantRow {
  id: string;
  name: string;
  slug: string;
  suspended: boolean;
  members: number;
  parts: number;
  orders30d: number;
  planTier: string | null;
  planExpiresAt: string | null;
  createdAt: string;
  lastActivityAt: string | null;
}
export interface AdminOverview {
  tenants: AdminTenantRow[];
  jobs: Array<{ queue: string; status: string; runAt: string; lastError: string | null }>;
  demand: { searches30d: number; missed30d: number; topTerms: Array<{ term: string; count: number }> };
  reference: { brands: number; models: number; vehicles: number };
}
export const planGrantSchema = z
  .object({
    tier: z.enum(['FREE', 'PRO', 'TALLER']),
    expiresAt: z.string().datetime().nullable().default(null),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => !v.expiresAt || Date.parse(v.expiresAt) > Date.now(), {
    message: 'La fecha de vencimiento ya pasó',
    path: ['expiresAt'],
  });
```

- [ ] **Step 1: Test de contrato** — `expiresAt` en el pasado falla; `null` pasa.
- [ ] **Step 2: Test de servicio**

```ts
it('un admin de plataforma concede un plan y queda auditado', async () => {
  await service.grantPlan(adminCtx, tenantId, { tier: 'PRO', expiresAt: null });
  const grant = await systemFirstGrant(tenantId);
  expect(grant.tier).toBe('PRO');
  expect(await auditCount(tenantId, 'platform.plan_granted')).toBe(1);
});

it('suspender un negocio lo saca del selector y queda auditado', async () => {
  await service.setSuspended(adminCtx, tenantId, true);
  expect((await systemTenant(tenantId)).suspended).toBe(true);
});

it('un usuario de negocio recibe 404 en /api/platform', async () => {
  const res = await request(app).get('/api/platform/overview');
  expect(res.status).toBe(404);
});
```
Run: `pnpm --filter @partops/api test platform` → FAIL primero, PASS después.
- [ ] **Step 3: Implementar** `AdminController` (`@PlatformAdmin()` en clase): `GET overview`, `POST tenants/:id/plan`, `POST tenants/:id/suspend`, `POST tenants/:id/resume`. Todo con `db.system`; cada mutación con `audit(tx, { tenantId, userId: ctx.user.id, action: 'platform.plan_granted' | 'platform.tenant_suspended' })`.
- [ ] **Step 4: Pantalla** `/admin` server-side: `requireMe()`, si `!me.isPlatformAdmin` → `notFound()`. Tabla de negocios con plan, vencimiento y acciones; bloque de salud de `background_job` (verde/rojo con `lastError`); demanda global; conteos de referencia vehicular. Enlace «Plataforma» en `AppShell` solo si `me.isPlatformAdmin`.
- [ ] **Step 5: Verificar y commitear** — `pnpm lint && pnpm typecheck && pnpm test`; commit `feat(platform): panel /admin con planes, suspensión y salud de jobs`.

---

## Bloque B — T16 · Android con Capacitor

### Task 5: Shell Capacitor y `offline.html`

**Files:**
- Create: `apps/mobile/package.json`, `apps/mobile/capacitor.config.ts`, `apps/mobile/tsconfig.json`
- Create: `apps/mobile/www/index.html`, `apps/mobile/www/offline.html`
- Create: `apps/web/src/lib/native.ts`, `apps/web/src/lib/native.test.ts`
- Modify: `pnpm-workspace.yaml` (ya cubre `apps/*`), `README.md`

**Interfaces:**
- Produces en `@/lib/native`: `isNative(): boolean`, `nativeScan(): Promise<string | null>`, `vibrateShort(): void`, `shareReceipt(text: string): Promise<void>`, `keepAwake(on: boolean): Promise<void>`, `registerPush(): Promise<string | null>`.
- `scanner.ts` (Task 2) pasa a delegar: `nativeScan()` → `BarcodeDetector` → `null`.

- [ ] **Step 1: Test que fija el contrato sin Capacitor** — `isNative()` es `false` cuando `window.Capacitor` no existe; `nativeScan()` resuelve `null`; `scanner.scanCode()` sigue resolviendo `null`; ninguna función lanza.
- [ ] **Step 2: Correr y verlo fallar** — `pnpm --filter @partops/web test native` → FAIL.
- [ ] **Step 3: Scaffold**

`capacitor.config.ts`: `appId: 'gt.partops.app'`, `appName: 'PartOps'`, `webDir: 'www'`, `server: { url: process.env.CAP_SERVER_URL ?? 'https://app.partops.autos', cleartext: false, androidScheme: 'https' }`, `plugins: { SplashScreen: { backgroundColor: '#16324F' }, StatusBar: { style: 'light' } }`.
`www/index.html`: redirige a `CAP_SERVER_URL` y, si falla en 4 s, a `offline.html`.
`www/offline.html`: marca, «Sin conexión con la bodega», botón «Reintentar» y texto de que los cambios guardados se envían solos. Sin JS de terceros.
Paquetes: `@capacitor/core@8`, `@capacitor/cli@8`, `@capacitor/android@8`, `@capacitor/camera`, `@capacitor/push-notifications`, `@capacitor/share`, `@capacitor/haptics`, `@capacitor/keep-awake`.
- [ ] **Step 4: Generar el proyecto nativo** — `pnpm install && pnpm --filter @partops/mobile exec cap add android && pnpm --filter @partops/mobile exec cap sync android`. Copiar iconos/splash desde `apps/mobile/assets` (ya generados por `scripts/render-brand.mjs`).
- [ ] **Step 5: Implementar `native.ts`** usando `Capacitor.isNativePlatform()` y plugins importados de forma dinámica (`await import('@capacitor/haptics')`) para que el bundle web no los cargue. `scanCode` delega en `@capacitor-mlkit/barcode-scanning` si está instalado; si no, `BarcodeDetector`; si no, `null`.
- [ ] **Step 6: Verificar y commitear** — `pnpm lint && pnpm typecheck && pnpm --filter @partops/web test && pnpm build`; commit `feat(mobile): shell Capacitor con respaldo sin conexión`.

### Task 6: Escáner integrado en despacho y búsqueda

**Files:**
- Modify: `apps/web/src/app/app/despacho/dispatch-screen.tsx`, `apps/web/src/app/app/buscar/search-screen.tsx`
- Test: `apps/web/src/lib/scanner.test.ts` (Task 2) ampliado

- [ ] **Step 1: Test** — con `scanCode` simulado devolviendo `'TY-100'`, el input del despacho recibe el código y dispara el mismo camino que teclear + Enter.
- [ ] **Step 2: Implementar** — botón «Escanear» junto al input de despacho (mantiene foco y envío), y botón de cámara en la barra de búsqueda que rellena `q`. Si `scanCode()` es `null`, el botón no se pinta.
- [ ] **Step 3: Verificar y commitear** — commit `feat(mobile): escáner nativo en despacho y búsqueda`.

### Task 7: Push FCM para la app cerrada

**Files:**
- Create: `apps/api/src/infra/fcm.service.ts`, `apps/api/src/infra/fcm.service.test.ts`
- Modify: `apps/api/src/infra/push.service.ts`, `apps/api/src/config/env.ts`, `apps/mobile/capacitor.config.ts`

**Interfaces:**
- Produces: `FcmService.buildMessage(token, payload)` (puro, testeable) y `FcmService.send(token, payload): Promise<'ok' | 'gone' | 'failed'>`; `PushService` reparte por `push_token.platform` (`web` → web-push, `fcm` → FCM).
- Env nuevas: `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` (opcionales; sin las tres, FCM se apaga solo).

- [ ] **Step 1: Test unitario sin red**

```ts
it('el mensaje FCM lleva el enlace y la etiqueta que abrirá la app', () => {
  const msg = buildMessage('tok_1', {
    title: 'Pedido listo',
    body: 'PD-0042',
    url: '/app/despacho',
    tag: 'order-42',
  });
  expect(msg.message.token).toBe('tok_1');
  expect(msg.message.data?.url).toBe('/app/despacho');
  expect(msg.message.android?.collapseKey).toBe('order-42');
});
```

- [ ] **Step 2: Correr y verlo fallar** — `pnpm --filter @partops/api test fcm` → FAIL.
- [ ] **Step 3: Implementar** JWT RS256 con `node:crypto` (sin `firebase-admin`), caché del access token hasta 5 min antes de expirar, y `send` mapeando `404/UNREGISTERED` a `'gone'` (se borra el token, igual que web-push 410).
- [ ] **Step 4: Test de ruteo** — una fila `platform: 'fcm'` sin `p256dh` no se intenta por web-push; con FCM apagado, `notifyWarehouse` no falla y devuelve `sent: 0`.
- [ ] **Step 5: Registrar el token desde el shell** — `native.registerPush()` pide permiso, obtiene token FCM y lo manda a `POST /api/realtime/push/subscribe` con `platform: 'fcm'`; `pushSubscribeSchema` acepta `platform` opcional por defecto `'web'`.
- [ ] **Step 6: Verificar y commitear** — `pnpm --filter @partops/api test`; commit `feat(push): entrega FCM con la app cerrada`.

### Task 8: APK firmado en CI

**Files:**
- Create: `.github/workflows/android.yml`, `apps/mobile/README.md`
- Modify: `apps/mobile/package.json` (`build:apk`)

- [ ] **Step 1: Script** — `build:apk`: `cap sync android && cd android && ./gradlew assembleRelease -PversionName=$npm_package_version`.
- [ ] **Step 2: Workflow** — dispara en tags `v*`: JDK 21, `android-actions/setup-android`, decodifica `ANDROID_KEYSTORE_B64` a `release.keystore` y escribe `keystore.properties` desde secretos (`ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`); `google-services.json` desde `FCM_GOOGLE_SERVICES_B64`; corre `build:apk`; publica el `.apk` con `gh release upload "$TAG"`.
- [ ] **Step 3: Verificación local** — `pnpm --filter @partops/mobile exec cap sync` y `./gradlew assembleDebug` en una máquina con SDK; documentar en `apps/mobile/README.md` el comando exacto y la ruta del APK.
- [ ] **Step 4: Commit** — `ci(android): APK firmado por tag en GitHub Releases`.

---

## Bloque C — T17 · Producción

### Task 9: Límites por ruta y commit en `/health/ready`

**Files:**
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/modules/health.module.ts`, `apps/api/src/modules/health.module.test.ts` (nuevo)
- Modify: `apps/api/src/auth/auth.controller.ts`, `apps/api/src/modules/public-catalog/public-catalog.controller.ts`, `apps/api/src/modules/search/search.controller.ts`, `apps/api/src/modules/dispatch/dispatch.controller.ts`

**Interfaces:**
- Produces: `ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }])` y `GET /api/health/ready` con `commit: string | null`.

- [ ] **Step 1: Test** — `/api/health/ready` incluye `commit` igual a `process.env.RENDER_GIT_COMMIT` cuando existe; sigue devolviendo 503 si RLS no está forzado.
- [ ] **Step 2: Implementar límites explícitos**

```ts
// auth: 10 intentos por minuto por IP
@Throttle({ default: { limit: 10, ttl: 60_000 } })
// catálogo público (pedido y aviso): el rate limit de Postgres ya existe; aquí solo se frena el flood
@Throttle({ default: { limit: 60, ttl: 60_000 } })
// búsqueda: 90 por minuto (la paleta dispara con debounce)
// dispatch sync/scan: 600 por minuto (un teléfono reconectando manda decenas de golpe)
```
`ThrottlerGuard` como segundo `APP_GUARD`, después de `AuthGuard`, con `getTracker` = IP + `x-tenant-id` si existe.
- [ ] **Step 3: Test de 429** — 11 `POST /api/auth/sign-in/email` seguidos desde la misma IP: el último responde 429; 50 `POST /api/dispatch/sync` no responden 429.
- [ ] **Step 4: Commit** — `feat(api): límites por ruta y commit desplegado en /health/ready`.

### Task 10: CSP con nonce en la web

**Files:**
- Create: `apps/web/src/middleware.ts`
- Modify: `apps/web/next.config.mjs`

- [ ] **Step 1: Middleware** — genera `nonce` por request (`crypto.randomUUID()` en base64), añade `content-security-policy` con `default-src 'self'`, `script-src 'self' 'nonce-<n>' 'strict-dynamic'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob: https://*.r2.dev`, `connect-src 'self' wss: https:`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`; excluye `/api/*`, `/_next/*` y archivos estáticos. Pasa el nonce en el header `x-nonce` para que Next lo aplique a sus scripts.
- [ ] **Step 2: Verificación** — `pnpm --filter @partops/web build && pnpm --filter @partops/web start`, luego `curl -sI http://localhost:3000/entrar | Select-String content-security-policy` y comprobar `nonce-`; cargar `/entrar` sin errores de consola.
- [ ] **Step 3: Commit** — `feat(web): CSP con nonce y cabeceras endurecidas`.

### Task 11: Sentry con trazas al 10 %

**Files:**
- Create: `apps/api/src/infra/observability.ts`, `apps/web/instrumentation.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/package.json`, `apps/web/package.json`

- [ ] **Step 1: Implementar** `initObservability()` en la API: si `env.SENTRY_DSN` existe, `Sentry.init({ dsn, environment: env.NODE_ENV, tracesSampleRate: 0.1, sendDefaultPii: false })` antes de crear la app; si no existe, no hace nada (dev y CI siguen sin red).
- [ ] **Step 2: Web** — `instrumentation.ts` con `register()` que carga `@sentry/nextjs` solo si `NEXT_PUBLIC_SENTRY_DSN` está definido; `onRequestError` exportado.
- [ ] **Step 3: Verificación** — `pnpm --filter @partops/api build && pnpm --filter @partops/web build`; arrancar sin DSN y confirmar que no hay avisos ni red.
- [ ] **Step 4: Commit** — `feat(observability): Sentry opcional con trazas al 10%`.

### Task 12: Contenedor, despliegue y humo

**Files:**
- Create: `apps/api/Dockerfile`, `.dockerignore`, `render.yaml`, `.github/workflows/deploy.yml`, `scripts/smoke-api.mjs`
- Modify: `package.json` (`"smoke": "node scripts/smoke-api.mjs"`)

**Interfaces:**
- Consumes: `GET /api/health/ready` con `commit` (Task 9).
- Produces: `pnpm smoke` que verifica dominio, salud, commit desplegado, CSP y página de entrada.

- [ ] **Step 1: Dockerfile** — `node:22-bookworm-slim`, corepack + pnpm 11, `prisma generate`, `pnpm --filter @partops/api build`, imagen final con `dist` + `node_modules` de producción, usuario `node`, `CMD ["node", "apps/api/dist/main.js"]`, `HEALTHCHECK` contra `/api/health/live`.
- [ ] **Step 2: `render.yaml`** — dos servicios del mismo repo e imagen: `partops-api` (`PROCESS_ROLE=api`, `healthCheckPath: /api/health/ready`) y `partops-worker` (`PROCESS_ROLE=worker`, sin puerto público); secretos con `sync: false`.
- [ ] **Step 3: `scripts/smoke-api.mjs`** — con `SMOKE_BASE_URL` y `SMOKE_EXPECTED_COMMIT`: falla si `/api/health/ready` no es 200, si `commit` no coincide, si la portada no responde 200, si falta `content-security-policy`, o si `/app` responde 200 sin sesión (debe redirigir).
- [ ] **Step 4: `deploy.yml`** — en `push` a `main`, en serie: `pnpm --filter @partops/db migrate:deploy` contra `PRODUCTION_DATABASE_URL` → `curl` al deploy hook de Render → poll a `/api/health/ready` hasta ver el SHA del commit (máx. 10 min) → deploy de web → `pnpm smoke`. `concurrency` para no solapar despliegues; `environment: production` con aprobación manual.
- [ ] **Step 5: Verificación local** — `node scripts/smoke-api.mjs` contra la API de desarrollo con `SMOKE_EXPECTED_COMMIT` vacío: debe pasar todo menos la comprobación de commit (que se salta si la variable no está).
- [ ] **Step 6: Commit** — `feat(deploy): contenedor, render.yaml, pipeline serie y smoke`.

### Task 13: Keepalive y cron diario en Cloudflare Worker

**Files:**
- Create: `infra/keepalive/wrangler.toml`, `infra/keepalive/src/index.js`, `infra/keepalive/README.md`

- [ ] **Step 1: Worker** — `scheduled` cada 10 min: `fetch(`${API_URL}/api/health/live`)` con timeout 10 s y reintento único; a las 06:10 de Guatemala dispara además `POST ${API_URL}/api/maintenance/run` con `x-cron-secret` (ruta nueva en la API: `@Public()` + comparación con `env.CRON_SECRET`, que llama `MaintenanceService.tick()` y responde 202). Si `CRON_SECRET` no existe, la ruta responde 404.
- [ ] **Step 2: Test de la ruta** — sin `CRON_SECRET` configurado → 404; con secreto incorrecto → 401; correcto → 202 y `tick()` invocado una vez (espía).
- [ ] **Step 3: Verificación** — `pnpm --filter @partops/api test maintenance`; `npx wrangler dev --config infra/keepalive/wrangler.toml` (documentado; requiere `wrangler login`).
- [ ] **Step 4: Commit** — `feat(infra): keepalive y cron diario en Worker`.

### Task 14: Respaldo nocturno y simulacro de restauración

**Files:**
- Create: `scripts/backup-db.mjs`, `scripts/restore-drill.mjs`, `.github/workflows/backup.yml`
- Modify: `package.json` (`"backup": "node scripts/backup-db.mjs"`, `"restore:drill": "node scripts/restore-drill.mjs"`)

**Interfaces:**
- Consumes: `pg_dump`/`pg_restore` del runner, `@aws-sdk/client-s3` (ya en la API) para R2.
- Produces: dump `partops-YYYY-MM-DD.dump` en `s3://$R2_BUCKET/backups/`, retención 14 días, y un informe JSON del simulacro.

- [ ] **Step 1: `backup-db.mjs`** — `pg_dump --format=custom --no-owner --no-privileges`; falla si el archivo pesa menos de 64 KB o si `pg_restore --list` no lista al menos 20 tablas (la falla silenciosa de un dump vacío); sube a R2 con `PutObjectCommand`; borra objetos con más de 14 días.
- [ ] **Step 2: `restore-drill.mjs`** — exige `SCRATCH_DATABASE_URL` y un dump local; `createdb`/`pg_restore` a la base limpia; verifica conteos de `tenant`, `part`, `sales_order`, `stock_movement` y que `relforcerowsecurity` siga activo en `part`; imprime y escribe `var/restore-drill.json`. Nunca toca `DATABASE_URL`.
- [ ] **Step 3: Workflow** — `schedule: cron '0 8 * * *'` (02:00 Guatemala) + `workflow_dispatch`; corre el respaldo, luego el simulacro contra una base efímera del propio job; publica el informe como artefacto de 30 días.
- [ ] **Step 4: Verificación** — en una máquina con `pg_dump`, `pnpm backup` produce un dump y `pnpm restore:drill` lo restaura con los mismos conteos. Sin `pg_dump`, el script falla con «Instala postgresql-client».
- [ ] **Step 5: Commit** — `feat(backup): respaldo nocturno a R2 con simulacro verificado`.

### Task 15: Runbook, seguridad y cierre

**Files:**
- Create: `SECURITY.md`, `RUNBOOK.md`
- Modify: `README.md` (sección «Producción»), `docs/arquitectura-partops-v1.md` (§7 marcar T14–T17)

- [ ] **Step 1: `SECURITY.md`** — modelo de amenaza corto: RLS y rol sin `BYPASSRLS`, cookies, CSRF, Turnstile, límites, secretos, rotación de llaves VAPID/FCM, cómo reportar una vulnerabilidad.
- [ ] **Step 2: `RUNBOOK.md`** — cinco incidentes con comando y criterio de salida: Neon suspendido, Render dormido o caído, R2 sin dominio, respaldo fallido, fuga entre tenants. Cada uno con «cómo se detecta», «qué se hace», «cómo se confirma que quedó».
- [ ] **Step 3: Puertas de aceptación de Fase 4** — dejar por escrito en `docs/arquitectura-partops-v1.md` el estado de cada puerta: utilidad cuadra con export (hecho, test), APK distribuible (tag publicado), respaldo restaurado con evidencia (`var/restore-drill.json` adjunto al workflow), dos tenants aislados en producción (prueba manual con dos cuentas reales).
- [ ] **Step 4: Verificación final** — `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; sin diagnóstico.
- [ ] **Step 5: Commit** — `docs: runbook, política de seguridad y cierre de Fase 4`.

---

## Fuera de este plan (requiere cuentas o hardware)

- Desplegar de verdad en Render/Neon/R2 y publicar el APK: necesita secretos, dominio y un Android físico. Los artefactos quedan listos; la ejecución se documenta en `RUNBOOK.md`.
- FCM real y push con la app cerrada: necesita `google-services.json` y cuenta de servicio; el código queda probado en unidad.
- iOS: fuera del alcance gratuito (US$99/año).
