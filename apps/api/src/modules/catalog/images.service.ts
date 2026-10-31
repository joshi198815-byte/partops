import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { IMAGE_MAX_DIMENSION, imageUploadProblem, MAX_IMAGES_PER_PART } from '@partops/contracts';
import sharp, { type Metadata, type Sharp } from 'sharp';
import { StorageService, type StoredFile } from '../../infra/storage.service.js';

export interface ProcessedImage extends StoredFile {
  width: number;
  height: number;
  /** Segunda versión en WebP para WebViews viejos: AVIF no está en todos los Android de bodega. */
  fallbackUrl: string;
}

/**
 * Imágenes de pieza.
 *
 * Tres cosas que se hacen aquí y no en el cliente:
 *
 *  1. **Re-codificar.** Una foto de teléfono trae EXIF con coordenadas GPS — la dirección de la
 *     bodega— y pesa 4 MB. Se decodifica con sharp y se vuelve a codificar, así el EXIF desaparece
 *     por construcción y no por un `delete` que alguien puede olvidar.
 *  2. **Limitar el lado mayor a 1400 px.** Es lo que se ve en la ficha; más es ancho de banda que
 *     nadie mira, y el plan gratuito de R2 también se llena.
 *  3. **Servir AVIF con respaldo WebP.** AVIF pesa la mitad, pero no lo abre cualquier WebView
 *     Android; guardar las dos versiones cuesta centavos y evita una ficha con hueco.
 */
@Injectable()
export class ImagesService {
  private readonly log = new Logger(ImagesService.name);

  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  async process(
    file: { buffer: Buffer; size: number; mimetype: string; originalname: string },
    tenantId: string,
    partId: string,
  ) {
    const problem = imageUploadProblem(file);
    if (problem) {
      throw new BadRequestException({ code: 'INVALID_IMAGE', message: problem });
    }

    let pipeline: Sharp;
    let metadata: Metadata;
    try {
      pipeline = sharp(file.buffer, { failOn: 'error' });
      metadata = await pipeline.metadata();
    } catch {
      // Un archivo con extensión .jpg y contenido que no es imagen: no se guarda ni se intenta.
      throw new BadRequestException({
        code: 'INVALID_IMAGE',
        message: 'El archivo no parece una imagen. Vuelve a tomarla o expórtala como JPG.',
      });
    }
    if (!metadata.width || !metadata.height) {
      throw new BadRequestException({
        code: 'INVALID_IMAGE',
        message: 'La imagen no tiene dimensiones legibles',
      });
    }

    // `rotate()` sin argumentos aplica la orientación EXIF antes de descartarla; sin esto, la foto
    // tomada de lado se guarda de lado para siempre.
    const base = sharp(file.buffer, { failOn: 'error' }).rotate().resize({
      width: IMAGE_MAX_DIMENSION,
      height: IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });

    const prefix = this.storage.tenantPrefix(tenantId, 'parts', partId);

    const [avif, webp] = await Promise.all([
      base.clone().avif({ quality: 62, effort: 4 }).toBuffer({ resolveWithObject: true }),
      base.clone().webp({ quality: 80 }).toBuffer({ resolveWithObject: true }),
    ]);

    const primary = await this.storage.put(prefix, avif.data, '.avif', 'image/avif');
    const fallback = await this.storage.put(prefix, webp.data, '.webp', 'image/webp');

    this.log.debug(`Imagen ${primary.key} ${avif.info.width}x${avif.info.height} (${primary.bytes} B)`);

    return {
      ...primary,
      width: avif.info.width,
      height: avif.info.height,
      fallbackUrl: fallback.url,
      fallbackKey: fallback.key,
    };
  }

  /** Valida el cupo antes de procesar: subir 9 imágenes para rechazar la novena es trabajo perdido. */
  assertCapacity(current: number, incoming = 1) {
    if (current + incoming > MAX_IMAGES_PER_PART) {
      throw new BadRequestException({
        code: 'IMAGE_LIMIT',
        message: `Cada pieza admite hasta ${MAX_IMAGES_PER_PART} imágenes`,
      });
    }
  }

  /**
   * Borra el original y la versión de respaldo.
   *
   * La URL de respaldo se deriva de la principal cambiando la extensión, porque el modelo guarda
   * una sola fila por imagen: dos columnas para dos formatos del mismo archivo duplicaría todo el
   * resto del código para ganar nada.
   */
  async removeImage(url: string, fallbackUrl: string | null): Promise<void> {
    for (const target of [url, fallbackUrl].filter((u): u is string => Boolean(u))) {
      const key = this.keyFromUrl(target);
      if (key) await this.storage.remove(key);
    }
  }

  /**
   * Extrae la `key` de una URL pública. Es lo único que sirve para borrar en R2 o en disco.
   *
   * Acepta el origen configurado **y** los que ya no lo son. Una foto subida antes de mover las
   * imágenes a `cdn.partops.autos` sigue guardada con `pub-*.r2.dev` en la base; si aquí solo se
   * reconociera el dominio nuevo, borrar esa pieza devolvería `null` y el objeto quedaría en el
   * bucket para siempre. Se reconocen los dos hosts de R2 a propósito.
   */
  keyFromUrl(url: string): string | null {
    const media = url.match(/\/api\/media\/(.+)$/);
    if (media?.[1]) return decodeURIComponent(media[1]);

    const publicBase = process.env.R2_PUBLIC_URL?.replace(/\/+$/, '');
    if (publicBase && url.startsWith(`${publicBase}/`)) return url.slice(publicBase.length + 1);

    // `pub-*.r2.dev` es el dominio de terceros que se usó antes: sigue en filas viejas.
    const legacy = url.match(/^https?:\/\/[^/]*\.r2\.dev\/(.+)$/i);
    if (legacy?.[1]) return decodeURIComponent(legacy[1]);

    return null;
  }
}
