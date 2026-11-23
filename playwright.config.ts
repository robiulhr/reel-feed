import { defineConfig, devices } from "@playwright/test";

const PORT = 4174;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  // CI: "github" also shows each failure as a note on the run (readable without signing in)
  reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    serviceWorkers: "block", // tests control all network traffic themselves
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"] } },
    { name: "small-phone", use: { ...devices["Pixel 7"], viewport: { width: 320, height: 640 } } },
  ],
  webServer: {
    // Build exactly like production, but pointing at the fake sync server used by the tests.
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    env: { VITE_SYNC_URL: "http://sync.test" },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
