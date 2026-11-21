/*
 * Service worker: keeps the app itself on the device so it opens instantly and works on weak or
 * no connection. Data (data/*.json) is handled by the app (saved in IndexedDB), and videos stream
 * from YouTube, so they aren't cached here.
 *
 * Updates: the page is always fetched fresh (bypassing the browser cache). If the network is slow,
 * the saved copy opens right away AND the fresh page keeps downloading in the background, so the
 * next open (or the "tap to update" banner) gets the new version. Never stuck on an old version.
 */
const CACHE = "reel-feed-app-v2";

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
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // fresh copy, never from the browser's HTTP cache
      const fresh = fetch(new Request(req.url, { cache: "no-store", credentials: "same-origin" }))
        .then(async (res) => {
          if (res.ok) await cache.put("index.html", res.clone());
          return res;
        });
      e.waitUntil(fresh.catch(() => {})); // keep downloading even if we answer from the saved copy
      try {
        return await Promise.race([
          fresh,
          new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), 3000)),
        ]);
      } catch {
        const saved = await cache.match("index.html");
        if (saved) return saved;
        return fresh; // nothing saved yet — just wait for the network
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
