-- Imágenes de catálogo: respaldo WebP y dimensiones.
--
-- `url` guarda la versión AVIF (la mitad de peso). El WebP de respaldo se guarda aparte porque
-- AVIF no lo abre cualquier WebView Android que todavía circula en bodega, y detectarlo en el
-- cliente con `picture/source` es más simple que re-codificar la imagen al vuelo en cada request.
--
-- `width`/`height` se guardan para que la ficha reserve el espacio antes de descargar la imagen:
-- sin dimensiones, cada foto que llega empuja el texto y la página salta mientras se lee.

ALTER TABLE "part_image" ADD COLUMN IF NOT EXISTS "fallbackUrl" TEXT;
ALTER TABLE "part_image" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "part_image" ADD COLUMN IF NOT EXISTS "height" INTEGER;

-- El listado del catálogo pide la primera imagen de cada pieza; el índice compuesto evita
-- ordenar la tabla completa por cada tarjeta.
CREATE INDEX IF NOT EXISTS "part_image_part_position_idx" ON "part_image" ("partId", "position");
CREATE INDEX IF NOT EXISTS "part_image_tenant_idx" ON "part_image" ("tenantId", "partId");

-- Búsqueda del listado por SKU exacto, que es como llega la mitad de las consultas de mostrador.
CREATE INDEX IF NOT EXISTS "part_variant_tenant_sku_idx" ON "part_variant" ("tenantId", "sku");
