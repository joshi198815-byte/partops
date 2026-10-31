import { afterEach, describe, expect, it } from 'vitest';
import type { StorageService } from '../../infra/storage.service.js';
import { ImagesService } from './images.service.js';

/**
 * De qué URL se puede sacar la `key`.
 *
 * Parece un detalle y no lo es: `keyFromUrl` es lo único que sabe qué objeto borrar en R2. Si
 * devuelve `null`, la pieza se puede eliminar de la base pero la imagen se queda en el bucket para
 * siempre — invisible, ocupando espacio y sin forma de encontrarla.
 *
 * El caso que motivó estas pruebas es el cambio de dominio: las filas viejas guardan
 * `pub-*.r2.dev` y `R2_PUBLIC_URL` ya dice `cdn.partops.autos`. Reconocer solo el dominio actual
 * dejaría esas fotos sin poder borrarse.
 */
const ORIGINAL = process.env.R2_PUBLIC_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.R2_PUBLIC_URL;
  else process.env.R2_PUBLIC_URL = ORIGINAL;
});

function service() {
  // `keyFromUrl` no toca el almacenamiento: no hace falta un R2 falso.
  return new ImagesService({} as StorageService);
}

describe('images: key desde la URL', () => {
  it('saca la key del dominio actual', () => {
    process.env.R2_PUBLIC_URL = 'https://cdn.partops.autos';
    expect(service().keyFromUrl('https://cdn.partops.autos/t1/parts/p1/foto.avif')).toBe(
      't1/parts/p1/foto.avif',
    );
  });

  it('tolera una barra final en R2_PUBLIC_URL', () => {
    process.env.R2_PUBLIC_URL = 'https://cdn.partops.autos/';
    expect(service().keyFromUrl('https://cdn.partops.autos/t1/parts/p1/foto.webp')).toBe(
      't1/parts/p1/foto.webp',
    );
  });

  it('reconoce el subdominio r2.dev de las fotos viejas', () => {
    process.env.R2_PUBLIC_URL = 'https://cdn.partops.autos';
    expect(service().keyFromUrl('https://pub-abc123.r2.dev/t1/parts/p1/vieja.avif')).toBe(
      't1/parts/p1/vieja.avif',
    );
  });

  it('en desarrollo usa /api/media', () => {
    expect(service().keyFromUrl('/api/media/t1/parts/p1/foto.avif')).toBe('t1/parts/p1/foto.avif');
  });

  it('no inventa una key para un dominio ajeno', () => {
    process.env.R2_PUBLIC_URL = 'https://cdn.partops.autos';
    expect(service().keyFromUrl('https://otro-sitio.com/foto.jpg')).toBeNull();
  });

  it('no confunde un dominio que solo termina igual', () => {
    process.env.R2_PUBLIC_URL = 'https://cdn.partops.autos';
    expect(service().keyFromUrl('https://cdn.partops.autos.evil.io/x.avif')).toBeNull();
  });
});
