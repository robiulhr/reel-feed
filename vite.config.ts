import { gzipSync } from "node:zlib";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Content Security Policy for the published site (GitHub Pages can't send headers, so it goes in a
 * <meta> tag). It allows only what the app really needs — its own files, YouTube's player and
 * thumbnails, and the sync server — so injected scripts or data leaks to other sites are blocked.
 * Only added to the production build (the dev server needs inline scripts for hot reload).
 */
function securityPolicy(syncUrl: string): Plugin {
  // "/api" (same address as the app, on Cloudflare) needs nothing extra
  const sync = syncUrl.startsWith("http") ? new URL(syncUrl).origin : "";
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com https://connect.facebook.net",
    // Facebook: the player for Facebook videos you added (its SDK, its frames, its thumbnails)
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com",
    "img-src 'self' data: https://i.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com https://*.fbcdn.net https://www.facebook.com",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' https://www.facebook.com https://graph.facebook.com ${sync}`.trim(),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
  return {
    name: "security-policy",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp }, injectTo: "head-prepend" },
      { tag: "meta", attrs: { name: "referrer", content: "strict-origin-when-cross-origin" }, injectTo: "head-prepend" },
    ],
  };
}

/**
 * Dev server only: answers /api/fb/* (Facebook video lookups) with the same code the app's Worker
 * runs (worker/src/fb.ts), so "Add a Facebook video" works with npm run dev too.
 */
function facebookLookupsInDev(): Plugin {
  return {
    name: "fb-lookups-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/fb/")) return next();
        try {
          const { handleFb } = await server.ssrLoadModule("/worker/src/fb.ts");
          const url = new URL(req.url, "http://localhost");
          const r: Response = await handleFb(new Request(url), url);
          res.statusCode = r.status;
          r.headers.forEach((v, k) => {
            res.setHeader(k, v);
          });
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          next(e);
        }
      });
    },
  };
}

/**
 * Performance budget: the build FAILS if the app's code grows past these sizes (gzip, what phones
 * actually download), so it stays fast on weak networks. Raise a limit only on purpose.
 * Sizes when the budget was set (Phase 4): JS 29 kB, CSS 5.7 kB.
 * Raised JS 40 → 45 with the category system (Filters sheet, pickers, Sorting): 40.5 kB with sync on.
 * Raised JS 45 → 48 with channel lists (Competitors/Inspiration feeds, Saved tabs, list editor): 45.4 kB.
 * Raised JS 48 → 54 with Facebook videos you add (Facebook player, Add dialog, Added page, page screen): 51.9 kB.
 *   (Their category guess runs on the server — the word lists stay out of the app.)
 * Vite 8 (Rolldown) bundles ~4 kB bigger than Vite 6 for the same code: 41.3 kB with sync on (Nov 2026).
 * Raised JS 54 → 56 with bulk add (the "Add several" button, "#add=" links, shared page saving): 54.6 kB.
 * Raised JS 56 → 58 with notes (the note chip on every video, the synced notes data): 55.6 kB. Their sheet
 * and the Notes page are loaded only when used.
 * Raised JS 58 → 62 with the activity log and cloud status (every change is written down in words, the
 *   "saved to the cloud / not backed up" line and dot, urgent syncing with retries): 58.7 kB. The Activity
 *   tab itself is loaded only when used.
 * Raised JS 62 → 64 with topics (the "📚 Topic" chip on every video, the synced topics data and its merge
 *   rules): 62.0 kB. The Topics page and its sheet are loaded only when used.
 * Raised JS 64 → 66 with Facebook pages in the Channels list, search and the phone-startup/sound work: 63.7 kB.
 * Raised JS 66 → 68 with the select-and-edit grid (the ☑ button on page and channel screens), the UI fixes of the
 *   screen-by-screen audit and the full-width note/topic chips: 65.0 kB. The edit sheet loads only when used.
 * Raised CSS 10 → 11 with playlists, sleep mode and the audit fixes: 9.6 kB.
 * Parts loaded only when used (like "Add several at once") don't slow the start: they don't count in
 * `js`, and each has its own limit, `lazy`.
 */
export const BUDGET_KB = { js: 68, css: 11, lazy: 10 };

function sizeBudget(): Plugin {
  return {
    name: "size-budget",
    apply: "build",
    generateBundle(_opts, bundle) {
      const total = { js: 0, css: 0 };
      const lazy: string[] = [];
      for (const f of Object.values(bundle)) {
        const kind = f.fileName.endsWith(".js") ? "js" : f.fileName.endsWith(".css") ? "css" : null;
        if (!kind) continue;
        const src = f.type === "chunk" ? f.code : f.source;
        const kb = gzipSync(typeof src === "string" ? src : Buffer.from(src)).length / 1024;
        if (f.type === "chunk" && f.isDynamicEntry && !f.isEntry) {
          if (kb > BUDGET_KB.lazy)
            this.error(`Performance budget exceeded: ${f.fileName} is ${kb.toFixed(1)} kB of ${BUDGET_KB.lazy} kB (gzip).`);
          lazy.push(`${f.name} ${kb.toFixed(1)} kB`);
          continue;
        }
        total[kind] += kb;
      }
      const report = (k: "js" | "css") => `${k.toUpperCase()} ${total[k].toFixed(1)} kB of ${BUDGET_KB[k]} kB`;
      const over = (["js", "css"] as const).filter((k) => total[k] > BUDGET_KB[k]);
      if (over.length) this.error(`Performance budget exceeded: ${over.map(report).join(", ")} (gzip). See vite.config.ts.`);
      this.info(
        `Performance budget OK: ${report("js")}, ${report("css")} (gzip)${lazy.length ? `; loaded when used: ${lazy.join(", ")}` : ""}`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const syncUrl = process.env.VITE_SYNC_URL || env.VITE_SYNC_URL || "";
  return {
    // Absolute paths, so files load from any page address (/saved, /channel/@x). "/" on Cloudflare;
    // the GitHub Pages copy is built with BASE_PATH=/reel-feed/.
    base: process.env.BASE_PATH || "/",
    server: { port: 5173, host: true },
    define: {
      // shown in Menu → About, so you can tell which version the app is running
      __BUILD__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [securityPolicy(syncUrl), sizeBudget(), facebookLookupsInDev()],
  };
});
