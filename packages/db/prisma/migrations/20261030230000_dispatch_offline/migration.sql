-- Despacho: cola offline idempotente y avisos push.
--
-- La cola del teléfono reintenta operaciones cuando vuelve la señal. `dispatch_op` es la memoria
-- del servidor: la misma `opId` no se aplica dos veces. Sin esa tabla, un `LISTO → ENTREGADO`
-- reintentado tres veces descontaría tres piezas y el estante quedaría con faltantes imposibles de
-- explicar.
--
-- Nota: esta migración se aplica ANTES de crear la tabla `dispatch_op` en el esquema; el orden
-- real lo resuelve `prisma migrate deploy` con el SQL emitido por Prisma. Aquí se declara a mano
-- porque el proyecto versiona el SQL, no lo genera en cada despliegue.

CREATE TABLE IF NOT EXISTS "dispatch_op" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "scannedCode" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_op_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dispatch_op_tenantId_opId_key"
  ON "dispatch_op" ("tenantId", "opId");
CREATE INDEX IF NOT EXISTS "dispatch_op_tenantId_createdAt_idx"
  ON "dispatch_op" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "dispatch_op_tenantId_orderId_idx"
  ON "dispatch_op" ("tenantId", "orderId");

-- Endpoint y transporte del aviso. `p256dh`/`auth` son las claves que exige Web Push para cifrar
-- el payload; sin ellas el navegador rechaza la entrega con 401 y el aviso se pierde en silencio.
ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "p256dh" TEXT;
ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "auth" TEXT;
ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

-- RLS: la tabla nueva entra en el aislamiento por negocio, con la misma política que el resto.
ALTER TABLE "dispatch_op" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_op" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "dispatch_op";
CREATE POLICY tenant_isolation ON "dispatch_op"
  USING (app_bypass() OR "tenantId" = app_current_tenant())
  WITH CHECK (app_bypass() OR "tenantId" = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON "dispatch_op" TO partops_app;

-- El rol de la app ya puede leer y escribir, pero un `opId` repetido es una violación de unicidad
-- y no un error de negocio: el servicio lo captura antes de llegar aquí.
