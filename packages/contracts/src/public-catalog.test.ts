import { describe, expect, it } from 'vitest';
import {
  availabilityBucket,
  catalogInquiryMessage,
  publicCatalogQuerySchema,
  publicOrderSchema,
  publicOrderWhatsAppMessage,
  SCARCE_THRESHOLD,
  shopWhatsAppUrl,
} from './public-catalog.js';

/**
 * Catálogo público.
 *
 * Lo que se prueba aquí son las decisiones que se pueden probar sin base: cómo se publica la
 * existencia (sin números), qué texto sale por WhatsApp y qué pedidos se rechazan por forma. El
 * aislamiento entre negocios y la reserva de inventario se prueban contra Postgres, en la API.
 */
describe('disponibilidad publicada', () => {
  it('cero es agotado y no un "0 disponibles"', () => {
    expect(availabilityBucket(0)).toBe('AGOTADO');
    expect(availabilityBucket(-3)).toBe('AGOTADO');
  });

  it('dos o menos es "últimas": es donde el cliente decide hoy', () => {
    expect(availabilityBucket(1)).toBe('POCAS');
    expect(availabilityBucket(SCARCE_THRESHOLD)).toBe('POCAS');
    expect(availabilityBucket(SCARCE_THRESHOLD + 1)).toBe('HAY');
  });
});

describe('consulta del catálogo', () => {
  it('sin parámetros devuelve la portada, no un error', () => {
    const q = publicCatalogQuerySchema.parse({});
    expect(q).toEqual({ q: '', page: 1 });
  });

  it('una página absurda se acota en el esquema', () => {
    expect(publicCatalogQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(publicCatalogQuerySchema.safeParse({ page: '9999' }).success).toBe(false);
  });

  it('acepta el año como texto, que es como llega del selector', () => {
    expect(publicCatalogQuerySchema.parse({ year: '2009' }).year).toBe(2009);
  });
});

describe('pedido de invitado', () => {
  const base = {
    customerName: 'Taller La Esquina',
    customerPhone: '5555-1234',
    idempotencyKey: '11111111-2222-3333-4444-555555555555',
    items: [{ variantId: '3f7c1c1e-0000-4000-8000-000000000001', quantity: 1 }],
  };

  it('exige nombre y teléfono: sin teléfono no hay a quién avisar', () => {
    expect(publicOrderSchema.safeParse({ ...base, customerName: 'A' }).success).toBe(false);
    expect(publicOrderSchema.safeParse({ ...base, customerPhone: '123' }).success).toBe(false);
  });

  it('exige piezas: un pedido vacío no es un pedido', () => {
    expect(publicOrderSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });

  it('acota la cantidad por pieza para que nadie aparte el inventario del mes', () => {
    expect(
      publicOrderSchema.safeParse({
        ...base,
        items: [{ ...base.items[0], quantity: 999 }],
      }).success,
    ).toBe(false);
  });

  it('acepta el pedido mínimo sin Turnstile en desarrollo', () => {
    const parsed = publicOrderSchema.parse(base);
    expect(parsed.turnstileToken).toBeUndefined();
    expect(parsed.note).toBeUndefined();
  });
});

describe('mensaje de WhatsApp del pedido', () => {
  const text = publicOrderWhatsAppMessage({
    shopName: 'Repuestos El Tornillo',
    orderCode: 'PD-0042',
    customerName: 'Taller La Esquina',
    customerPhone: '+50255551234',
    lines: [
      { name: 'Filtro de aceite', variantTitle: '1.8L', sku: 'FIL-001', quantity: 2, totalCents: 25_000 },
    ],
    totalCents: 25_000,
    catalogUrl: 'https://partops.autos/c/el-tornillo',
  });

  it('lleva folio, piezas y total: la bodega no reconstruye la conversación', () => {
    expect(text).toContain('PD-0042');
    expect(text).toContain('FIL-001 × 2');
    expect(text).toContain('Repuestos El Tornillo');
    expect(text).toContain('partops.autos/c/el-tornillo');
  });

  it('no mete espacios duros en el total, que en WhatsApp se ven como huecos', () => {
    expect(text).not.toContain('\u00A0');
  });

  it('incluye la nota solo cuando existe', () => {
    expect(text).not.toContain('Nota:');
    const withNote = publicOrderWhatsAppMessage({
      shopName: 'X',
      orderCode: 'PD-0001',
      customerName: 'Y',
      customerPhone: '+50255551234',
      lines: [],
      totalCents: 0,
      catalogUrl: 'https://x.gt/c/x',
      note: 'Es para un Corolla 2009',
    });
    expect(withNote).toContain('Nota: Es para un Corolla 2009');
  });
});

describe('enlaces de WhatsApp', () => {
  it('sin número publicado no hay enlace: mejor ausente que roto', () => {
    expect(shopWhatsAppUrl({ whatsappE164: null }, 'hola')).toBeNull();
    expect(shopWhatsAppUrl({ whatsappE164: '123' }, 'hola')).toBeNull();
  });

  it('arma wa.me con el texto codificado', () => {
    const url = shopWhatsAppUrl({ whatsappE164: '50255551234' }, 'hola mundo');
    expect(url).toBe('https://wa.me/50255551234?text=hola%20mundo');
  });

  it('la consulta de pieza faltante dice qué se buscó', () => {
    const text = catalogInquiryMessage({
      shopName: 'El Tornillo',
      query: 'faro corolla 2009',
      catalogUrl: 'https://partops.autos/c/el-tornillo',
    });
    expect(text).toContain('faro corolla 2009');
    expect(text).toContain('no la encontré');
  });
});
