import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The extension's guard on "Keep scrolling" (extension/content.js): it counts what the auto-scroll does, asks
 * for a break at the limits, and stops at once if Facebook shows a warning. The content script runs here
 * on a fake Facebook page with a fake `chrome` — no real Facebook is touched.
 */
const FB = "https://www.facebook.com/nike/reels/";
const tile = (id: number) =>
  `<a href="/reel/${id}/"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""><span>${id}K views</span></a>`;

async function setup(page: Page, o: { store?: Record<string, unknown>; warning?: boolean } = {}) {
  await page.route(FB, (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Nike</title></head><body style="height:4000px"><h1>Nike</h1>${Array.from({ length: 6 }, (_, i) => tile(1000 + i)).join("")}${
        o.warning ? '<div role="dialog">You’re temporarily blocked. Try again later.</div>' : ""
      }</body></html>`,
    }),
  );
  await page.addInitScript((store) => {
    const w = window as any;
    w.__store = store ?? {};
    w.__h = [];
    w.__msgs = [];
    w.chrome = {
      runtime: {
        id: "ext",
        sendMessage: async (m: unknown) => w.__msgs.push(m),
        onMessage: { addListener: (f: unknown) => w.__h.push(f) },
      },
      storage: {
        local: {
          get: async (k: string) => (k in w.__store ? { [k]: w.__store[k] } : {}),
          set: async (v: Record<string, unknown>) => Object.assign(w.__store, v),
        },
      },
    };
    w.__ask = (msg: unknown) => new Promise((res) => w.__h[0](msg, null, res));
  }, o.store);
  await page.goto(FB);
  await page.addScriptTag({ path: "extension/content.js" });
}
const ask = (page: Page, msg: unknown) => page.evaluate((m) => (window as any).__ask(m), msg);
const snap = async (page: Page) =>
  (await ask(page, { t: "get" })) as {
    running: boolean;
    reels: unknown[];
    guard: {
      reels: number;
      ms: number;
      note: { level: string; text: string } | null;
      cooldownUntil: number;
      limits: Record<string, number>;
    };
  };
const today = () => new Date().toLocaleDateString("en-CA");

test.describe("the auto-scroll guard", () => {
  test("a normal start: the reels are found, nothing is blocked, and the limits are reported", async ({ page }) => {
    await setup(page);
    const s = await snap(page);
    expect(s.reels).toHaveLength(6);
    expect(s.guard.note).toBeNull();
    expect(s.guard.limits).toMatchObject({ dayReels: 3000, steps: 150 });
    expect(s.guard.limits.dayMs).toBe(30 * 60000);
  });

  test("a run that finds nothing new ends by itself and is counted in today's totals", async ({ page }) => {
    test.setTimeout(60_000);
    await setup(page);
    await ask(page, { t: "scroll" });
    await expect.poll(async () => (await snap(page)).running, { timeout: 20_000 }).toBe(false);
    const stored = await page.evaluate(() => (window as any).__store.guard);
    expect(stored.day).toBe(today());
    expect(stored.ms).toBeGreaterThan(3000); // about three steps of 1.5–2.5 s
    expect((await snap(page)).guard.note).toBeNull(); // a short run needs no break
  });

  test("today's minutes are used up: it won't start, and says so", async ({ page }) => {
    await setup(page, { store: { guard: { day: today(), reels: 10, ms: 30 * 60000, cooldownUntil: 0, reason: "" } } });
    await ask(page, { t: "scroll" });
    const s = await snap(page);
    expect(s.running).toBe(false);
    expect(s.guard.note).toMatchObject({ level: "stop" });
    expect(s.guard.note?.text).toContain("minutes of auto-scroll today");
  });

  test("today's reels are used up: it won't start", async ({ page }) => {
    await setup(page, { store: { guard: { day: today(), reels: 3000, ms: 60000, cooldownUntil: 0, reason: "" } } });
    await ask(page, { t: "scroll" });
    const s = await snap(page);
    expect(s.running).toBe(false);
    expect(s.guard.note?.text).toContain("3,000 reels");
  });

  test("a break after a long run: it won't start until the break is over (and says how long)", async ({ page }) => {
    await setup(page, { store: { guard: { day: today(), reels: 100, ms: 60000, cooldownUntil: Date.now() + 5 * 60000, reason: "" } } });
    await ask(page, { t: "scroll" });
    const s = await snap(page);
    expect(s.running).toBe(false);
    expect(s.guard.note?.text).toMatch(/Take a break: you can use Keep scrolling again in [45] min/);
  });

  test("yesterday's numbers don't count today", async ({ page }) => {
    await setup(page, {
      store: { guard: { day: "2000-01-01", reels: 3000, ms: 99 * 60000, cooldownUntil: Date.now() + 60000, reason: "" } },
    });
    const s = await snap(page);
    expect(s.guard.reels).toBe(0);
    expect(s.guard.note).toBeNull();
  });

  test("Facebook shows its own warning: auto-scroll stops at once and stays off for an hour", async ({ page }) => {
    test.setTimeout(60_000);
    await setup(page, { warning: true });
    await ask(page, { t: "scroll" });
    await expect.poll(async () => (await snap(page)).running, { timeout: 20_000 }).toBe(false);
    const s = await snap(page);
    expect(s.guard.note).toMatchObject({ level: "stop" });
    expect(s.guard.note?.text).toMatch(/Facebook (is showing|showed) a warning/);
    expect(s.guard.cooldownUntil - Date.now()).toBeGreaterThan(55 * 60000);
    // asking again is refused, with the reason
    await ask(page, { t: "scroll" });
    const again = await snap(page);
    expect(again.running).toBe(false);
    expect(again.guard.note?.text).toContain("Facebook showed a warning");
  });
});
