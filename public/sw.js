// Leonida 100% service worker: lets the app open with no signal.
// Pages: network first, cached copy when offline. Build assets: cache first (they're content-hashed).
const CACHE = 'l100-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data === 'clear') event.waitUntil(caches.delete(CACHE));
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;

    if (url.pathname.startsWith('/_astro/') || url.pathname === '/favicon.svg') {
        event.respondWith(
            caches.match(req).then(
                (hit) =>
                    hit ||
                    fetch(req).then((res) => {
                        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
                        return res;
                    })
            )
        );
        return;
    }

    const isAppPage = req.mode === 'navigate' && (url.pathname === '/app' || url.pathname.startsWith('/app/'));
    if (isAppPage) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    // Only cache real app pages (not redirects to the landing page).
                    if (res.ok && !res.redirected) caches.open(CACHE).then((c) => c.put(url.pathname, res.clone()));
                    return res;
                })
                .catch(() => caches.match(url.pathname).then((hit) => hit || caches.match('/app')).then((hit) => hit || Response.error()))
        );
    }
});
