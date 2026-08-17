/* BeatLab — service worker: la app funziona offline dopo la prima visita */
const CACHE = 'beatlab-v1';
const ASSETS = [
  '.', 'index.html', 'manifest.webmanifest', 'lame.min.js',
  'js/engine.js', 'js/dom.js', 'js/state.js', 'js/audio.js',
  'js/generator.js', 'js/exporters.js', 'js/ui.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
/* rete prima, cache come ripiego: gli aggiornamenti arrivano subito,
   ma senza rete la app parte lo stesso */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return r;
    }).catch(() => caches.match(e.request, {ignoreSearch:true})
      .then(r => r || caches.match('index.html')))
  );
});
