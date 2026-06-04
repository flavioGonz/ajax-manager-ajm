/**
 * Service Worker — Ajax Manager AJM PWA
 *
 * Estrategia:
 *  - APP SHELL (index.html, manifest, sw, logo, iconos): cache-first con fallback red.
 *  - LIBS CDN (tailwind, chart.js, leaflet, lucide, tippy, socket.io): stale-while-revalidate.
 *  - DEVICE IMAGES: cache-first 24h.
 *  - /api/*: network-first SIN cache (los datos son live).
 *  - WebSocket / socket.io polling: bypass total.
 */

const APP_VERSION = 'ajm-v0.9.8';
const SHELL_CACHE = 'ajm-shell-' + APP_VERSION;
const LIBS_CACHE  = 'ajm-libs-'  + APP_VERSION;
const IMG_CACHE   = 'ajm-img-'   + APP_VERSION;

const SHELL_FILES = [
  '/dashboard/',
  '/dashboard/index.html',
  '/dashboard/offline.html',
  '/dashboard/manifest.webmanifest',
  '/dashboard/logo.svg',
  '/dashboard/icons/icon-192.png',
  '/dashboard/icons/icon-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_FILES).catch((err) => {
        console.warn('[sw] precache parcial:', err && err.message);
      })
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('ajm-') && ![SHELL_CACHE, LIBS_CACHE, IMG_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isApi(url)        { return url.pathname.startsWith('/api/'); }
function isSocket(url)     { return url.pathname.startsWith('/socket.io/'); }
function isShell(url)      { return url.pathname.startsWith('/dashboard/') && !url.pathname.includes('/api/'); }
function isDeviceImg(url)  { return url.pathname.startsWith('/device-images/'); }
function isLib(url)        {
  const h = url.hostname;
  return h === 'cdn.jsdelivr.net' || h === 'unpkg.com' || h === 'cdnjs.cloudflare.com' ||
         h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com';
}
function isTile(url)       { return /\.tile\.openstreetmap\.org$/.test(url.hostname); }

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Bypass socket.io y APIs - siempre red, sin cache
  if (isSocket(url) || isApi(url)) return;

  // Shell estrategia mixta:
  //  - HTML (navigate o accept text/html): NETWORK-FIRST con timeout 3s -> siempre version mas nueva
  //  - Assets estaticos (svg, png, manifest, sw): cache-first (no cambian seguido)
  if (url.origin === self.location.origin && isShell(url)) {
    const isHtml = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html') || url.pathname.endsWith('.html') || url.pathname.endsWith('/dashboard/') || url.pathname === '/dashboard';
    if (isHtml) {
      // NETWORK-FIRST con timeout 3s
      ev.respondWith((async () => {
        try {
          const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
          const fresh = await Promise.race([fetch(req), timeoutPromise]);
          if (fresh && fresh.ok) {
            try { const clone = fresh.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, clone)); } catch (_) {}
            return fresh;
          }
          throw new Error('network not ok');
        } catch (_) {
          // Sin red o timeout: servir cache
          const cached = await caches.match(req);
          if (cached) return cached;
          const offline = await caches.match('/dashboard/offline.html');
          if (offline) return offline;
          return (await caches.match('/dashboard/index.html')) || new Response('', { status: 504 });
        }
      })());
      return;
    }
    // Assets estaticos: cache-first
    ev.respondWith(
      caches.match(req).then((cached) => {
        if (cached) {
          fetch(req).then((fresh) => {
            if (fresh.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, fresh));
          }).catch(() => {});
          return cached;
        }
        return fetch(req).then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        }).catch(() => new Response('', { status: 504 }));
      })
    );
    return;
  }

  // Device images: cache-first
  if (url.origin === self.location.origin && isDeviceImg(url)) {
    ev.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(IMG_CACHE).then((c) => c.put(req, clone));
        }
        return resp;
      }).catch(() => new Response('', { status: 504 })))
    );
    return;
  }

  // Libs CDN: stale-while-revalidate
  if (isLib(url)) {
    ev.respondWith(
      caches.open(LIBS_CACHE).then((c) =>
        c.match(req).then((cached) => {
          const networkFetch = fetch(req).then((resp) => {
            if (resp.ok) c.put(req, resp.clone()).catch(() => {});
            return resp;
          }).catch(() => cached || new Response('', { status: 504, statusText: 'Lib unreachable' }));
          // Si hay cache, devolverla rapido y revalidar en background
          if (cached) { networkFetch.catch(() => {}); return cached; }
          return networkFetch;
        })
      )
    );
    return;
  }

  // Map tiles: cache durante 7 dias
  if (isTile(url)) {
    ev.respondWith(
      caches.open(IMG_CACHE).then((c) =>
        c.match(req).then((cached) => cached || fetch(req).then((resp) => {
          if (resp.ok) c.put(req, resp.clone());
          return resp;
        }).catch(() => new Response('', { status: 504 })))
      )
    );
    return;
  }

  // Default: red, fallback cache
  ev.respondWith(
    fetch(req)
      .catch(() => caches.match(req))
      .then((r) => r || new Response('', { status: 504, statusText: 'Offline' }))
  );
});

// Mensajes desde la app (ej. solicitar update)
self.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================
self.addEventListener('push', (ev) => {
  let data = {};
  try { data = ev.data ? ev.data.json() : {}; } catch (_) {
    try { data = { title: 'AJM', body: ev.data ? ev.data.text() : 'Evento nuevo' }; } catch (__) {}
  }
  const title = data.title || 'Ajax Manager';
  const isAlarm = (data.severity || '').toUpperCase() === 'ALARM';
  const options = {
    body: data.body || '',
    icon: data.icon || '/dashboard/icons/icon-192.png',
    badge: data.badge || '/dashboard/icons/icon-192.png',
    image: data.image || undefined,
    tag: data.tag || ('evt-' + (data.eventId || Date.now())),
    renotify: isAlarm,
    requireInteraction: isAlarm,    // alarmas: el usuario tiene que cerrarla manualmente
    vibrate: isAlarm ? [200, 100, 200, 100, 200] : [120],
    data: { url: data.url || '/dashboard/', eventId: data.eventId, severity: data.severity, hubId: data.hubId },
    actions: isAlarm ? [
      { action: 'ack',  title: '\u{2705} Reconocer' },
      { action: 'open', title: '\u{1F50D} Ver' },
    ] : [
      { action: 'open', title: '\u{1F50D} Ver' },
    ],
  };
  ev.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const data = ev.notification.data || {};
  let url = data.url || '/dashboard/';
  if (ev.action === 'ack' && data.eventId) {
    url = '/dashboard/#/alarmas?ack=' + encodeURIComponent(data.eventId);
  } else if ((ev.action === 'open' || !ev.action) && data.eventId) {
    url = '/dashboard/#/events/' + encodeURIComponent(data.eventId);
  }
  ev.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Buscar tab abierta
    for (const c of all) {
      if (c.url && c.url.includes('/dashboard/')) {
        try { await c.focus(); } catch (_) {}
        try { c.navigate ? c.navigate(self.location.origin + url) : c.postMessage({ type: 'NAVIGATE', url }); } catch (_) {}
        return;
      }
    }
    // Sino, abrir nueva
    await self.clients.openWindow(url);
  })());
});

// Si Push expira y el servidor lo retira, resubscribir transparentemente
self.addEventListener('pushsubscriptionchange', (ev) => {
  ev.waitUntil((async () => {
    try {
      const r = await fetch('/api/push/vapid-key');
      if (!r.ok) return;
      const { publicKey } = await r.json();
      if (!publicKey) return;
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      // No mandamos al backend desde aca porque no tenemos JWT. La app lo refrescara al abrir.
      console.log('[sw] resubscribed:', newSub.endpoint);
    } catch (err) {
      console.warn('[sw] pushsubscriptionchange fallo:', err && err.message);
    }
  })());
});

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - b64.length % 4) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = self.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
