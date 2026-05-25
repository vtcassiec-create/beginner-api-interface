// Petrichor service worker — intentionally minimal.
//
// It exists only so the app qualifies as installable. It does NOT intercept,
// cache, or serve anything — every request goes straight to the network, so
// the installed app behaves EXACTLY like the browser version (which works).
// (A previous version cached the app shell and caused a blank screen; this
// version also wipes any caches it left behind.) Offline support is
// intentionally dropped in favor of always-correct loading.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A fetch handler must exist for installability — but this one does nothing,
// so the browser handles every request normally.
self.addEventListener("fetch", () => {});
