import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __BUILD__: JSON.stringify("2026-01-01T00:00:00.000Z") },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "happy-dom" },
      },
      {
        extends: true,
        test: { name: "worker", include: ["tests/worker/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
      },
    ],
  },
});
