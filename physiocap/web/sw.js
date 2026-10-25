// 오프라인 캐시 — 앱 셸 + MediaPipe 런타임 + 모델
const CACHE = 'physiocap-v1';
const CORE = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/app.js', 'js/analysis.js', 'js/pose.js', 'js/chart.js', 'js/store.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 네트워크 우선(앱 코드 최신 유지), 실패 시 캐시. 큰 바이너리(wasm/모델)는 캐시 우선.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const big = /\.(wasm|task)$/.test(new URL(req.url).pathname);
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (big) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok && (req.url.startsWith(self.location.origin) || big)) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req);
      if (hit) return hit;
      throw new Error('offline');
    }
  })());
});
