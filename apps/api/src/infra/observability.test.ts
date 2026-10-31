import { describe, expect, it } from 'vitest';
import { redactUrl } from './observability.js';

/**
 * Lo que se manda a Sentry no puede identificar a un negocio ni servir como credencial.
 *
 * Un token de recibo en la URL de un evento es una fuga: cualquiera con acceso al tablero de
 * errores podría abrir el recibo de un cliente. Y el slug del negocio en el nombre del endpoint
 * llena el agrupador de ruido: cien negocios, cien "rutas distintas" del mismo bug.
 */
describe('redactUrl', () => {
  it('borra el token del recibo público', () => {
    expect(redactUrl('https://app.partops.autos/api/r/eyJhbGciOi-long-token')).toBe(
      'https://app.partops.autos/api/r/:token',
    );
  });

  it('borra el slug de la vitrina', () => {
    expect(redactUrl('https://app.partops.autos/api/public/catalog/repuestos-la-tuerca?page=2')).toBe(
      'https://app.partops.autos/api/public/catalog/:slug',
    );
  });

  it('colapsa los flujos de auth en un solo endpoint', () => {
    expect(redactUrl('https://app.partops.autos/api/auth/sign-in/email')).toBe(
      'https://app.partops.autos/api/auth/:flow',
    );
  });

  it('quita la query string de cualquier ruta (lleva búsquedas y filtros)', () => {
    expect(redactUrl('https://app.partops.autos/api/search?q=balata+corolla')).toBe(
      'https://app.partops.autos/api/search',
    );
  });

  it('devuelve lo que recibe si no es una URL', () => {
    expect(redactUrl('no-es-url')).toBe('no-es-url');
  });
});
