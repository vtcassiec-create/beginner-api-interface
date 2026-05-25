// Petrichor service worker — minimal, and deliberately NETWORK-FIRST so a
// fresh deploy always wins. The cache exists only so the app shell can open
// when you're offline; it never serves stale code while you're online, and it
// never touches /api/ calls or cross-origin requests (Supabase, the CDN).

const CACHE = "petrichor-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle our own same-origin GETs. Let everything else (POSTs, the
  // chat/upload API, Supabase, the supabase-js CDN) go straight to the network.
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match("/")))
  );
});
