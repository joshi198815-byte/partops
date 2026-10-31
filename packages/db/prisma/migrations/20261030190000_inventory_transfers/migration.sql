-- Traslados entre bodegas: folio por negocio y recepción parcial.
--
-- `receivedQty` existe porque un traslado puede llegar incompleto (una caja que se perdió en el
-- camino). Sin la columna, la única salida sería cerrar el traslado entero y registrar la
-- diferencia como ajuste, que es exactamente la forma de perder de vista una pieza.

ALTER TABLE "tenant" ADD COLUMN IF NOT EXISTS "transferSeq" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "stock_transfer_item" ADD COLUMN IF NOT EXISTS "receivedQty" INTEGER NOT NULL DEFAULT 0;

-- Lo que llegó no puede superar lo enviado, ni ser negativo. Se declara en la base porque un
-- `UPDATE` manual por psql tampoco debe poder inventar piezas.
ALTER TABLE "stock_transfer_item" DROP CONSTRAINT IF EXISTS transfer_item_received_range;
ALTER TABLE "stock_transfer_item" ADD CONSTRAINT transfer_item_received_range
  CHECK ("receivedQty" >= 0 AND "receivedQty" <= "quantity");

CREATE INDEX IF NOT EXISTS "stock_transfer_item_tenantId_variantId_idx"
  ON "stock_transfer_item" ("tenantId", "variantId");

-- Buscar el folio que se dicta por teléfono ("el TR-0012") tiene que ser una búsqueda por índice.
CREATE INDEX IF NOT EXISTS "stock_transfer_tenantId_createdAt_idx"
  ON "stock_transfer" ("tenantId", "createdAt" DESC);

-- Los traslados abiertos son la lista de trabajo de la bodega: se consultan en cada carga.
CREATE INDEX IF NOT EXISTS "stock_transfer_tenantId_status_idx"
  ON "stock_transfer" ("tenantId", "status");
