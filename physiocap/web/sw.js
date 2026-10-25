// 오프라인 캐시 — 첫 접속 때 앱 셸 + MediaPipe 런타임 + 포즈 모델(lite/full)을 모두 받아 둔다.
const CACHE = 'physiocap-v2';
const CORE = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/analysis.js', 'js/pose.js', 'js/chart.js', 'js/store.js',
  'vendor/tasks-vision/vision_bundle.mjs',
  'vendor/tasks-vision/wasm/vision_wasm_internal.js',
  'vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
  'vendor/models/pose_landmarker_lite.task',
  'vendor/models/pose_landmarker_full.task',
];
// SIMD 미지원 구형 기기용 런타임은 필요할 때만 받아 캐시한다.

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const big = /\.(wasm|task)$/.test(url.pathname);

  // 앱이 로컬 자산 존재를 HEAD 로 확인하므로, 오프라인에서도 캐시에 있으면 200 으로 답한다.
  if (req.method === 'HEAD') {
    e.respondWith((async () => {
      const hit = await caches.match(req.url, { ignoreSearch: true });
      if (hit) return new Response(null, { status: 200, headers: hit.headers });
      try { return await fetch(req); } catch { return new Response(null, { status: 404 }); }
    })());
    return;
  }
  if (req.method !== 'GET') return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 큰 바이너리(wasm/모델)는 캐시 우선
    if (big) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    // 그 외는 네트워크 우선(앱 코드 최신 유지), 실패하면 캐시
    try {
      const res = await fetch(req);
      if (res.ok && (url.origin === self.location.origin || big)) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      return new Response('offline', { status: 503 });
    }
  })());
});
