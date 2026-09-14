/* Push + install support. No offline caching: the game is useless offline anyway. */
self.addEventListener('install', (event) => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = { title: 'Traque', body: 'Il se passe quelque chose dans la partie.' };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (err) {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      tag: payload.kind === 'joker' ? 'traque-joker' : 'traque',
      renotify: true,
      requireInteraction: !!payload.loud,
      vibrate: [220, 90, 220, 90, 420],
      data: { url: '/app' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/app') && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow('/app');
    })
  );
});
