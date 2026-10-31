-- Importación de catálogo: modo de resolución y filas omitidas.
--
-- `mode` se guarda con el job y no solo se recibe en la petición: dentro de seis meses, cuando
-- alguien pregunte por qué el precio de una pieza cambió, la bitácora tiene que poder decir si fue
-- una importación que sobrescribía o una que solo creaba.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImportMode') THEN
    CREATE TYPE "ImportMode" AS ENUM ('CREAR', 'ACTUALIZAR', 'OMITIR_EXISTENTES');
  END IF;
END
$$;

ALTER TABLE "import_job" ADD COLUMN IF NOT EXISTS "mode" "ImportMode" NOT NULL DEFAULT 'CREAR';
ALTER TABLE "import_job" ADD COLUMN IF NOT EXISTS "skippedRows" INTEGER NOT NULL DEFAULT 0;

-- La pantalla de importación lista los últimos archivos del negocio en cada visita.
CREATE INDEX IF NOT EXISTS "import_job_tenantId_status_idx" ON "import_job" ("tenantId", "status");

-- El reporte de errores se abre por fila para corregir el Excel. El índice (jobId, rowNumber) ya
-- existe; este cubre el listado por negocio del panel de plataforma.
CREATE INDEX IF NOT EXISTS "import_row_error_tenantId_rowNumber_idx"
  ON "import_row_error" ("tenantId", "rowNumber");
