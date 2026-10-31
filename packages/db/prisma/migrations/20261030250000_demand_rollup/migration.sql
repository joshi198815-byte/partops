-- ───────────────────────────── Rollup de demanda y avisos de llegada ─────────────────────────────
--
-- T13. Lo que faltaba para que la demanda incumplida sirva para comprar:
--
--  1. `stock_watch` se llena desde la bandeja y hay que saber QUIÉN avisó a quién. Sin eso, dos
--     vendedores mandan el mismo WhatsApp y el cliente recibe el aviso dos veces.
--  2. Búsqueda por pieza: la bandeja agrupa avisos por variante, y sin índice esa consulta recorre
--     la tabla completa cada vez que se abre.
--  3. Un teléfono de aviso que no se puede marcar no es un aviso: la base lo rechaza antes.

ALTER TABLE "stock_watch" ADD COLUMN IF NOT EXISTS "notifiedBy" TEXT;

CREATE INDEX IF NOT EXISTS "stock_watch_tenantId_partId_idx" ON "stock_watch"("tenantId", "partId");
-- El panel ordena por antigüedad de lo pendiente: cubre el filtro y el orden en el mismo índice.
CREATE INDEX IF NOT EXISTS "stock_watch_pending_idx" ON "stock_watch"("tenantId", "createdAt")
  WHERE "notifiedAt" IS NULL;

ALTER TABLE "stock_watch" DROP CONSTRAINT IF EXISTS stock_watch_phone_shape;
ALTER TABLE "stock_watch" ADD CONSTRAINT stock_watch_phone_shape
  CHECK (length(regexp_replace("customerPhone", '\D', '', 'g')) >= 8);

ALTER TABLE "stock_watch" DROP CONSTRAINT IF EXISTS stock_watch_target;
-- Un aviso sin destino no se puede cumplir nunca: o apunta a una variante, o a una pieza, o al
-- menos guarda el texto que la persona pidió.
ALTER TABLE "stock_watch" ADD CONSTRAINT stock_watch_target
  CHECK ("variantId" IS NOT NULL OR "partId" IS NOT NULL OR length(btrim("rawQuery")) >= 2);

-- El rollup agrupa por término dentro de un día; el índice existente (tenantId, day) no cubre el
-- borrado por rango con orden de término que hace `overview`.
CREATE INDEX IF NOT EXISTS "demand_daily_tenant_day_term_idx" ON "demand_daily"("tenantId", "day", "term");
