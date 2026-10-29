/**
 * Service worker: what makes the site installable, and nothing more.
 *
 * Chrome will not offer to install a site unless a service worker with a fetch
 * handler is registered, so one has to exist. The temptation is to make it a
 * full offline cache and this app has already paid for that mistake once: a
 * previous caching rule served a page from cache alongside a script from the new
 * deploy, and the mismatch threw before the dashboard's error handler existed,
 * leaving a permanent spinner. The comment in `src/app.js` records it.
 *
 * So the rules here are deliberately conservative:
 *
 *   - API calls are never intercepted at all. A cached balance, a cached lesson
 *     or a cached certificate would be wrong in a way that looks like a bug in
 *     the academy rather than in the cache. They go straight to the network.
 *   - Writes are never intercepted. A cached POST is a lie.
 *   - Pages, scripts and stylesheets are network-first: the network is always
 *     tried and its answer always wins, so a deploy is picked up on the next
 *     load exactly as it would be with no service worker at all. The cache is
 *     only consulted when the network has already failed.
 *   - Images and fonts are cache-first, because they are content-stable and a
 *     version string is not going to appear for them.
 *
 * The net effect is that the service worker changes nothing while online, and
 * turns "this site can't be reached" into a readable offline page while not.
 */

const VERSION = 'wga-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

/** The minimum needed to show something honest when the network is gone. */
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      // A failed precache must not block installation: the offline page being
      // absent is a small loss, the site being uninstallable is a large one.
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => !name.startsWith(VERSION))
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

/** Anything that must never be answered from a cache. */
function isUntouchable(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/health' ||
    url.pathname === '/sw.js' ||
    url.pathname.startsWith('/manifest')
  );
}

function isAsset(url) {
  return /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(url.pathname);
}

/**
 * Network-first, and the cache is written only on success.
 *
 * `cache: 'no-store'` on the request is what keeps a stale document out of the
 * browser's own HTTP cache; the Cache API copy is ours and is refreshed on every
 * successful load, so a reader who goes offline gets the last page that actually
 * worked rather than whatever the browser happened to keep.
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // A different origin is somebody else's business — Google Fonts, the
  // translate widget, Cloudflare's video host. Let the browser handle it.
  if (url.origin !== self.location.origin) return;

  if (isUntouchable(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      networkFirst(request, SHELL_CACHE).catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const offline = await caches.match(OFFLINE_URL);
        if (offline) return offline;
        return new Response('You are offline and this page has not been saved.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })
    );
    return;
  }

  if (isAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE).catch(() => Response.error()));
    return;
  }

  event.respondWith(networkFirst(request, SHELL_CACHE));
});

/**
 * Let a page ask the waiting worker to take over immediately.
 *
 * Without this an update sits in "waiting" until every tab of the site is
 * closed, which for a customer who keeps the app installed on a phone can be
 * days. The page calls this after a successful install of a newer version.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});
