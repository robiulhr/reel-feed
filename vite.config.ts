import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Content Security Policy for the published site (GitHub Pages can't send headers, so it goes in a
 * <meta> tag). It allows only what the app really needs — its own files, YouTube's player and
 * thumbnails, and the sync server — so injected scripts or data leaks to other sites are blocked.
 * Only added to the production build (the dev server needs inline scripts for hot reload).
 */
function securityPolicy(syncUrl: string): Plugin {
  const sync = syncUrl ? new URL(syncUrl).origin : "";
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const syncUrl = process.env.VITE_SYNC_URL || env.VITE_SYNC_URL || "";
  return {
    base: "./", // relative paths, so it can be hosted anywhere (e.g. GitHub Pages)
    server: { port: 5173, host: true },
    define: {
      // shown in Menu → About, so you can tell which version the app is running
      __BUILD__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [securityPolicy(syncUrl)],
  };
});
