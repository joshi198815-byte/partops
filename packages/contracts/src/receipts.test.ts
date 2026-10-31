import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  numberToWords,
  receiptUrls,
  receiptWhatsAppMessage,
  whatsappShareUrl,
} from './receipts.js';

describe('importe en letras', () => {
  it('cubre las decenas irregulares del español', () => {
    expect(numberToWords(16)).toBe('dieciséis');
    expect(numberToWords(21)).toBe('veintiuno');
    expect(numberToWords(31)).toBe('treinta y uno');
    expect(numberToWords(100)).toBe('cien');
    expect(numberToWords(101)).toBe('ciento uno');
  });

  it('no dice "un mil" ni "un cientos"', () => {
    expect(numberToWords(1000)).toBe('mil');
    expect(numberToWords(2100)).toBe('dos mil cien');
    expect(numberToWords(21_000)).toBe('veintiún mil');
  });

  it('millones en singular y plural', () => {
    expect(numberToWords(1_000_000)).toBe('un millón');
    expect(numberToWords(2_500_000)).toBe('dos millones quinientos mil');
  });

  it('el importe del recibo lleva centavos y moneda', () => {
    expect(amountInWords(210_000)).toBe('DOS MIL CIEN QUETZALES CON 00/100');
    expect(amountInWords(125_050)).toBe('MIL DOSCIENTOS CINCUENTA QUETZALES CON 50/100');
  });

  it('cero no se queda sin moneda', () => {
    expect(amountInWords(0)).toBe('CERO QUETZALES CON 00/100');
  });
});

describe('enlaces del recibo', () => {
  it('la barra final de la web no duplica la ruta', () => {
    expect(receiptUrls('https://partops.autos/', 'tok').publicUrl).toBe('https://partops.autos/r/tok');
  });

  it('el PDF sale por la API pública, no por una ruta con sesión', () => {
    expect(receiptUrls('http://localhost:3000', 'tok').pdfUrl).toBe(
      'http://localhost:3000/api/public/receipts/tok/pdf',
    );
  });
});

describe('mensaje de WhatsApp', () => {
  const text = receiptWhatsAppMessage({
    tenantName: 'Bodega Ana Repuestos',
    customerName: 'Taller Los Pinos',
    folio: 'R-0001',
    orderCode: 'BAR-0001',
    totalCents: 210_000,
    publicUrl: 'https://partops.autos/r/tok',
  });

  it('lleva folio, total y enlace: lo que el cliente necesita para reclamar', () => {
    expect(text).toContain('BAR-0001');
    expect(text).toContain('R-0001');
    expect(text).toContain('2,100.00');
    expect(text).toContain('https://partops.autos/r/tok');
  });

  it('un teléfono inválido no produce enlace a medias', () => {
    expect(whatsappShareUrl('5555-1234', 'hola')).toBeNull();
    expect(whatsappShareUrl('+50255551234', 'hola')).toBe(
      `https://wa.me/50255551234?text=${encodeURIComponent('hola')}`,
    );
  });
});
