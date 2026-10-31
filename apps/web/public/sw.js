/**
 * Service Worker de PartOps.
 *
 * Su único trabajo real es recibir el push y abrir la pantalla correcta al tocarlo. No cachea la
 * aplicación: el bodeguero necesita la cola verdadera, y una pantalla cacheada le mostraría pedidos
 * que ya salieron. Lo que sí guarda es el cascarón mínimo para que el teléfono sin señal abra la
 * app en vez de la página de error del navegador; los datos los pone IndexedDB, no el Service
 * Worker.
 *
 * Ese CSS/JS del cascarón no se cachea a propósito: una versión vieja del código con una nueva de
 * la API es la forma más rápida de romper el despacho en silencio.
 */

const SHELL = ['/app/despacho', '/offline.html'];
const CACHE = 'partops-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Si el cascarón no se puede precachear (primera visita sin sesión), no se falla la
      // instalación: el push tiene que funcionar igual.
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Navegación sin red: se sirve el aviso de "sin señal" con el botón de reintentar.
 *
 * No se rellena con una copia de la cola: mostrar una lista vieja como si fuera actual es peor que
 * decir "estás sin señal". El teléfono ya tiene la cola en IndexedDB y la pinta la app.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate') return;
  if (!request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match('/offline.html');
      return (
        cached ?? new Response('Sin conexión', { status: 503, headers: { 'content-type': 'text/plain' } })
      );
    }),
  );
});

/**
 * Push.
 *
 * `tag` por pedido: dos avisos del mismo pedido se reemplazan en vez de apilarse. `renotify` sin
 * `tag` no hace nada, así que van juntos. `requireInteraction` se deja apagado: el aviso se va solo
 * cuando el bodeguero lo toca o pasan unos segundos, y no se queda tapando la pantalla toda la
 * mañana.
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'PartOps', body: 'Tienes trabajo en bodega', url: '/app/despacho', tag: 'partops' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Un payload que no es JSON no debe dejar el aviso mudo: se usa el texto por omisión.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      renotify: Boolean(payload.tag),
      icon: '/brand/icon-192.png',
      badge: '/brand/icon-192.png',
      // `data.url` es lo que abre `notificationclick`; la ruta ya viene interna.
      data: { url: payload.url ?? '/app/despacho' },
      vibrate: [80, 60, 120],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/app/despacho';

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Si ya hay una pestaña de la app, se enfoca y se navega: abrir otra duplica el socket y el
      // bodeguero acaba con dos listas distintas en la mano.
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin)) {
          await client.focus();
          await client.navigate(target).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
