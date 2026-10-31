-- Ticket de 80 mm junto a la hoja carta.
--
-- El mostrador imprime el ticket en la térmica y manda la carta por WhatsApp; son el mismo recibo
-- con el mismo folio. Guardar uno solo obligaba a generar el otro a demanda, lo que abría la puerta
-- a que el PDF "de cortesía" se generara con datos distintos a los del día de la venta.

ALTER TABLE "receipt" ADD COLUMN "ticketKey" TEXT;
