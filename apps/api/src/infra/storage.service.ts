import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { env, isProduction } from '../config/env.js';

export interface StoredFile {
  /** Ruta dentro del almacenamiento. Es lo que se borra después; la URL puede cambiar de dominio. */
  key: string;
  url: string;
  bytes: number;
}

/**
 * Archivos: R2 en producción, disco en desarrollo.
 *
 * Se abstrae por una razón práctica, no por elegancia: en desarrollo nadie tiene credenciales de
 * R2 y sin esto el catálogo no se puede probar con imágenes. La diferencia entre los dos modos
 * está en cuatro métodos; el resto de la aplicación solo conoce `key` y `url`.
 *
 * La `key` es la fuente de verdad y la URL se deriva. Guardar solo la URL dejaría imágenes
 * huérfanas en el bucket el día que cambie el dominio público, que es exactamente el día en que
 * nadie se acuerda de limpiarlas.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly log = new Logger(StorageService.name);
  private readonly bucket = env.R2_BUCKET;
  private readonly localDir = resolve(process.cwd(), process.env.STORAGE_DIR ?? 'var/uploads');
  private client: S3Client | null = null;

  get usesR2(): boolean {
    return Boolean(
      env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_PUBLIC_URL,
    );
  }

  onModuleInit() {
    if (this.usesR2) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID!,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
        },
      });
      this.log.log(`Archivos en R2 (${this.bucket})`);
      return;
    }

    /**
     * En producción, caer a disco es un error de configuración que se descubre tarde: el
     * contenedor de Render no tiene disco persistente y cada reinicio borra las fotos. Mejor
     * fallar al arrancar que perder el catálogo en silencio.
     */
    if (isProduction) {
      throw new Error(
        'Faltan R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY o R2_PUBLIC_URL: en producción no se usa disco local',
      );
    }
    this.log.warn(`Archivos en disco local (${this.localDir}). Configura R2 para producción.`);
  }

  private publicUrl(key: string): string {
    if (this.usesR2) return `${env.R2_PUBLIC_URL!.replace(/\/+$/, '')}/${key}`;
    // La API sirve el archivo; la web lo pide por el mismo origen gracias al rewrite de Next.
    return `/api/media/${key}`;
  }

  async put(prefix: string, data: Buffer, extension: string, contentType: string): Promise<StoredFile> {
    const key = `${prefix.replace(/^\/+|\/+$/g, '')}/${randomUUID()}${extension}`;

    if (this.client) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
          // Un año: la key lleva UUID, así que el contenido de una URL nunca cambia.
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } else {
      const target = this.localPath(key);
      // En modo R2 ya se escribió arriba; aquí solo se llega cuando no lo hay.
      if (!target) throw new Error(`Key inválida para disco local: ${key}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }

    return { key, url: this.publicUrl(key), bytes: data.byteLength };
  }

  /** Devuelve la ruta física de un archivo local. `null` en modo R2 o si la key se escapa. */
  localPath(key: string): string | null {
    if (this.usesR2) return null;
    const target = resolve(this.localDir, normalize(key));
    // Un `../` en la key serviría cualquier archivo del servidor. Este chequeo es la barrera.
    if (!target.startsWith(this.localDir + sep)) return null;
    return target;
  }

  contentTypeFor(key: string): string {
    const ext = extname(key).toLowerCase();
    const map: Record<string, string> = {
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  /**
   * Borra el archivo. Nunca lanza: si el objeto ya no está (o R2 falla), la fila de la base igual
   * debe poder eliminarse. Un error de limpieza no es razón para dejar la pieza con una imagen rota.
   */
  async remove(key: string): Promise<void> {
    try {
      if (this.client) {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        return;
      }
      const target = this.localPath(key);
      if (target) await unlink(target).catch(() => undefined);
    } catch (err) {
      this.log.warn(`No se pudo borrar ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Ruta estable para los archivos de un negocio. La usan las imágenes de pieza y luego los PDF. */
  tenantPrefix(tenantId: string, kind: string, ownerId: string): string {
    return join(tenantId, kind, ownerId).split(sep).join('/');
  }
}
