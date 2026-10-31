'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Turnstile: el captcha invisible de Cloudflare.
 *
 * Solo se pinta cuando la API dice que el negocio lo tiene activo (`turnstile.required`). Si el
 * script no carga —red de bodega, bloqueador, Cloudflare caído— el widget avisa y el formulario
 * sigue enviándose: la API ya decidió que un captcha que no carga no puede tumbar la venta, y el
 * límite por IP sigue contando. Fingir que el usuario es un robot por una red mala es peor negocio.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          theme?: 'auto' | 'light' | 'dark';
          language?: string;
          size?: 'normal' | 'compact' | 'flexible';
          callback?: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
        },
      ) => string | undefined;
      remove: (widgetId: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('No se pudo cargar la verificación'));
    document.head.appendChild(script);
  });
  // Un fallo no se cachea: el siguiente intento vuelve a probar, y si falla, el formulario sigue.
  scriptPromise.catch(() => {
    scriptPromise = null;
  });
  return scriptPromise;
}

export function TurnstileWidget({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  // El callback va en una ref: si el padre lo recrea al escribir en el formulario, volver a montar
  // el widget rompería el token ya resuelto y el cliente tendría que pasar el captcha de nuevo.
  const tokenSink = useRef(onToken);
  useEffect(() => {
    tokenSink.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let alive = true;
    void loadScript()
      .then(() => {
        if (!alive || !box.current || !window.turnstile || widget.current) return;
        widget.current =
          window.turnstile.render(box.current, {
            sitekey: siteKey,
            language: 'es',
            size: 'flexible',
            callback: (token) => tokenSink.current(token),
            'expired-callback': () => tokenSink.current(null),
            'error-callback': () => {
              tokenSink.current(null);
              setFailed(true);
            },
          }) ?? null;
      })
      .catch(() => {
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
      if (widget.current && window.turnstile) {
        try {
          window.turnstile.remove(widget.current);
        } catch {
          // El script pudo recargarse: quitar un widget que ya no existe no es un error.
        }
      }
      widget.current = null;
    };
    // `onToken` no entra: va por ref. `siteKey` es lo único que exige un widget nuevo.
  }, [siteKey]);

  return (
    <div className="space-y-1.5">
      <div ref={box} />
      {failed ? (
        <p className="text-[11.5px] leading-snug text-[var(--foreground-muted)]">
          La verificación no cargó. Puedes enviar el pedido igual: la bodega lo revisa antes de prepararlo.
        </p>
      ) : null}
    </div>
  );
}
