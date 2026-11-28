const CACHE_VERSION = 'ft-v1.2.8';
const CACHE_PREFIX = 'fit-trainer-';
const CACHE_NAME = 'fit-trainer-' + CACHE_VERSION;
const PRECACHE_URLS = ['./', './index.html', './css/app.css', './js/app.js', './sw.js'];
const NAV_TIMEOUT_MS = 1500;

self.addEventListener('install', (event) => {
  // Новый worker остаётся waiting до явного безопасного обновления из приложения.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((e) => console.warn('[SW] precache skip', url, e))
        )
      )
    ).catch((e) => console.warn('[SW] precache failed', e))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function isNav(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

function putCache(req, res) {
  if (!res || !res.ok) return;
  const len = res.headers.get('content-length');
  if (len !== null && Number(len) < 500) return;
  const copy = res.clone();
  caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
}

async function matchShell(req) {
  // Не читаем кэш других приложений, размещённых на том же origin.
  const cache = await caches.open(CACHE_NAME);
  return (
    (await cache.match(req)) ||
    (await cache.match('./index.html')) ||
    (await cache.match('./')) ||
    (await cache.match('/index.html')) ||
    null
  );
}

function fetchTimeout(req, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { signal: ctrl.signal })
    .then((res) => { clearTimeout(t); return res; })
    .catch((err) => { clearTimeout(t); throw err; });
}

async function isGoodHtml(res) {
  if (!res || !res.ok) return false;
  try {
    const text = await res.clone().text();
    if (!text || text.length < 800) return false;
    if (!/<html/i.test(text)) return false;
    if (/<title>\s*404/i.test(text)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  if (isNav(req)) {
    event.respondWith((async () => {
      const cached = await matchShell(req);
      const networkPromise = fetchTimeout(req, NAV_TIMEOUT_MS)
        .then(async (res) => {
          if (await isGoodHtml(res)) {
            putCache(req, res);
            try {
              putCache(new Request('./index.html'), res.clone());
              putCache(new Request('./'), res.clone());
            } catch (e) {}
          }
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(networkPromise);
        return cached;
      }
      const net = await networkPromise;
      if (net && (await isGoodHtml(net))) return net;
      if (net) return net;
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Fit Trainer</title>' +
          '<body style="margin:0;background:#0a0a10;color:#f0f0f5;font-family:system-ui;padding:24px">' +
          '<h1>Нет сети</h1><p>Откройте сайт один раз при стабильном интернете.</p>' +
          '<p style="color:#a1a1b3;font-size:14px">Если экран пустой при наличии сети — очистите данные сайта и откройте снова.</p>' +
          '</body>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    })());
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => cache.match(req)).then((cached) => {
      if (cached) {
        fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') putCache(req, res);
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') putCache(req, res);
        return res;
      }).catch(() => new Response('', { status: 504, statusText: 'Offline' }));
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k))))
    );
  }
});
