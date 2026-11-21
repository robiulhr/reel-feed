import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // relative paths, so it can be hosted anywhere (e.g. GitHub Pages)
  server: { port: 5173, host: true },
  define: {
    // shown in Menu → About, so you can tell which version the app is running
    __BUILD__: JSON.stringify(new Date().toISOString()),
  },
});
