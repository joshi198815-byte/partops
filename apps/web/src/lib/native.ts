/**
 * Puente con el APK (Capacitor).
 *
 * Todo aquí tiene que funcionar también en la web, y funcionar quiere decir **no hacer nada**: la
 * misma pantalla de despacho corre en el navegador de la bodega y en el teléfono, y no puede
 * preguntar «¿estás en Android?» en cada botón. Cada función comprueba el entorno y degrada.
 *
 * Los plugins se importan con especificador en variable a propósito: `@capacitor/*` solo existe en
 * el proyecto móvil, y un import literal rompería el build de Next, que nunca los carga. El precio
 * es que TypeScript no ve los tipos; se declaran aquí, mínimo y a mano.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

interface HapticsPlugin {
  impact(options: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }): Promise<void>;
}

interface SharePlugin {
  share(options: { title?: string; text?: string; dialogTitle?: string }): Promise<unknown>;
}

interface KeepAwakePlugin {
  keepAwake(): Promise<void>;
  allowSleep(): Promise<void>;
}

interface BarcodeScannerPlugin {
  requestPermissions(): Promise<{ camera: string }>;
  scan(): Promise<{ barcodes: Array<{ rawValue?: string; displayValue?: string }> }>;
}

interface PushPlugin {
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(
    event: 'registration',
    handler: (token: { value: string }) => void,
  ): Promise<{ remove: () => void }> | void;
}

function capacitor(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** ¿Estamos dentro del APK? En la web siempre es `false`, incluso en un Android. */
export function isNative(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/**
 * Carga un plugin nativo. Devuelve `null` en la web o si el paquete no está instalado: quien llama
 * decide qué hacer sin plugin, y nunca se entera de un error de importación.
 */
async function plugin<T>(name: string): Promise<T | null> {
  if (!isNative()) return null;
  try {
    const mod = (await import(/* @vite-ignore */ name)) as unknown as Record<string, T>;
    // Cada plugin exporta su objeto con nombre (`Haptics`, `Share`…), no `default`.
    const key = Object.keys(mod).find((k) => k !== 'default');
    return key ? (mod[key] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Vibración corta al confirmar una lectura.
 *
 * Es la única señal que el bodeguero recibe sin mirar la pantalla: con el teléfono en una mano y la
 * pieza en la otra, el pitido del escáner no se oye en una bodega. Sin plugin, silencio.
 */
export async function vibrateShort(): Promise<void> {
  const haptics = await plugin<HapticsPlugin>('@capacitor/haptics');
  try {
    await haptics?.impact({ style: 'LIGHT' });
  } catch {
    // Un aparato sin motor de vibración no es un error.
  }
}

/** Comparte el texto de un recibo por WhatsApp. En web cae al `share` del navegador si existe. */
export async function shareReceipt(text: string): Promise<void> {
  const share = await plugin<SharePlugin>('@capacitor/share');
  try {
    if (share) {
      await share.share({ title: 'Recibo PartOps', text, dialogTitle: 'Compartir recibo' });
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.share) {
      await navigator.share({ title: 'Recibo PartOps', text });
    }
  } catch {
    // Cancelar el diálogo de compartir es una acción del usuario, no una falla.
  }
}

/**
 * Mantiene la pantalla encendida mientras se prepara un pedido.
 *
 * El bodeguero deja el teléfono sobre el estante entre pieza y pieza; si la pantalla se apaga, tiene
 * que desbloquear con la mano ocupada. Se apaga al salir de la pantalla, no antes.
 */
export async function keepAwake(on: boolean): Promise<void> {
  // `@capacitor/keep-awake` no existe en el registro: el paquete real es el de la comunidad. Se
  // deja el especificador aquí para que el nombre no se cambie a ciegas en otro sitio.
  const awake = await plugin<KeepAwakePlugin>('@capacitor-community/keep-awake');
  try {
    if (on) await awake?.keepAwake();
    else await awake?.allowSleep();
  } catch {
    // Sin plugin, el sistema decide; no hay nada que romper.
  }
}

/**
 * Abre la cámara y devuelve el primer código leído, o `null`.
 *
 * `requestPermissions` antes de `scan`: el plugin nativo lanza si el permiso no está concedido, y en
 * Android la primera vez siempre falta. Pedirlo aquí evita un `catch` que el llamador confundiría
 * con «no hay cámara».
 */
export async function nativeScan(): Promise<string | null> {
  const scanner = await plugin<BarcodeScannerPlugin>('@capacitor-mlkit/barcode-scanning');
  if (!scanner) return null;
  try {
    const permission = await scanner.requestPermissions();
    if (permission.camera !== 'granted') return null;
    const result = await scanner.scan();
    const first = result.barcodes[0];
    return (first?.rawValue ?? first?.displayValue)?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Pide permiso de notificaciones y devuelve el token FCM, o `null`.
 *
 * El token se registra contra la API, no aquí: este módulo no conoce la sesión ni el negocio activo.
 * La pantalla que llama decide cuándo y con qué `tenantId` se suscribe.
 */
export async function registerPush(): Promise<string | null> {
  const push = await plugin<PushPlugin>('@capacitor/push-notifications');
  if (!push) return null;

  try {
    const permission = await push.requestPermissions();
    if (permission.receive !== 'granted') return null;

    // `register()` resuelve antes de que llegue el token; hay que esperar el evento. Si el servicio
    // no contesta en 10 s, se devuelve `null` en vez de dejar la promesa colgada para siempre.
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 10_000);

      const listener = push.addListener('registration', (token) => finish(token.value || null));
      void Promise.resolve(listener).catch(() => finish(null));
      void push.register().catch(() => finish(null));
    });
  } catch {
    return null;
  }
}
