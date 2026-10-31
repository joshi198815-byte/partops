import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/context.js';
import { StorageService } from '../../infra/storage.service.js';

/**
 * Archivos locales.
 *
 * En desarrollo las imágenes viven en disco (nadie tiene credenciales de R2 en su máquina) y hay
 * que servirlas. En producción la URL de la imagen apunta directo a R2 y esta ruta no se usa.
 *
 * Es `@Public()` a propósito: el catálogo público no tiene sesión y las fotos tienen que verse. La
 * key contiene un UUID, así que no es adivinable, y `localPath` rechaza cualquier `../` que intente
 * salir del directorio de archivos.
 */
@Controller('media')
export class MediaController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  @Get('*key')
  @Public()
  async serve(@Param('key') key: string | string[], @Res() res: Response) {
    const path = Array.isArray(key) ? key.join('/') : key;
    const file = this.storage.localPath(path);
    if (!file) throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: 'Ese archivo no existe' });

    res.setHeader('content-type', this.storage.contentTypeFor(path));
    // La key lleva UUID: el contenido de una URL nunca cambia.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ code: 'FILE_NOT_FOUND', message: 'Ese archivo no existe' });
      }
    });
  }
}
