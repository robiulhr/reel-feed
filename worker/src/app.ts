/**
 * The app's own Worker ("reel-feed", config in app.wrangler.toml): serves the built app (dist/) and
 * passes /api/* to the sync Worker ("reel-feed-sync") over a service binding — same address for the
 * app and its sync, so no cross-site requests.
 *
 * Static files are served by Cloudflare before this code runs; only /api/* reaches it
 * (run_worker_first). Unknown paths get index.html (single-page app), ready for real page links.
 */
interface Env {
  ASSETS: Fetcher;
  SYNC: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return toSync(req, url, env);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

function toSync(req: Request, url: URL, env: Env) {
  const target = new URL(url.pathname.slice(4) || "/", "https://sync.internal");
  target.search = url.search;
  const headers = new Headers(req.headers);
  // Browsers leave out Origin on same-site GETs; the sync Worker only answers known sites, so say
  // where the request comes from. A request from another site keeps its own Origin (and is refused).
  if (!headers.has("Origin")) headers.set("Origin", url.origin);
  return env.SYNC.fetch(new Request(target, { method: req.method, headers, body: req.body, redirect: "manual" }));
}
