const CACHE_NAME = 'english-coach-v1';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([
        './',
        './index.html',
        './style.css',
        './app.js',
        './manifest.json',
        './icons/icon-192.png',
        './icons/icon-512.png'
      ]);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Don't cache API calls
  if (!event.request.url.startsWith(self.location.origin)) return;
  
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request).catch(err => {
        console.warn('Service Worker fetch failed for:', event.request.url);
      });
    })
  );
});
