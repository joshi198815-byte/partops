-- `plan_grant` quedó fuera de la lista de la migración de RLS: tiene `tenantId`, pero sin política.
-- Es la tabla que dice qué plan tiene cada negocio; un `SELECT` sin contexto la leería entera y
-- revelaría qué negocios tienen qué plan. La regla del proyecto no admite excepciones: toda tabla
-- de negocio con `tenantId` lleva RLS forzado.
--
-- `public_hit` sigue sin RLS a propósito (ver 20261030240000_public_catalog): no guarda datos de
-- ningún negocio, solo un hash y un contador que la ruta pública escribe antes de saber quién es.
ALTER TABLE "plan_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_grant" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "plan_grant";
CREATE POLICY tenant_isolation ON "plan_grant"
  USING (app_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass() OR "tenantId" = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "plan_grant" TO partops_app;
