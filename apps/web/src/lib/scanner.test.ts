import { afterEach, describe, expect, it, vi } from 'vitest';
import { canScan, isNative, scanCode } from './scanner';

/**
 * El escáner fuera del APK.
 *
 * Lo que se fija aquí es el contrato del `null`: sin cámara, sin `BarcodeDetector` y sin permisos,
 * todo resuelve `null` sin lanzar. Un `throw` en esta ruta deja la pantalla de despacho colgada
 * justo cuando el bodeguero está frente al estante.
 */
describe('scanner', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('./native');
    vi.resetModules();
  });

  it('sin ventana no es nativo y no hay escáner', async () => {
    vi.stubGlobal('window', undefined);
    expect(isNative()).toBe(false);
    expect(canScan()).toBe(false);
    await expect(scanCode()).resolves.toBeNull();
  });

  it('en la web sin BarcodeDetector no ofrece el botón', async () => {
    vi.stubGlobal('window', {});
    expect(isNative()).toBe(false);
    expect(canScan()).toBe(false);
    await expect(scanCode()).resolves.toBeNull();
  });

  it('con Capacitor nativo y el plugin ausente no revienta', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
    expect(isNative()).toBe(true);
    expect(canScan()).toBe(true);
    // El import dinámico falla en el entorno de pruebas; debe degradar a `null`.
    await expect(scanCode()).resolves.toBeNull();
  });

  it('una cámara denegada devuelve null y libera la pantalla', async () => {
    vi.stubGlobal('window', { BarcodeDetector: class {} });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('NotAllowedError')) },
    });
    await expect(scanCode()).resolves.toBeNull();
  });

  it('si el camino nativo lee un código, no se abre la cámara del navegador', async () => {
    // Un solo camino de validación para cámara, lector Bluetooth y tecleo: lo que devuelve el
    // nativo entra tal cual, sin pasar por `BarcodeDetector`.
    vi.doMock('./native', async () => {
      const actual = await vi.importActual<typeof import('./native')>('./native');
      return { ...actual, nativeScan: vi.fn().mockResolvedValue('TY-100') };
    });
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
    vi.resetModules();

    const fresh = await import('./scanner');
    await expect(fresh.scanCode()).resolves.toBe('TY-100');
  });
});
