-- Inicialización de la base local de PartOps.
--
-- El punto de todo esto: la API NUNCA conecta como dueño de las tablas. Corre como `partops_app`,
-- un rol sin BYPASSRLS y sin privilegios de dueño, para que las políticas de Row Level Security
-- apliquen aunque alguien olvide un `where tenantId`. Las migraciones sí usan el rol dueño.
--
-- En Neon se hace igual: se crea `partops_app` y se le dan GRANT; la migración `0002_rls` los aplica.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partops_app') THEN
    CREATE ROLE partops_app LOGIN PASSWORD 'partops_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO partops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO partops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO partops_app;
