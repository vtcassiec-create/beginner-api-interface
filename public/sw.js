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

// ---- Web Push ----
// Show a notification when the server pushes one (his reach). The payload is
// JSON: { title, body, url }. Tapping it focuses/opens the app at url.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || "Claude";
  const body = data.body || "";
  const url = data.url || "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
      tag: "petrichor-reach",     // a new reach replaces the last unread one
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing tab if one's open; otherwise open a new one.
        for (const c of clients) {
          if ("focus" in c) { c.focus(); return; }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});
