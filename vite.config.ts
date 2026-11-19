import { defineConfig } from "vite";

export default defineConfig({
  base: "./", // relative paths, so it can be hosted anywhere later (e.g. GitHub Pages)
  server: { port: 5173, host: true },
});
