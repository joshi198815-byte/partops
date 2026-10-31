-- ───────────────────────────── Finanzas: gastos fijos y agregado diario ─────────────────────────────
--
-- T14. Lo que faltaba para que la utilidad sea un número que se pueda creer:
--
--  1. **Gasto fijo mensual.** Alquiler, planilla e internet no se capturan solos y el mes que se
--     olvidan descuadran la utilidad sin que nadie lo note. Se guarda la plantilla y el
--     mantenimiento crea el gasto del mes una sola vez (`lastRunMonth`).
--  2. **Índice por fecha de entrega.** La venta se reconoce cuando la pieza sale (`deliveredAt`),
--     no cuando se captura el pedido; sin este índice cada reporte recorre la tabla completa.
--  3. **Categoría de gasto con nombre único por negocio.** Ya existe la restricción; el índice por
--     `tenantId` ordenado por nombre cubre el selector sin ordenar en memoria.
--  4. **El agregado diario gana la columna que faltaba.** `netProfitCents` no se guarda: se deriva
--     de ventas − COGS − gastos, y guardarlo invitaría a que quede desincronizado.

CREATE TABLE IF NOT EXISTS "recurring_expense" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT NOT NULL,
    "categoryId"   TEXT,
    "title"        TEXT NOT NULL,
    "amountCents"  INTEGER NOT NULL,
    "dayOfMonth"   INTEGER NOT NULL DEFAULT 1,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "lastRunMonth" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_expense_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "recurring_expense" DROP CONSTRAINT IF EXISTS recurring_expense_tenantId_fkey;
ALTER TABLE "recurring_expense" ADD CONSTRAINT "recurring_expense_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recurring_expense" DROP CONSTRAINT IF EXISTS recurring_expense_categoryId_fkey;
ALTER TABLE "recurring_expense" ADD CONSTRAINT "recurring_expense_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "expense_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "recurring_expense_tenantId_active_idx"
  ON "recurring_expense" ("tenantId", "active");

-- Un gasto fijo sin monto no genera nada y uno con día 31 no existe en febrero. La base lo rechaza
-- antes de que el job tenga que adivinar qué hacer con una plantilla imposible.
ALTER TABLE "recurring_expense" DROP CONSTRAINT IF EXISTS recurring_expense_amount_positive;
ALTER TABLE "recurring_expense" ADD CONSTRAINT recurring_expense_amount_positive
  CHECK ("amountCents" > 0);

ALTER TABLE "recurring_expense" DROP CONSTRAINT IF EXISTS recurring_expense_day_range;
ALTER TABLE "recurring_expense" ADD CONSTRAINT recurring_expense_day_range
  CHECK ("dayOfMonth" BETWEEN 1 AND 28);

ALTER TABLE "recurring_expense" DROP CONSTRAINT IF EXISTS recurring_expense_last_run_shape;
ALTER TABLE "recurring_expense" ADD CONSTRAINT recurring_expense_last_run_shape
  CHECK ("lastRunMonth" IS NULL OR "lastRunMonth" ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- RLS con la misma política que el resto de tablas del negocio.
ALTER TABLE "recurring_expense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_expense" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "recurring_expense";
CREATE POLICY tenant_isolation ON "recurring_expense"
  USING (app_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass() OR "tenantId" = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "recurring_expense" TO partops_app;

-- ───────────────────────────── Consultas del reporte ─────────────────────────────

-- La venta se reconoce por `deliveredAt` de la línea: este índice es el que evita recorrer
-- `sales_order_item` completo en cada apertura del panel y en cada exportación.
CREATE INDEX IF NOT EXISTS "sales_order_item_tenantId_delivered_idx"
  ON "sales_order_item" ("tenantId", "deliveredAt")
  WHERE "deliveredAt" IS NOT NULL;

-- Gasto por negocio y rango de fecha: el panel suma el mes y el detalle viene en la misma consulta.
CREATE INDEX IF NOT EXISTS "expense_tenantId_paidAt_desc_idx"
  ON "expense" ("tenantId", "paidAt" DESC);

-- Forma de pago del periodo: el cobro se agrupa por método y el join con el pedido necesita esto.
CREATE INDEX IF NOT EXISTS "payment_tenantId_created_idx"
  ON "payment" ("tenantId", "createdAt");

-- Un gasto negativo es un ingreso disfrazado y rompe la resta de utilidad. Cero no es un gasto.
ALTER TABLE "expense" DROP CONSTRAINT IF EXISTS expense_amount_positive;
ALTER TABLE "expense" ADD CONSTRAINT expense_amount_positive CHECK ("amountCents" > 0);

-- ───────────────────────────── Categorías por defecto ─────────────────────────────
--
-- Se crean para cada negocio existente, una sola vez. Las de negocios nuevos las crea el servicio
-- la primera vez que se abre Finanzas: una migración con trigger por cada alta de negocio es más
-- frágil que un `ON CONFLICT DO NOTHING` cuando de verdad se necesitan.
INSERT INTO "expense_category" ("id", "tenantId", "name", "isSystem")
SELECT gen_random_uuid()::text, t."id", c."name", true
FROM "tenant" t
CROSS JOIN (VALUES ('Alquiler'), ('Planilla'), ('Fletes'), ('Servicios'), ('Importaciones'), ('Impuestos'), ('Otros')) AS c("name")
WHERE NOT EXISTS (
  SELECT 1 FROM "expense_category" e WHERE e."tenantId" = t."id" AND e."name" = c."name"
);
