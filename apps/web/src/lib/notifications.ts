'use client';

import { api } from './api';

/**
 * Avisos del navegador.
 *
 * Tres estados posibles y la pantalla debe distinguirlos, porque el botón que se muestra en cada
 * uno es distinto:
 *
 *  - `no-soportado`: el navegador no tiene Service Worker o Push (Safari viejo, WebView sin soporte).
 *  - `sin-permiso`: el usuario nunca concedió, o lo revocó. Se puede pedir otra vez, pero solo
 *    desde un toque: pedir permiso al cargar la página lo bloquea para siempre en Chrome.
 *  - `activo`: hay suscripción viva y el servidor tiene la clave pública.
 */

export type PushState = 'no-soportado' | 'sin-servidor' | 'sin-permiso' | 'denegado' | 'activo';

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function pushState(): Promise<PushState> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'no-soportado';
  }

  let key: string | null = null;
  try {
    const res = await api<{ key: string | null }>('/api/realtime/push/key');
    key = res.key;
  } catch {
    return 'sin-servidor';
  }
  // Sin llaves VAPID el servidor no puede cifrar el aviso: pedir permiso sería una promesa vacía.
  if (!key) return 'sin-servidor';

  if (Notification.permission === 'denied') return 'denegado';
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return 'sin-permiso';
  return 'activo';
}

/**
 * Pide permiso y suscribe.
 *
 * Debe llamarse desde un `onClick`: Chrome exige un gesto del usuario y, si se pide en el arranque,
 * marca el origen como "no molestar" para siempre.
 */
export async function subscribePush(): Promise<PushState> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'no-soportado';
  }

  const res = await api<{ key: string | null }>('/api/realtime/push/key');
  if (!res.key) return 'sin-servidor';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denegado' : 'sin-permiso';

  const registration =
    (await navigator.serviceWorker.getRegistration('/sw.js')) ??
    (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // `userVisibleOnly` es obligatorio: un push silencioso no existe en la web.
      userVisibleOnly: true,
      applicationServerKey: base64ToBytes(res.key),
    }));

  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint) return 'sin-permiso';

  await api('/api/realtime/push/subscribe', {
    method: 'POST',
    body: json,
  });
  return 'activo';
}

/** Cancela el aviso en este aparato. El permiso del navegador se queda como está. */
export async function unsubscribePush(): Promise<PushState> {
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return 'sin-permiso';

  await api('/api/realtime/push/unsubscribe', {
    method: 'POST',
    body: { endpoint: subscription.endpoint },
  });
  await subscription.unsubscribe();
  return Notification.permission === 'denied' ? 'denegado' : 'sin-permiso';
}

/**
 * Sonido y vibración.
 *
 * El bodeguero no mira la pantalla: está con las manos en el estante. Un tono corto distinto por
 * evento le dice si entró un pedido o si el suyo ya salió, sin leer nada. El audio se crea al
 * primer toque porque los navegadores bloquean el sonido sin gesto previo.
 */
let audioContext: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  audioContext ??= new Ctor();
  return audioContext;
}

/** Desbloquea el audio. Se llama en el primer toque de la pantalla. */
export function primeAudio(): void {
  void context()
    ?.resume()
    .catch(() => undefined);
}

export type CueTone = 'NUEVO' | 'LISTO' | 'ENTREGADO' | 'CANCELADO' | 'SIN_STOCK';

const TONES: Record<CueTone, Array<{ hz: number; ms: number }>> = {
  // Entró trabajo: dos notas ascendentes, se oye desde el otro lado del pasillo.
  NUEVO: [
    { hz: 660, ms: 110 },
    { hz: 990, ms: 140 },
  ],
  // Todo listo: una nota alta y limpia.
  LISTO: [{ hz: 1180, ms: 180 }],
  // Salió: nota grave, confirma sin urgencia.
  ENTREGADO: [{ hz: 520, ms: 160 }],
  // Se canceló: dos notas descendentes.
  CANCELADO: [
    { hz: 700, ms: 110 },
    { hz: 450, ms: 170 },
  ],
  // Falta la pieza: tres golpes cortos, el más insistente.
  SIN_STOCK: [
    { hz: 400, ms: 90 },
    { hz: 400, ms: 90 },
    { hz: 400, ms: 140 },
  ],
};

export function playCue(tone: CueTone, enabled = true): void {
  if (!enabled) return;
  const ctx = context();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

  let at = ctx.currentTime;
  for (const { hz, ms } of TONES[tone]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    // Envolvente corta: sin el ataque/decaimiento el tono chasquea en el altavoz del teléfono.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + ms / 1000);
    at += ms / 1000;
  }
}

/** Vibración. Patrón distinto por evento, igual que el tono. */
const PATTERNS: Record<CueTone, number | number[]> = {
  NUEVO: [80, 60, 120],
  LISTO: 120,
  ENTREGADO: 60,
  CANCELADO: [120, 80, 120],
  SIN_STOCK: [60, 40, 60, 40, 60],
};

export function vibrate(tone: CueTone, enabled = true): void {
  if (!enabled) return;
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  navigator.vibrate(PATTERNS[tone]);
}
