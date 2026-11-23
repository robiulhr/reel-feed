import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeTips, expect, test } from "./fixtures";

/**
 * The browser extension (extension/): its bridge script and its side panel, run here with a stand-in
 * for Chrome's extension API (the panel is opened straight from the folder).
 */
const BRIDGE = readFileSync(resolve("extension/bridge.js"), "utf8");
const PANEL_URL = pathToFileURL(resolve("extension/panel.html")).href;

const IDS = ["1000000000001", "1000000000002", "1000000000003", "1000000000004", "1000000000005"];

test.describe("extension bridge (runs on Reel Feed's own site)", () => {
  test("keeps the added video numbers the app sends, and ignores anything else", async ({ app: page }) => {
    await closeTips(page);
    await page.evaluate((code) => {
      const w = window as any;
      w.__saved = [];
      w.chrome = { storage: { local: { set: (o: unknown) => w.__saved.push(o) } } };
      new Function(code)();
    }, BRIDGE);
    const saved = () => page.evaluate(() => (window as any).__saved.map((o: any) => o.library?.ids));
    // it said hello, the app answered with the (empty) list
    await expect.poll(saved).toEqual([[]]);

    await page.evaluate(() => {
      const post = (data: unknown) => window.postMessage(data, location.origin);
      post({ source: "reel-feed-app", t: "library", ids: ["1141407915517139", "abc", "12", 77, "9".repeat(40)] }); // only real numbers count
      post({ source: "someone-else", t: "library", ids: ["1141407915517140"] }); // not from the app
      post({ source: "reel-feed-app", t: "other", ids: ["1141407915517141"] });
      post({ source: "reel-feed-app", t: "library", ids: "nope" });
    });
    await expect.poll(saved).toEqual([[], ["1141407915517139"]]);
  });
});

test.describe("extension side panel: which reels are already added", () => {
  test.beforeEach(async ({ page }) => {
    // the panel looks up each reel's title; keep that off the network
    await page.route("https://reel-feed.robiulhr2201.workers.dev/api/fb/meta**", (r) => {
      const url = new URL(r.request().url()).searchParams.get("url") ?? "";
      const id = /reel\/(\d+)/.exec(url)?.[1] ?? "0";
      return r.fulfill({ json: { title: `Reel title ${id.slice(-1)}`, caption: `Reel title ${id.slice(-1)}\nAbout it` } });
    });
    await page.addInitScript((ids) => {
      const w = window as any;
      const store: Record<string, unknown> = {};
      const listeners: ((ch: unknown, area: string) => void)[] = [];
      w.__created = [];
      const reels = ids.map((id: string, i: number) => ({ id, views: (i + 1) * 10_000, viewsText: "", thumb: "", pos: i }));
      const snapshot = {
        t: "reels",
        key: "/nike/",
        running: false,
        cap: 300,
        page: { name: "Nike", url: "https://www.facebook.com/nike/", reelsTab: true },
        reels,
      };
      w.chrome = {
        storage: {
          local: {
            get: async (keys: string | string[]) =>
              Object.fromEntries(
                [keys]
                  .flat()
                  .filter((k) => k in store)
                  .map((k) => [k, store[k]]),
              ),
            set: async (o: Record<string, unknown>) => Object.assign(store, o),
          },
          onChanged: { addListener: (f: (ch: unknown, area: string) => void) => listeners.push(f) },
        },
        tabs: {
          query: async () => [{ id: 1, url: "https://www.facebook.com/nike/reels/" }],
          sendMessage: async () => snapshot,
          create: (o: { url: string }) => w.__created.push(o.url),
          onActivated: { addListener() {} },
          onUpdated: { addListener() {} },
        },
        scripting: { executeScript: async () => [] },
        windows: {},
        runtime: { onMessage: { addListener() {} } },
      };
      /** What the app's message does: the bridge stores the list, the panel hears about the change. */
      w.__setLibrary = (library: unknown) => {
        const old = store.library;
        store.library = library;
        for (const f of listeners) f({ library: { oldValue: old, newValue: library } }, "local");
      };
    }, IDS);
    await page.goto(PANEL_URL);
    await expect(page.locator("#list li")).toHaveCount(5);
  });

  const setLibrary = (page: import("@playwright/test").Page, ids: string[], at = Date.now()) =>
    page.evaluate(([i, t]) => (window as any).__setLibrary({ ids: i, at: t }), [ids, at] as const);

  test("before Reel Feed has told it anything: says so, no marks, nothing blocked", async ({ page }) => {
    await expect(page.locator("#syncNote")).toContainText("Open Reel Feed once");
    await expect(page.locator("#openApp")).toBeVisible();
    await expect(page.locator(".badge")).toHaveCount(0);
    await page.getByRole("button", { name: "Select shown" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 5 to Reel Feed");
  });

  test("added reels get a green ✓ Added mark, are dimmed, can't be ticked, and are counted", async ({ page }) => {
    await setLibrary(page, [IDS[1], IDS[3]]);
    await expect(page.locator(".badge")).toHaveCount(2);
    await expect(page.locator(".badge").first()).toHaveText("✓ Added");
    await expect(page.locator("#list li.added")).toHaveCount(2);
    for (const li of await page.locator("#list li.added").all()) await expect(li.locator("input")).toBeDisabled();
    await expect(page.locator("#status")).toContainText("2 already added · 3 not added yet");
    await expect(page.locator("#syncNote")).toContainText("marks come from Reel Feed");
    await expect(page.locator("#openApp")).toBeHidden();
    // the marked ones really are the two sent
    await expect(page.locator("#list li.added")).toContainText(["Reel title 2", "Reel title 4"]);
  });

  test("Select shown skips the added ones; Add sends only the new ones", async ({ page }) => {
    await setLibrary(page, [IDS[1], IDS[3]]);
    await page.getByRole("button", { name: "Select shown" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 3 to Reel Feed");
    await page.locator("#sendBtn").click();
    const urls = await page.evaluate(() => (window as any).__created);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`https://reel-feed.robiulhr2201.workers.dev/added#add=${[IDS[0], IDS[2], IDS[4]].join(",")}`);
  });

  test("the Show filter: all / not added yet / already added", async ({ page }) => {
    await setLibrary(page, [IDS[0], IDS[1]]);
    await page.locator("#show").selectOption("new");
    await expect(page.locator("#list li")).toHaveCount(3);
    await expect(page.locator(".badge")).toHaveCount(0);
    await page.locator("#show").selectOption("added");
    await expect(page.locator("#list li")).toHaveCount(2);
    await expect(page.locator(".badge")).toHaveCount(2);
    await page.locator("#show").selectOption("all");
    await expect(page.locator("#list li")).toHaveCount(5);
  });

  test("it updates the moment Reel Feed reports a change, even for a reel you had ticked", async ({ page }) => {
    await page.getByRole("button", { name: "Select shown" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 5 to Reel Feed");
    await setLibrary(page, [IDS[2]]); // you finished adding one in Reel Feed
    await expect(page.locator("#sendBtn")).toHaveText("Add 4 to Reel Feed"); // it came off the selection
    await expect(page.locator("#list li.added")).toHaveCount(1);
    await setLibrary(page, []); // …and deleted it there
    await expect(page.locator(".badge")).toHaveCount(0);
  });

  test("an old list is flagged and offers to open Reel Feed", async ({ page }) => {
    await setLibrary(page, [IDS[0]], Date.now() - 3 * 24 * 3600 * 1000);
    await expect(page.locator("#syncNote")).toContainText("Open Reel Feed to refresh them");
    await expect(page.locator("#openApp")).toBeVisible();
    await page.locator("#openApp").click();
    expect(await page.evaluate(() => (window as any).__created)).toEqual(["https://reel-feed.robiulhr2201.workers.dev/added"]);
  });
});
