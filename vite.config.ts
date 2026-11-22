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
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "img-src 'self' data: https://i.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${sync}`.trim(),
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
 * Performance budget: the build FAILS if the app's code grows past these sizes (gzip, what phones
 * actually download), so it stays fast on weak networks. Raise a limit only on purpose.
 * Sizes when the budget was set (Phase 4): JS 29 kB, CSS 5.7 kB.
 * Raised JS 40 → 45 with the category system (Filters sheet, pickers, Sorting): 40.5 kB with sync on.
 * Vite 8 (Rolldown) bundles ~4 kB bigger than Vite 6 for the same code: 41.3 kB with sync on (Nov 2026).
 */
export const BUDGET_KB = { js: 45, css: 10 };

function sizeBudget(): Plugin {
  return {
    name: "size-budget",
    apply: "build",
    generateBundle(_opts, bundle) {
      const total = { js: 0, css: 0 };
      for (const f of Object.values(bundle)) {
        const kind = f.fileName.endsWith(".js") ? "js" : f.fileName.endsWith(".css") ? "css" : null;
        if (!kind) continue;
        const src = f.type === "chunk" ? f.code : f.source;
        total[kind] += gzipSync(typeof src === "string" ? src : Buffer.from(src)).length / 1024;
      }
      const report = (k: "js" | "css") => `${k.toUpperCase()} ${total[k].toFixed(1)} kB of ${BUDGET_KB[k]} kB`;
      const over = (["js", "css"] as const).filter((k) => total[k] > BUDGET_KB[k]);
      if (over.length) this.error(`Performance budget exceeded: ${over.map(report).join(", ")} (gzip). See vite.config.ts.`);
      this.info(`Performance budget OK: ${report("js")}, ${report("css")} (gzip)`);
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
    plugins: [securityPolicy(syncUrl), sizeBudget()],
  };
});
