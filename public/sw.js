/*
 * Service worker: keeps the app itself on the device so it opens instantly and works on weak or
 * no connection. Data (data/*.json) is handled by the app (saved in IndexedDB), and videos stream
 * from YouTube, so they aren't cached here.
 */
const CACHE = "reel-feed-app-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/data/")) return; // always fresh from the network (the app caches it itself)

  if (req.mode === "navigate") {
    // The page: try the network (3 s), fall back to the saved copy.
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
        if (res.ok) cache.put("index.html", res.clone());
        return res;
      } catch {
        return (await cache.match("index.html")) || (await cache.match(req)) || Response.error();
      }
    })());
    return;
  }

  // Scripts, styles, icons: file names change on every build, so a saved copy is always correct.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  })());
});
