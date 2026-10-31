-- El rol de runtime existe, pero puede tener BYPASSRLS.
--
-- `20261030160000_rls_and_search` crea `partops_app` con `NOBYPASSRLS`, pero solo si no existe.
-- En Neon el rol puede estar creado de antemano por la consola o por su API, y ahí nace con
-- `BYPASSRLS`: las 34 políticas quedan escritas y no se aplican a nadie. El síntoma es una base que
-- responde y unas pruebas de aislamiento que pasan por el `where tenantId` de la aplicación, no por
-- la RLS. Un `SELECT` con el rol de la API devuelve las filas de todos los negocios.
--
-- Esta migración corrige el atributo si el rol ya existía. Es idempotente y no toca la contraseña:
-- en producción se fija fuera de las migraciones, porque un secreto en el repo no es un secreto.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partops_app') THEN
    ALTER ROLE partops_app NOBYPASSRLS;
  END IF;
END
$$;

-- Comprobación: se falla la migración en vez de dejar la base en un estado que parece correcto.
DO $$
DECLARE
  bypass boolean;
BEGIN
  SELECT rolbypassrls INTO bypass FROM pg_roles WHERE rolname = 'partops_app';
  IF bypass IS TRUE THEN
    RAISE EXCEPTION 'partops_app conserva BYPASSRLS: la RLS no aplica y el aislamiento entre negocios es decorativo';
  END IF;
END
$$;
