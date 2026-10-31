/**
 * Lectura de códigos de barras.
 *
 * Tres caminos, en orden de calidad:
 *
 *  1. **Nativo** (plugin ML Kit dentro del APK): enfoca solo, funciona con poca luz y con etiquetas
 *     gastadas. Es el camino real del bodeguero, y vive en `native.ts` porque comparte el mismo
 *     puente que la vibración y el despertar de pantalla.
 *  2. **`BarcodeDetector` del navegador**, donde exista (Chrome en Android). Sin plugins, sin
 *     descargas.
 *  3. **`null`**: no hay cámara disponible. Quien llama debe esconder el botón, no mostrar uno que
 *     no hace nada.
 *
 * Nada de esto lanza: una cámara denegada o un permiso revocado son situaciones normales en una
 * bodega, no errores que deban romper la pantalla.
 */
import { isNative, nativeScan } from './native';

type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

export { isNative };

/** Un fotograma de la cámara trasera, si el navegador sabe leer códigos. */
async function browserScan(): Promise<string | null> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor || !navigator.mediaDevices?.getUserMedia) return null;

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const detector = new Ctor({ formats: ['code_128', 'code_39', 'ean_13', 'qr_code', 'itf'] });
    // Un segundo de intentos: si no leyó nada, el bodeguero vuelve a apuntar. Insistir más tiempo
    // deja la pantalla congelada y la persona cree que la aplicación se colgó.
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const found = await detector.detect(video);
      const value = found[0]?.rawValue?.trim();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return null;
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach((track) => {
      track.stop();
    });
  }
}

/**
 * Abre la cámara y devuelve el primer código leído, o `null`.
 *
 * El `null` es la señal para esconder el botón de escanear: si no hay forma de leer, ofrecerlo solo
 * consigue que el bodeguero toque un botón que no responde.
 */
export async function scanCode(): Promise<string | null> {
  const native = await nativeScan();
  if (native) return native;
  return browserScan();
}

/** ¿Tiene sentido pintar el botón «Escanear» en este aparato? */
export function canScan(): boolean {
  if (typeof window === 'undefined') return false;
  if (isNative()) return true;
  return typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector === 'function';
}
