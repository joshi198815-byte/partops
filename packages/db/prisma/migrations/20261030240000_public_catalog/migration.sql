-- Catálogo público: contador de intentos por IP/token y búsquedas del visitante.
--
-- El catálogo es la única ruta sin sesión que escribe en la base: cualquiera en internet puede
-- mandar un pedido. Sin un registro del lado del servidor, el rate limit viviría solo en memoria y
-- se reiniciaría con cada despliegue (o se multiplicaría por cada instancia de Render), que es
-- justo cuando el abuso importa.
--
-- `public_hit` no guarda la IP en claro: se guarda un hash con el secreto del servidor. Sirve para
-- contar y para bloquear, y no se puede revertir a la dirección de una persona si la base se filtra.

CREATE TABLE IF NOT EXISTS "public_hit" (
    "id" TEXT NOT NULL,
    -- hash(ip) o hash(turnstile token); nunca la IP.
    "key" TEXT NOT NULL,
    -- `PEDIDO`, `CONSULTA`, `BUSQUEDA`: cada superficie tiene su propio presupuesto.
    "scope" TEXT NOT NULL,
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_hit_pkey" PRIMARY KEY ("id")
);

-- El conteo es siempre "cuántos en los últimos N minutos para esta key y scope": ese es el índice.
CREATE INDEX IF NOT EXISTS "public_hit_key_scope_created_idx"
  ON "public_hit" ("key", "scope", "createdAt");

-- Purga por antigüedad; sin este índice el job de limpieza hace un seq scan cada hora.
CREATE INDEX IF NOT EXISTS "public_hit_created_idx" ON "public_hit" ("createdAt");

-- La tabla es del sistema, no de un negocio: la escribe la ruta pública antes de saber quién es el
-- cliente. No lleva RLS porque no contiene datos de ningún negocio (solo un hash y un contador), y
-- una política la dejaría inservible desde la transacción pública.
GRANT SELECT, INSERT, DELETE ON "public_hit" TO partops_app;

-- El pedido del catálogo guarda de dónde vino: sin esto, al reclamar "el cliente dijo que lo pidió
-- por la página" no hay forma de distinguirlo de una venta de mostrador capturada a mano.
ALTER TABLE "sales_order" ADD COLUMN IF NOT EXISTS "sourceSlug" TEXT;

-- Un pedido del catálogo puede nacer sin vendedor del negocio. `sellerId` es NOT NULL en el modelo
-- porque toda venta de mostrador tiene quién la hizo; el pedido de invitado no. Se relaja y se
-- documenta: el `actorId` del evento queda con el usuario de sistema del catálogo.
ALTER TABLE "sales_order" ALTER COLUMN "sellerId" DROP NOT NULL;

-- Índice para la vitrina: piezas activas de un negocio, que es el 100% de las consultas públicas.
CREATE INDEX IF NOT EXISTS "part_tenant_status_name_idx" ON "part" ("tenantId", "status", "name");
