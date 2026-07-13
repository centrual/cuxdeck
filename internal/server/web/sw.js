// cuxdeck service worker — Web Push receiver. It exists only to turn a
// push payload into a native notification and, on tap, focus (or open)
// the panel. No caching/offline behaviour: the panel is a live control
// surface, stale HTML would be worse than a network error.

self.addEventListener("push", (event) => {
  let data = { title: "cuxdeck", body: "", tag: "cuxdeck" };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (_) {}
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    renotify: true,
    icon: "/onion.svg",
    badge: "/onion.svg",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow("/");
  })());
});
