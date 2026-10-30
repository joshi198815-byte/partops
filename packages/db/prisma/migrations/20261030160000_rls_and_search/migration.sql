-- Row Level Security, búsqueda e invariantes.
--
-- Todo lo que aquí se escribe es defensa en profundidad: si un `where tenantId` desaparece de una
-- consulta, la base sigue devolviendo cero filas ajenas. Eso es lo que separa un SaaS multitenant
-- de una base con una columna decorativa.

-- ───────────────────────────── 1. Rol de runtime ─────────────────────────────
-- Sin privilegios de dueño y sin BYPASSRLS: las políticas aplican siempre.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partops_app') THEN
    CREATE ROLE partops_app LOGIN PASSWORD 'partops_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO partops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO partops_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO partops_app;

-- ───────────────────────────── 2. Contexto de sesión ─────────────────────────────
-- `app.tenant_id`: negocio activo de la transacción (lo fija la API por request).
-- `app.bypass_rls`: solo para trabajos del sistema (provisionamiento, cron global).
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app_bypass() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true) = 'on', false)
$$;

-- ───────────────────────────── 3. RLS en toda tabla de negocio ─────────────────────────────
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'tenant', 'member', 'role', 'invitation', 'audit_log', 'notification', 'push_token',
    'warehouse', 'inventory_level', 'stock_movement', 'stock_transfer', 'stock_transfer_item',
    'part_category', 'part', 'part_variant', 'part_image', 'part_compatibility',
    'import_job', 'import_row_error',
    'customer', 'sales_order', 'sales_order_item', 'order_event', 'payment', 'receipt',
    'expense_category', 'expense', 'daily_metric',
    'search_event', 'demand_daily', 'stock_watch'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE: aplica también al dueño de la tabla. Sin esto, la app conectada como `postgres`
    -- se saltaría todo el aislamiento y nadie lo notaría hasta producción.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  END LOOP;
END
$$;

-- La tabla `tenant` no tiene columna tenantId: su fila es el negocio. Se filtra por id.
DROP POLICY IF EXISTS tenant_isolation ON "tenant";
CREATE POLICY tenant_isolation ON "tenant"
  USING (app_bypass() OR "id" = app_current_tenant())
  WITH CHECK (app_bypass() OR "id" = app_current_tenant());

-- El resto: comparación directa contra el contexto.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'member', 'role', 'invitation', 'audit_log', 'notification', 'push_token',
    'warehouse', 'inventory_level', 'stock_movement', 'stock_transfer', 'stock_transfer_item',
    'part_category', 'part', 'part_variant', 'part_image', 'part_compatibility',
    'import_job', 'import_row_error',
    'customer', 'sales_order', 'sales_order_item', 'order_event', 'payment', 'receipt',
    'expense_category', 'expense', 'daily_metric',
    'search_event', 'demand_daily', 'stock_watch'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (app_bypass() OR "tenantId" = app_current_tenant())
         WITH CHECK (app_bypass() OR "tenantId" = app_current_tenant())',
      t
    );
  END LOOP;
END
$$;

-- ───────────────────────────── 4. Invariantes de inventario ─────────────────────────────
-- Se declaran aquí y no solo en el servicio: un ajuste manual por psql tampoco debe poder
-- dejar existencias negativas ni reservas por encima de lo que hay físicamente.
ALTER TABLE "inventory_level" DROP CONSTRAINT IF EXISTS inventory_non_negative;
ALTER TABLE "inventory_level" ADD CONSTRAINT inventory_non_negative
  CHECK ("onHand" >= 0 AND "reserved" >= 0 AND "reserved" <= "onHand");

ALTER TABLE "inventory_level" DROP CONSTRAINT IF EXISTS inventory_reorder_positive;
ALTER TABLE "inventory_level" ADD CONSTRAINT inventory_reorder_positive
  CHECK ("reorderPoint" IS NULL OR "reorderPoint" >= 0);

ALTER TABLE "stock_movement" DROP CONSTRAINT IF EXISTS movement_delta_not_zero;
ALTER TABLE "stock_movement" ADD CONSTRAINT movement_delta_not_zero CHECK ("delta" <> 0);

ALTER TABLE "stock_movement" DROP CONSTRAINT IF EXISTS movement_balance_non_negative;
ALTER TABLE "stock_movement" ADD CONSTRAINT movement_balance_non_negative CHECK ("balanceAfter" >= 0);

-- El ledger es append-only. Sin esto, "corregir" un movimiento viejo es un UPDATE silencioso y
-- el inventario deja de poder auditarse.
CREATE OR REPLACE FUNCTION stock_movement_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El ledger de inventario es inmutable: registra un movimiento de ajuste en vez de modificar uno existente';
END
$$;

DROP TRIGGER IF EXISTS stock_movement_no_update ON "stock_movement";
CREATE TRIGGER stock_movement_no_update
  BEFORE UPDATE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_immutable();

DROP TRIGGER IF EXISTS stock_movement_no_delete ON "stock_movement";
CREATE TRIGGER stock_movement_no_delete
  BEFORE DELETE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_immutable();

-- ───────────────────────────── 5. Invariantes de venta y vehículo ─────────────────────────────
ALTER TABLE "sales_order_item" DROP CONSTRAINT IF EXISTS item_quantity_positive;
ALTER TABLE "sales_order_item" ADD CONSTRAINT item_quantity_positive CHECK ("quantity" > 0);

ALTER TABLE "sales_order_item" DROP CONSTRAINT IF EXISTS item_price_non_negative;
ALTER TABLE "sales_order_item" ADD CONSTRAINT item_price_non_negative
  CHECK ("unitPriceCents" >= 0 AND "unitCostCents" >= 0 AND "discountCents" >= 0);

ALTER TABLE "sales_order" DROP CONSTRAINT IF EXISTS order_total_non_negative;
ALTER TABLE "sales_order" ADD CONSTRAINT order_total_non_negative CHECK ("totalCents" >= 0);

ALTER TABLE "vehicle" DROP CONSTRAINT IF EXISTS vehicle_year_range;
ALTER TABLE "vehicle" ADD CONSTRAINT vehicle_year_range
  CHECK ("yearStart" <= "yearEnd" AND "yearStart" >= 1950 AND "yearEnd" <= 2100);

ALTER TABLE "part_variant" DROP CONSTRAINT IF EXISTS variant_price_non_negative;
ALTER TABLE "part_variant" ADD CONSTRAINT variant_price_non_negative
  CHECK ("priceCents" >= 0 AND "costCents" >= 0);

ALTER TABLE "part" DROP CONSTRAINT IF EXISTS part_warranty_non_negative;
ALTER TABLE "part" ADD CONSTRAINT part_warranty_non_negative
  CHECK ("warrantyDays" IS NULL OR "warrantyDays" >= 0);

ALTER TABLE "expense" DROP CONSTRAINT IF EXISTS expense_amount_positive;
ALTER TABLE "expense" ADD CONSTRAINT expense_amount_positive CHECK ("amountCents" > 0);

-- ───────────────────────────── 6. Búsqueda ─────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

/**
 * `unaccent()` no está marcada IMMUTABLE (su diccionario puede cambiar), así que no se puede usar
 * en un índice de expresión. Este envoltorio fija el diccionario y declara la inmutabilidad, que es
 * lo que permite indexar el texto normalizado. Es el patrón estándar para esto en Postgres.
 */
CREATE OR REPLACE FUNCTION part_immutable_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1)
$$;

-- `searchText` se regenera en la base: nombre + marca + categoría + códigos + aplicaciones.
-- Mantenerlo aquí y no en el servicio significa que una importación masiva también lo llena.
CREATE OR REPLACE FUNCTION part_search_text(pid text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(x, ' '), '')
  FROM (
    SELECT p."name" AS x FROM "part" p WHERE p."id" = pid
    UNION ALL SELECT p."brand" FROM "part" p WHERE p."id" = pid
    UNION ALL SELECT c."name" FROM "part" p JOIN "part_category" c ON c."id" = p."categoryId"
      WHERE p."id" = pid
    UNION ALL SELECT v."sku" FROM "part_variant" v WHERE v."partId" = pid
    UNION ALL SELECT v."partNumber" FROM "part_variant" v WHERE v."partId" = pid
    UNION ALL SELECT unnest(v."oemNumbers") FROM "part_variant" v WHERE v."partId" = pid
    UNION ALL
      SELECT b."name" || ' ' || m."name" || ' ' || veh."yearStart" || ' ' || veh."yearEnd"
      FROM "part_compatibility" pc
      JOIN "vehicle" veh ON veh."id" = pc."vehicleId"
      JOIN "vehicle_model" m ON m."id" = veh."modelId"
      JOIN "vehicle_brand" b ON b."id" = m."brandId"
      WHERE pc."partId" = pid
  ) s
  WHERE x IS NOT NULL AND x <> ''
$$;

CREATE OR REPLACE FUNCTION part_refresh_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "part" SET "searchText" = part_search_text("part"."id") WHERE "part"."id" = COALESCE(NEW."partId", NEW."id");
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS part_search_text_variant ON "part_variant";
CREATE TRIGGER part_search_text_variant
  AFTER INSERT OR UPDATE OR DELETE ON "part_variant"
  FOR EACH ROW EXECUTE FUNCTION part_refresh_search_text();

DROP TRIGGER IF EXISTS part_search_text_compat ON "part_compatibility";
CREATE TRIGGER part_search_text_compat
  AFTER INSERT OR UPDATE OR DELETE ON "part_compatibility"
  FOR EACH ROW EXECUTE FUNCTION part_refresh_search_text();

-- Índices de búsqueda. Trigram para erratas ("corola" → "corolla") y GIN para OEM exacto,
-- que es como busca la mayoría de bodegas cuando tienen el número de parte a mano.
CREATE INDEX IF NOT EXISTS part_name_trgm ON "part" USING gin (lower("name") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS part_search_trgm ON "part" USING gin (lower("searchText") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS part_search_tsv ON "part"
  USING gin (to_tsvector('spanish', part_immutable_unaccent(coalesce("searchText", ''))));
CREATE INDEX IF NOT EXISTS variant_sku_trgm ON "part_variant" USING gin (lower("sku") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS variant_oem_gin ON "part_variant" USING gin ("oemNumbers");
CREATE INDEX IF NOT EXISTS variant_part_number_trgm ON "part_variant"
  USING gin (lower(coalesce("partNumber", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customer_phone_trgm ON "customer" USING gin ("phone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customer_name_trgm ON "customer" USING gin (lower("name") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search_event_term_idx ON "search_event" ("tenantId", "normalized");

-- ───────────────────────────── 7. Permisos del rol de runtime ─────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO partops_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO partops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO partops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO partops_app;
