# Identidad de la landing, planes reales y desacople web↔API · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la portada venda lo que el producto hace de verdad, que los planes cobren por límites que la API hace cumplir, y que el navegador hable con la API sin pasar por el servidor de la web.

**Architecture:** Cuatro fases independientes y desplegables por separado. **A** define los planes como dato en `@partops/contracts` y los hace cumplir en la API. **B** reconstruye la portada alrededor de la única capacidad que ninguna plantilla tiene: el parser de jerga de mostrador, ejecutándose de verdad en el navegador. **C** mueve las llamadas del navegador a `api.partops.autos` con cookie de dominio padre. **D** cierra los pendientes operativos (CDN propio y secrets del despliegue).

**Tech Stack:** Next.js 16 (App Router) · NestJS 11 · Prisma 7 sobre Neon · Zod 4 · Tailwind 4 con tokens OKLCH propios · Vitest.

**Spec:** `docs/arquitectura-partops-v1.md` (§4 identidad, §14 planes) y `packages/contracts/src/platform.ts` (tiers existentes).

## Global Constraints

- **Cero datos inventados.** Ni cifras, ni testimonios, ni logos de cliente, ni conteos de piezas de una bodega que no existe (README, regla 5). Toda cifra de la portada sale del código y se cita con su fuente en un comentario.
- **Identidad PartOps:** azul taller `#16324F` como base, cobre `#B4703A` **solo** como filete de 2 px, muesca del logo y serie destacada. Fondos fríos. Prohibido: violeta/magenta, vidrio con blur, glow, degradados de marca, botones píldora, hero de tres tarjetas, interfaz en inglés.
- **Precios en quetzales, IVA incluido**, como el resto del producto. Se escriben con `formatMoney`, nunca a mano.
- **Toda tabla de negocio con `tenantId` y RLS.** Los conteos de plan van dentro de `db.tx(tenantId, …)`.
- **Ningún límite rompe datos existentes.** Un negocio por encima del tope conserva todo; solo se le bloquea _crear más_, con mensaje que dice cuánto tiene y qué plan lo sube.
- **La API es la que decide.** La web solo muestra.
- Español de Guatemala en todo texto visible. Tuteo en la portada, ustedeo en los recibos (como hoy).

## Decisiones que este plan fija

| Tema                               | Decisión                                                                | Por qué                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tiers vendidos                     | `FREE` Q0 · `PRO` Q199 · `TALLER` Q399                                  | Los tres existen ya en `PLAN_TIERS` y en `/admin`. `Q799` queda documentado como plan futuro `CADENA` **cuando exista alta de bodegas**: hoy no hay endpoint que cree una segunda bodega, y vender «más sucursales» sería mentir. |
| Diferencia entre planes            | piezas · usuarios · catálogo público · filas por importación · exportar | Todo verificable en el código de hoy. Finanzas, auditoría y recibos van incluidos en los tres: partirlos exigiría inventar un candado que no existe y empobrecería el producto.                                                   |
| Botón «Ver el catálogo de ejemplo» | **Se elimina**                                                          | Apuntaba a `/catalogo`, que responde 404. Un solo CTA.                                                                                                                                                                            |
| Vitrina demo                       | **No se siembra**                                                       | Un negocio de demostración con piezas inventadas contradice la regla 5. La prueba de producto es el parser real del hero.                                                                                                         |
| Web ↔ API                          | El navegador llama directo a `api.partops.autos`                        | Hoy ya son dos servicios de Render, pero **todo** el tráfico del navegador pasa por el servidor de la web (0.1 CPU) por el rewrite de `/api/*`. Eso es lo que se siente como «el mismo servidor».                                 |

## Review Focus

Estos son los cinco modos de falla que ningún test del plan cubre solo y que más caro salen:
1. **Tenant exactamente en el tope:** crear una variante sobre una pieza existente no debe contar como pieza nueva; si cuenta, una bodega con 2,000 piezas no puede agregar el segundo color de una pieza que ya tiene. Se espera: se permite.
2. **Plan vencido vs plan sin fecha:** `expiresAt = NULL` es «sin vencimiento» (cortesía); una fecha pasada degrada a `FREE` sin borrar nada. Se espera: nunca 500 en `/me`.
3. **El negocio del dueño de PartOps:** queda en `FREE` al activar los límites y se bloquea a sí mismo. Se espera: se le concede `TALLER` con `expiresAt = NULL` **antes** de activar el candado.
4. **Deriva precio↔límite:** alguien cambia la tabla de `/planes` y no `PLANS`. Se espera: la tabla de la web itera `PLANS`; no hay números escritos a mano en JSX.
5. **Phase C y la cookie:** al llamar a otro subdominio, si la cookie no es `Domain=.partops.autos`, el login «funciona» y la siguiente pantalla expulsa al usuario. Se espera: entrar, navegar a `/app`, recargar y seguir dentro.

---

## File Structure

**Fase A — planes**
- Crear `packages/contracts/src/plans.ts` — specs, límites, formateo de «1,420 de 2,000 piezas».
- Crear `packages/contracts/src/plans.test.ts`
- Modificar `packages/contracts/src/index.ts` — exportar `./plans.js`.
- Crear `apps/api/src/modules/plan/plan.service.ts` — resolución del tier vigente y los tres candados.
- Crear `apps/api/src/modules/plan/plan.module.ts`
- Modificar `apps/api/src/app.module.ts` — importar `PlanModule`.
- Modificar `apps/api/src/modules/catalog/catalog.service.ts` — candado en `create`.
- Modificar `apps/api/src/modules/importer/importer.service.ts` — candado de filas y de piezas nuevas.
- Modificar `apps/api/src/modules/team/team.service.ts` — candado en `invite`.
- Modificar `apps/api/src/modules/settings/settings.controller.ts` — candado al publicar catálogo + `GET /settings/plan`.
- Modificar `apps/web/src/app/app/configuracion/settings-screen.tsx` — bloque «Plan».
- Crear `apps/api/src/modules/plan/plan.service.test.ts`

**Fase B — portada y páginas**
- Reescribir `apps/web/src/app/page.tsx`
- Crear `apps/web/src/app/_landing/parse-demo.tsx` (client)
- Crear `apps/web/src/app/_landing/sections.tsx`
- Crear `apps/web/src/app/planes/page.tsx`
- Crear `apps/web/src/app/terminos/page.tsx`
- Crear `apps/web/src/app/privacidad/page.tsx`
- Modificar `packages/ui/src/styles/tokens.css` — dos motivos nuevos (regla de estante, ticket).
- Modificar `apps/web/src/app/(auth)/layout.tsx` — alinear el claim con la portada.

**Fase C — desacople**
- Modificar `apps/api/src/auth/auth.ts` — cookie de dominio padre en producción.
- Modificar `apps/api/src/config/env.ts` — `COOKIE_DOMAIN`.
- Modificar `apps/web/src/lib/api.ts` — base URL y `credentials: 'include'`.
- Modificar `apps/web/src/proxy.ts` — `connect-src` con el origen de la API.
- Modificar `render.yaml`, `.env.example`

**Fase D — operación**
- Crear `scripts/r2-custom-domain.mjs`
- Modificar `RUNBOOK.md`
- (`deploy.yml` no se toca: ya está bien armado; solo le faltan secrets.)

---

## Fase A · Planes que la API hace cumplir

### Task A1: El plan como dato

**Files:**
- Create: `packages/contracts/src/plans.ts`
- Test: `packages/contracts/src/plans.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `PlanTier`, `PLAN_TIERS`, `planActive` de `./platform.js`.
- Produces:
```ts
export interface PlanLimits {
  /** `null` = sin tope. */
  parts: number | null;
  members: number | null;
  importRowsPerFile: number | null;
  publicCatalog: boolean;
  exportData: boolean;
}
export interface PlanSpec {
  tier: PlanTier;
  name: string;
  priceCentsPerMonth: number;
  tagline: string;
  limits: PlanLimits;
  includes: readonly string[];
}
export const PLANS: Record<PlanTier, PlanSpec>;
export function planSpec(tier: string | null | undefined): PlanSpec;
export function usageLabel(used: number, limit: number | null, unit: string): string;
```

- [ ] **Step 1: Escribir el test que falla**

```ts
import { describe, expect, it } from 'vitest';
import { PLANS, planSpec, usageLabel } from './plans.js';

describe('planes', () => {
  it('monta tres precios y el gratis es cero', () => {
    expect(PLANS.FREE.priceCentsPerMonth).toBe(0);
    expect(PLANS.PRO.priceCentsPerMonth).toBe(19_900);
    expect(PLANS.TALLER.priceCentsPerMonth).toBe(39_900);
  });
  it('un tier desconocido o nulo cae en FREE, nunca revienta', () => {
    expect(planSpec(null).tier).toBe('FREE');
    expect(planSpec('CADENA').tier).toBe('FREE');
  });
  it('los planes suben de tope y TALLER no tiene tope de piezas', () => {
    expect(PLANS.FREE.limits.parts).toBe(150);
    expect(PLANS.PRO.limits.parts).toBe(2_000);
    expect(PLANS.TALLER.limits.parts).toBeNull();
    expect(PLANS.FREE.limits.members).toBeLessThan(PLANS.PRO.limits.members);
  });
  it('solo de PRO en adelante se publica el catálogo', () => {
    expect(PLANS.FREE.limits.publicCatalog).toBe(false);
    expect(PLANS.PRO.limits.publicCatalog).toBe(true);
  });
  it('la etiqueta de uso dice el tope o "sin tope"', () => {
    expect(usageLabel(1420, 2000, 'piezas')).toBe('1,420 de 2,000 piezas');
    expect(usageLabel(1420, null, 'piezas')).toBe('1,420 piezas · sin tope');
  });
});
```

- [ ] **Step 2: Correrlo y ver que falla**

Run: `pnpm --filter @partops/contracts test`
Expected: FAIL, `Cannot find module './plans.js'`.
- [ ] **Step 3: Implementar `plans.ts`**

Copiar los valores del test. `includes` en español, describiendo solo lo que existe:
- FREE — «Bodega única», «Hasta 150 piezas», «1 usuario», «Excel hasta 300 filas», «Recibos con NIT».
- PRO — «Hasta 2,000 piezas», «5 usuarios», «Catálogo público con tu dirección», «Excel hasta 5,000 filas», «Exportar ventas y gastos».
- TALLER — «Piezas sin tope», «15 usuarios», «Roles propios», «Catálogo público», «Soporte por WhatsApp el mismo día».

`usageLabel` usa `Intl.NumberFormat('es-GT')` para el separador de miles.
- [ ] **Step 4: Exportar desde el índice y correr**

Modificar `packages/contracts/src/index.ts` añadiendo `export * from './plans.js';` (después de `./permissions.js`, antes de `./platform.js`).
Run: `pnpm --filter @partops/contracts test` → PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/plans.ts packages/contracts/src/plans.test.ts packages/contracts/src/index.ts
git commit -m "feat(plans): planes como dato con precios y topes reales"
```

### Task A2: `PlanService` — el tier vigente y los tres candados

**Files:**
- Create: `apps/api/src/modules/plan/plan.service.ts`
- Create: `apps/api/src/modules/plan/plan.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/modules/plan/plan.service.test.ts`

**Interfaces:**
- Consumes: `DatabaseService`, `TxClient`, `Ctx`, `planSpec`, `PlanSpec`.
- Produces:
```ts
export type PlanFeature = 'publicCatalog' | 'exportData';
@Injectable()
export class PlanService {
  /** Tier vigente del negocio: la concesión más reciente no vencida, o FREE. */
  effective(ctx: Ctx, tx?: TxClient): Promise<PlanSpec>;
  /** Lanza 403 PLAN_LIMIT si crear `incoming` piezas nuevas pasa el tope. `incoming = 0` solo consulta. */
  assertCanAddParts(ctx: Ctx, tx: TxClient, incoming: number): Promise<void>;
  /** Lanza 403 PLAN_LIMIT si invitar una persona más pasa el tope. */
  assertCanAddMember(ctx: Ctx, tx: TxClient): Promise<void>;
  /** Lanza 403 PLAN_LIMIT si el archivo excede las filas del plan. */
  assertImportRows(ctx: Ctx, rows: number): Promise<void>;
  /** Lanza 403 PLAN_LIMIT si el plan no incluye la característica. */
  assertFeature(ctx: Ctx, feature: PlanFeature): Promise<void>;
  /** Conteo para la pantalla de plan. */
  usage(ctx: Ctx): Promise<{ parts: number; members: number }>;
}
```

- [ ] **Step 1: Test que falla** (mismo estilo que `platform.service.test.ts`: `describeIfDb`, tenant sembrado con `db.system`)

```ts
it('un negocio sin concesión es FREE y su tope de piezas es 150', async () => {
  expect((await service.effective(ctx)).tier).toBe('FREE');
});
it('con TALLER concedido el tope de piezas desaparece', async () => {
  await grant(tenantId, 'TALLER', null);
  expect((await service.effective(ctx)).limits.parts).toBeNull();
});
it('una concesión vencida vuelve a FREE sin borrar nada', async () => {
  await grant(tenantId, 'PRO', new Date(Date.now() - 86_400_000));
  expect((await service.effective(ctx)).tier).toBe('FREE');
});
it('crear la pieza 151 falla con PLAN_LIMIT y con el tope en el mensaje', async () => {
  await seedParts(tenantId, 150);
  await expect(db.tx(tenantId, (tx) => service.assertCanAddParts(ctx, tx, 1))).rejects.toMatchObject({
    response: { code: 'PLAN_LIMIT' },
  });
});
it('agregar una variante a una pieza existente no consume tope de piezas', async () => {
  await seedParts(tenantId, 150);
  await expect(db.tx(tenantId, (tx) => service.assertCanAddParts(ctx, tx, 0))).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Correr y ver el fallo de módulo inexistente** — `pnpm --filter @partops/api test plan`

- [ ] **Step 3: Implementar**

`effective`: `tx.planGrant.findFirst({ where: { tenantId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: { createdAt: 'desc' } })` y `planSpec(row?.tier)`.
`assertCanAddParts`: si `limits.parts === null` → return; `count('part')` dentro del mismo tx; si `used + incoming > parts` lanzar
`new ForbiddenException({ code: 'PLAN_LIMIT', message: \`Tu plan ${spec.name} incluye ${parts} piezas y ya tienes ${used}. Sube a ${next.name} para seguir cargando.\` })`.
`assertFeature`: mensaje `\`El catálogo público entra desde el plan PRO.\`` según el caso.
- [ ] **Step 4: Registrar `PlanModule`** en `app.module.ts` (imports) exportando `PlanService`.

- [ ] **Step 5: Correr tests y typecheck** — `pnpm --filter @partops/api test plan && pnpm typecheck`

- [ ] **Step 6: Commit** — `feat(plans): PlanService resuelve el tier vigente y expone los candados`

### Task A3: Conectar los candados donde se crea algo

**Files:**
- Modify: `apps/api/src/modules/catalog/catalog.service.ts:451` (`create`)
- Modify: `apps/api/src/modules/importer/importer.service.ts` (commit)
- Modify: `apps/api/src/modules/team/team.service.ts:138` (`invite`)
- Modify: `apps/api/src/modules/settings/settings.controller.ts` (`PATCH` y nuevo `GET plan`)

**Interfaces:**
- Consumes: `PlanService` (A2).
- Produces: `GET /api/settings/plan` → `{ tier, name, priceCentsPerMonth, limits, usage }` con `@RequirePermissions('settings.manage')`.

- [ ] **Step 1: Tests que fallan** — uno por candado, en el archivo de test de cada servicio:
  - catálogo: `create` en un tenant FREE con 150 piezas → 403 `PLAN_LIMIT`.
  - importador: archivo con 301 filas en FREE → 403 con el número de filas en el mensaje.
  - equipo: sexta invitación en PRO (tope 5) → 403.
  - ajustes: `PATCH { catalogEnabled: true }` en FREE → 403 con código `PLAN_LIMIT`.

- [ ] **Step 2: Verlos fallar** — `pnpm --filter @partops/api test`

- [ ] **Step 3: Implementar**

Cada servicio inyecta `@Inject(PlanService) private readonly plan: PlanService`.
- `CatalogService.create`: dentro del `db.tx` que ya abre, `await this.plan.assertCanAddParts(ctx, tx, 1)` **antes** del insert.
- `ImporterService`: `assertImportRows(ctx, sheet.rows.length)` al validar; en el commit `assertCanAddParts(ctx, tx, summary.newParts)`.
- `TeamService.invite`: `assertCanAddMember` dentro del tx, antes de `invitation.create`.
- `SettingsController.patch`: si `body.catalogEnabled === true` → `assertFeature(ctx, 'publicCatalog')`.

- [ ] **Step 4: Correr todo y typecheck** — `pnpm --filter @partops/api test && pnpm typecheck`

- [ ] **Step 5: Commit** — `feat(plans): piezas, usuarios, filas de importación y catálogo público respetan el plan`

### Task A4: El plan se ve dentro del producto

**Files:**
- Modify: `apps/web/src/app/app/configuracion/settings-screen.tsx`
- Modify: `apps/web/src/app/app/configuracion/page.tsx`

**Interfaces:**
- Consumes: `GET /api/settings/plan` (A3), `usageLabel` (A1).

- [ ] **Step 1: Bloque «Plan» en Configuración**

Arriba de la tarjeta del negocio, un panel con borde y **filete de cobre de 2 px a la izquierda** (motivo de marca, no fondo): nombre del plan a la izquierda, `Q 199/mes · IVA incluido` en mono a la derecha, y dos barras de uso con `usageLabel(parts, limits.parts, 'piezas')` y `usageLabel(members, limits.members, 'usuarios')`. Barra = `<div>` con `width: pct%` y color `var(--accent)` al pasar 80 %. Si `limits.parts === null`: «sin tope» y sin barra. Abajo, enlace de texto «Cambiar de plan» a `/planes` (no botón: no compite con las acciones de la pantalla).
- [ ] **Step 2: Verificar en local con sesión** — entrar, abrir `/app/configuracion`, comprobar que las cifras coinciden con la base (`SELECT count(*) FROM part WHERE "tenantId" = …`).

- [ ] **Step 3: Commit** — `feat(web): el negocio ve su plan y su consumo en Configuración`

---

## Fase B · Portada con identidad y planes públicos

### Task B1: Dos motivos gráficos propios

**Files:**
- Modify: `packages/ui/src/styles/tokens.css`

**Interfaces:**
- Produces: clases `.partops-shelf` (regla de estante: línea horizontal con marcas cada 12 px y etiqueta de pasillo) y `.partops-ticket` (borde superior dentado de 80 mm), más `--rule-estante` y `--ticket-max: 380px`.

- [ ] **Step 1: Implementar con `repeating-linear-gradient` y `mask` de dientes** (sin imágenes, sin blur). `.partops-ticket::before` dibuja el dentado con `conic-gradient` a 45° en dos direcciones, alto 6 px, color `var(--border)`.
- [ ] **Step 2: Verificar contraste** — el texto sobre `--surface` sigue cumpliendo AA; los motivos nunca van detrás de texto.
- [ ] **Step 3: Commit** — `feat(ui): motivos de estante y ticket para la portada`

### Task B0: El vocabulario de referencia, público

**Files:**
- Modify: `apps/api/src/modules/public-catalog/public-catalog.controller.ts`
- Modify: `apps/api/src/modules/public-catalog/public-catalog.service.ts`
- Modify: `packages/contracts/src/vehicles.ts` (o `public-catalog.ts`) — tipo `ReferenceVocabulary`
- Test: `apps/api/src/modules/public-catalog/public-catalog.service.test.ts`

**Interfaces:**
- Consumes: `VehicleVocabulary`, `partCategory`.
- Produces: `GET /api/public/vocabulary` → `{ brands: string[]; models: { name: string; brand: string }[]; categories: string[] }`, `@Public()`, caché `public, s-maxage=3600`. Es la tabla curada global (`vehicle_brand`, `vehicle_model`, `part_category`): no lleva `tenantId`, no expone un solo dato de negocio.

- [ ] **Step 1: Test que falla** — siembra dos marcas y tres modelos con `db.system`, llama `vocabularyPublic()` y espera las tres listas; y que el resultado **no** contenga campos como `tenantId` ni `count`.
- [ ] **Step 2: Implementar** — reutilizar la consulta privada de `vocabulary(tx)` (línea 751), extraerla a un método `referenceVocabulary()` que no recibe tenant y devuelve el objeto tal cual.
- [ ] **Step 3: Verificar con curl** — `curl -s https://api.partops.autos/api/public/vocabulary | jq '.brands | length'` después del despliegue; en local, contra `pnpm dev`.
- [ ] **Step 4: Commit** — `feat(api): vocabulario vehicular de referencia expuesto público para el demo de la portada`

### Task B2: El hero que demuestra el parser real

**Files:**
- Create: `apps/web/src/app/_landing/parse-demo.tsx`
- Create: `apps/web/src/app/_landing/sections.tsx`
- Rewrite: `apps/web/src/app/page.tsx`

**Interfaces:**
- Consumes: `parsePartQuery`, `PART_SYNONYMS`, `normalizeQuery` de `@partops/contracts`; `PartOpsLogo`, `Button`, `CodeChip` de `@partops/ui`.
- Produces: `<ParseDemo />` (client, sin props) y las secciones `<Workflow />`, `<Rules />`, `<PlansTeaser />`, `<ImportStory />`, `<SiteFooter />`.

- [ ] **Step 1: `ParseDemo`** — `'use client'`. Un `input` con `placeholder="cubierta corola 2009"` y, debajo, el resultado de `parsePartQuery(value, vocab)` con el `vocab` que la portada recibe del servidor (`GET /api/public/vocabulary` de B0, cacheado 1 h, con `next: { revalidate: 3600 }`). Si la llamada falla, se usa un vocabulario mínimo local de 6 marcas y 12 modelos y **la sección se marca «sin la tabla de referencia»**: nunca se finge que el parser acertó con un vocabulario inventado. Se pinta como cuatro `CodeChip` (`marca`, `modelo`, `año`, `busca`) y una línea que explica el sinónimo cuando `termFromSynonym`. Estado inicial: `cubierta corola 2009` ya escrito. Sin llamadas de red en el navegador.
  - Encabezado honesto encima: «Así lo interpreta PartOps. Escrito a mano, sin catálogo de por medio.» — el demo enseña el parser, no inventario.
- [ ] **Step 2: `page.tsx`** — estructura: `SiteHeader` (nav: Cómo funciona · Qué no deja pasar · Planes) → `Hero` (titular, subtítulo, `ParseDemo`, **un solo CTA** «Empezar con mi bodega» + «Entrar» como enlace de texto) → `Workflow` (4 pasos con el número real `20 min` de `RESERVATION_TTL_MS`) → `Rules` (5 invariantes: reserva única, ledger append-only, costo congelado, RLS por negocio, recibo inmutable) → `PlansTeaser` (tres columnas **sin** tarjetas de vidrio: ticket con filete de cobre, precio en Archivo 800 y `formatMoney`) → `ImportStory` («5,000 filas, vista previa por fila, nada se guarda hasta confirmar») → `SiteFooter`.
  - **Borrar** `StatTile` con `4,812` y `18,940` y el enlace `/catalogo`.
  - `SiteFooter` enlaza `/planes`, `/terminos`, `/privacidad`, `mailto:partopsgt@gmail.com`.
- [ ] **Step 3: Typecheck y build** — `pnpm --filter @partops/web typecheck && pnpm --filter @partops/web build`
- [ ] **Step 4: Verificación visual** — abrir en el navegador a 1440 px y 390 px; escribir «faro corola 2009», «balatas sentra», «capo toyota», «amortiguador delantero hilux 2015» y comprobar que marca/modelo/año se separan bien. Captura a `var/plan-landing-*.png`.
- [ ] **Step 5: Commit** — `feat(web): portada con el parser de mostrador como prueba de producto`

### Task B3: `/planes` y las páginas legales

**Files:**
- Create: `apps/web/src/app/planes/page.tsx`
- Create: `apps/web/src/app/terminos/page.tsx`
- Create: `apps/web/src/app/privacidad/page.tsx`

**Interfaces:**
- Consumes: `PLANS`, `formatMoney`.

- [ ] **Step 1: `/planes`** — tres tickets, cada uno iterando `PLANS[tier]`: precio `formatMoney(spec.priceCentsPerMonth, 'GTQ')` + «/mes · IVA incluido», `includes` en lista, y la fila de límite con `usageLabel`. Tabla comparativa debajo con las filas: piezas, usuarios, filas de Excel, catálogo público, exportar. CTA por ticket: «Crear cuenta» (FREE) y «Empezar y elegir al hablar con alguien» (PRO/TALLER → `mailto:`), porque **no hay pasarela de pago**: no se puede cobrar en línea y prometerlo sería falso. Nota al pie explícita: «Cobramos por transferencia o tarjeta con factura; el plan se activa el mismo día.»
- [ ] **Step 2: `/terminos` y `/privacidad`** — prosa corta y real: quién opera (PartOps, Guatemala), `partopsgt@gmail.com`, datos que se guardan (negocio, piezas, ventas, usuarios, correo), dónde (Neon `us-east-2`, Cloudflare R2), qué no se hace (no se venden datos, no hay publicidad), cómo se borra la cuenta (`/api/account/delete`), retención (movimientos inmutables, búsquedas 30 días). Fecha de última actualización visible.
- [ ] **Step 3: Verificar 200 en las tres** — `curl` en local; y que `pnpm build` las prerenderice.
- [ ] **Step 4: Commit** — `feat(web): página de planes con precios reales y páginas legales`

### Task B4: Alinear el resto de la marca

**Files:**
- Modify: `apps/web/src/app/(auth)/layout.tsx`

- [ ] **Step 1:** Reemplazar el claim lateral por el de la portada y añadir «20 min» donde hoy no hay cifra. Cambiar `partops.autos` por la dirección real del catálogo cuando aplique.
- [ ] **Step 2: Commit** — `chore(web): el login dice lo mismo que la portada`

---

## Fase C · El navegador habla con la API, no con Next

**Riesgo alto de autenticación. No empezar hasta que A y B estén en producción y verdes.**

### Task C1: Cookie de dominio padre y cliente con base URL

**Files:**
- Modify: `apps/api/src/config/env.ts` — `COOKIE_DOMAIN: z.string().optional()`
- Modify: `apps/api/src/auth/auth.ts` — `advanced.crossSubDomainCookies`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/proxy.ts` — `connect-src` con `process.env.NEXT_PUBLIC_API_URL`
- Modify: `apps/web/src/lib/auth.ts` (usa `api`, sin cambios si C1 está bien)
- Modify: `render.yaml` — `NEXT_PUBLIC_API_URL` en la web; `COOKIE_DOMAIN=.partops.autos` en la API
- Modify: `.env.example`

**Interfaces:**
- Produces: `const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';` en `lib/api.ts`; todas las llamadas del navegador van a `${API_BASE}${path}` con `credentials: 'include'`.

- [ ] **Step 1: Implementar** — `advanced: { cookiePrefix: 'partops', useSecureCookies: isProduction, crossSubDomainCookies: { enabled: isProduction && Boolean(env.COOKIE_DOMAIN), domain: env.COOKIE_DOMAIN ?? '' } }`. En `lib/api.ts`, `credentials: 'include'` y prefijo `API_BASE`; con la variable vacía en local, el comportamiento de hoy no cambia (rewrite).
- [ ] **Step 2: Verificar el flujo completo en producción** — login, `/app`, recarga, cambio de negocio, subida de imagen, logout. Revisar en DevTools que la cookie dice `Domain=.partops.autos` y que las peticiones van a `api.partops.autos`.
- [ ] **Step 3: Verificar que el rewrite quedó intacto como respaldo** — con `NEXT_PUBLIC_API_URL` vacío la app sigue funcionando.
- [ ] **Step 4: Commit** — `feat(api): el navegador llama a la API directamente con cookie de dominio padre`

### Task C2: Quitar la CPU de la web del camino caliente

- [ ] **Step 1:** Confirmar con Render → Metrics que la web baja de CPU tras C1 (anotar antes/después en `RUNBOOK.md`).
- [ ] **Step 2:** `RUNBOOK.md`: sección «Si el login deja de funcionar» con los tres síntomas (cookie sin dominio, `Connect-Src` bloqueando la API, `COOKIE_DOMAIN` sin punto inicial).

---

## Fase D · Los pendientes operativos

### Task D1: `cdn.partops.autos` para las fotos

**Files:**
- Create: `scripts/r2-custom-domain.mjs`
- Modify: `RUNBOOK.md:88`

- [x] **Step 1:** Script idempotente que, con `CF_API_TOKEN` del entorno (nunca del repo), hace: `PUT /accounts/{account}/r2/buckets/partops/domains/cdn.partops.autos` con `{ zoneId }`, y verifica con `GET` que `enabled: true`.
- [ ] **Step 2:** Cambiar `R2_PUBLIC_URL=https://cdn.partops.autos` en el servicio de la API (Render) y en `lib/` de la web si aplica; `img-src` del CSP ya permite `https:`, pero añadir `https://cdn.partops.autos` explícito. — _Código listo_ (`next.config` remotePattern, CSP, `keyFromUrl` reconoce el dominio viejo). **Falta la credencial**: `CF_API_TOKEN`, `CF_ACCOUNT_ID` y `CF_ZONE_ID` no están en la máquina.
- [ ] **Step 3:** Verificar: subir una foto real desde `/app/catalogo`, comprobar `curl -sI https://cdn.partops.autos/parts/<id>.webp` → 200 con `cache-control`, y que la ficha la pinta.
- [ ] **Step 4:** Dejar `pub-*.r2.dev` activo una semana como respaldo de las URLs ya guardadas; anotar en `RUNBOOK.md` cuándo apagarlo. — _Runbook § 3b escrito, con el SQL de migración de las URLs viejas._

### Task D2: Secrets del despliegue

- [ ] **Step 1:** Crear los deploy hooks de `partops-api` y `partops-web` (Render → Settings → Deploy Hook) y guardarlos como `RENDER_API_DEPLOY_HOOK` / `RENDER_WEB_DEPLOY_HOOK`.
- [ ] **Step 2:** `gh secret set` para los cinco del entorno `production`: `PRODUCTION_DIRECT_DATABASE_URL` (rol dueño), `RENDER_API_DEPLOY_HOOK`, `RENDER_WEB_DEPLOY_HOOK`, `PRODUCTION_API_URL`, `PRODUCTION_WEB_URL`. — _Comandos exactos en `RUNBOOK.md` § 8. `gh secret list` hoy devuelve vacío._
- [ ] **Step 3:** Probar con `gh workflow run deploy.yml -f skip_migrations=true` y seguir el run hasta el humo verde.
- [x] **Step 4:** Apagar el despliegue por API y anotar en `var/deployment-secrets.txt` que el camino oficial es el workflow. — _Además, `deploy.yml` ahora tiene un job `preflight` que falla en segundos, **antes de migrar**, si falta cualquiera de los cinco._

### Task D3: Correo

- [ ] **Step 1:** Con un token nuevo de Resend y el dominio verificado, `MAIL_PROVIDER=resend` + `RESEND_API_KEY` en la API; verificar invitación y recuperación de punta a punta con un correo real. — _Bloqueado: el token está revocado (401)._
- [x] **Step 2:** Si no hay token, dejar `log` y anotar en `RUNBOOK.md` que **hoy no se envían** invitaciones ni recuperación: el dueño tiene que copiar el enlace del log o entregar la contraseña temporal en mano. — _Runbook § 7. Además: `MailService` grita al arrancar si el proveedor no puede enviar, la pantalla de Equipo distingue "enviada" de "creada pero no enviada" y entrega el enlace, y Gmail SMTP quedó implementado (antes lanzaba siempre) por si se consigue una contraseña de aplicación antes que el dominio._

---

## Verificación final

- [ ] `pnpm typecheck && pnpm test && pnpm build`
- [ ] `pnpm smoke` contra producción después del despliegue
- [ ] Manual: portada a 390 px, `/planes`, `/terminos`, `/privacidad`, login, `/app/configuracion` con el bloque de plan, y un intento de crear piezas hasta el tope en un tenant de prueba.
