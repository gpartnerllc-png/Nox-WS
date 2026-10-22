const CACHE = 'noxmob-v8';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/assets/app.css',
  '/assets/app.js',
  '/assets/scene.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/icon-180.png',
  '/favicon-32.png'
];

const API_PREFIXES = [
  '/api/',
  '/auth/',
  '/wa/',
  '/pay/',
  '/cnpj/',
  '/webhook/',
  '/health'
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>NoxMob · Offline</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 32%,#ffe9d2,#f7f2ea 62%,#eef3fb 100%);color:#16233a;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
  main{max-width:420px;text-align:center}
  .orb{width:104px;height:104px;margin:0 auto 26px;border-radius:50%;background:radial-gradient(circle at 38% 32%,#fff7ec,#ffb469 42%,#ff7a1a 68%,#155eef 100%);box-shadow:0 18px 40px rgba(255,122,26,.28),inset 0 2px 6px rgba(255,255,255,.6);position:relative}
  .orb::after{content:"";position:absolute;inset:-18px -34px;border:2px solid rgba(21,94,239,.35);border-radius:50%;transform:rotate(-22deg)}
  h1{font-size:22px;margin:0 0 10px;letter-spacing:-.02em}
  p{color:#5e6c80;font-size:14px;line-height:1.6;margin:0 0 22px}
  button{border:0;border-radius:12px;padding:13px 22px;font-weight:800;font-size:14px;color:#fff;background:linear-gradient(180deg,#4a8bff,#155eef 50%,#0b47c4);box-shadow:0 4px 0 #073293,0 12px 24px rgba(21,94,239,.28);cursor:pointer}
  button:active{transform:translateY(2px);box-shadow:0 2px 0 #073293}
</style></head>
<body><main><div class="orb"></div><h1>Você está offline</h1>
<p>O NoxMob guardou os dados da última sincronização. Reconecte para enviar vendas e receber atualizações.</p>
<button onclick="location.reload()">Tentar novamente</button></main></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isApi(url) {
  return API_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isApi(url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put('/index.html', clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match('/index.html');
          if (cached) return cached;
          return new Response(OFFLINE_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            status: 200
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached || new Response('', { status: 408 }));
      return cached || network;
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
