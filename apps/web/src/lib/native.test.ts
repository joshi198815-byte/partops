import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNative, keepAwake, nativeScan, registerPush, shareReceipt, vibrateShort } from './native';

/**
 * El puente nativo fuera del APK.
 *
 * El contrato es aburrido a propósito: en la web todo resuelve `null` o no hace nada, y nada lanza.
 * Si alguna de estas funciones tirara, la pantalla de despacho —que corre igual en navegador y en
 * teléfono— se rompería para el bodeguero que trabaja desde una laptop.
 */
describe('native', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sin ventana no es nativo', () => {
    vi.stubGlobal('window', undefined);
    expect(isNative()).toBe(false);
  });

  it('en la web las funciones nativas no hacen nada y no lanzan', async () => {
    vi.stubGlobal('window', {});
    expect(isNative()).toBe(false);
    await expect(nativeScan()).resolves.toBeNull();
    await expect(registerPush()).resolves.toBeNull();
    await expect(vibrateShort()).resolves.toBeUndefined();
    await expect(keepAwake(true)).resolves.toBeUndefined();
    await expect(shareReceipt('Recibo PD-0001')).resolves.toBeUndefined();
  });

  it('con Capacitor nativo pero sin los plugins instalados degrada sin lanzar', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
    expect(isNative()).toBe(true);
    // Los paquetes @capacitor/* no existen en este entorno: el import dinámico falla y se ignora.
    await expect(nativeScan()).resolves.toBeNull();
    await expect(registerPush()).resolves.toBeNull();
    await expect(vibrateShort()).resolves.toBeUndefined();
  });

  it('compartir en web usa el share del navegador cuando existe', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { share });
    await shareReceipt('Total Q120.00');
    expect(share).toHaveBeenCalledWith({ title: 'Recibo PartOps', text: 'Total Q120.00' });
  });

  it('cancelar el diálogo de compartir no propaga el error', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      share: () => Promise.reject(Object.assign(new Error('cancelado'), { name: 'AbortError' })),
    });
    await expect(shareReceipt('Total Q120.00')).resolves.toBeUndefined();
  });
});
