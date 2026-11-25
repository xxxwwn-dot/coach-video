// コーチビデオ Service Worker
// キャッシュバージョンを更新するとすべての古いキャッシュが削除されます
const CACHE_VERSION = 'v3';
const CACHE_NAME = 'coach-video-' + CACHE_VERSION;

const URLS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json'
];

// インストール: アプリアセットをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(URLS_TO_CACHE))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Cache install failed:', err))
  );
});

// アクティベート: 古いバージョンのキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keyList =>
        Promise.all(
          keyList
            .filter(key => key.startsWith('coach-video-') && key !== CACHE_NAME)
            .map(key => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// フェッチ: キャッシュファースト、失敗時はネットワーク
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // blob: URL（動画ファイル）はキャッシュしない
  if (url.startsWith('blob:')) return;

  // 外部URLはキャッシュしない（該当なし）
  if (!url.startsWith(self.location.origin)) return;

  // GET以外はスキップ
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        // キャッシュヒット: バックグラウンドで更新を試みる
        fetch(event.request).then(response => {
          if (response && response.ok) {
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, response.clone());
            });
          }
        }).catch(() => {});
        return cachedResponse;
      }

      // キャッシュミス: ネットワークから取得してキャッシュ
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200) return response;

        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });

        return response;
      }).catch(() => {
        // オフラインでキャッシュも無い場合: index.htmlを返す
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
