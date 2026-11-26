import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { closeTips, expect, test } from "./fixtures";

/**
 * The browser extension (extension/): its bridge script and its side panel, run here with a stand-in
 * for Chrome's extension API (the panel is opened straight from the folder).
 */
const BRIDGE = readFileSync(resolve("extension/bridge.js"), "utf8");
const PANEL_URL = pathToFileURL(resolve("extension/panel.html")).href;
const APP = "https://reel-feed.ecomgy.com/";

const IDS = ["1000000000001", "1000000000002", "1000000000003", "1000000000004", "1000000000005"];

test.describe("extension bridge (runs on Freed's own site)", () => {
  const install = (page: Page) =>
    page.evaluate((code) => {
      const w = window as any;
      w.__saved ??= [];
      w.chrome = { runtime: { id: "ext" }, storage: { local: { set: (o: unknown) => w.__saved.push(o) } } };
      new Function(code)();
    }, BRIDGE);
  const saved = (page: Page) => page.evaluate(() => (window as any).__saved.map((o: any) => o.library?.ids));

  test("keeps the added video numbers the app sends, and ignores anything else", async ({ app: page }) => {
    await closeTips(page);
    await install(page);
    // it said hello, the app answered with the (empty) list
    await expect.poll(() => saved(page)).toEqual([[]]);

    await page.evaluate(() => {
      const post = (data: unknown) => window.postMessage(data, location.origin);
      post({ source: "reel-feed-app", t: "library", ids: ["1141407915517139", "abc", "12", 77, "9".repeat(40)] }); // only real numbers count
      post({ source: "someone-else", t: "library", ids: ["1141407915517140"] }); // not from the app
      post({ source: "reel-feed-app", t: "other", ids: ["1141407915517141"] });
      post({ source: "reel-feed-app", t: "library", ids: "nope" });
    });
    await expect.poll(() => saved(page)).toEqual([[], ["1141407915517139"]]);
  });

  test("put in twice (the panel does that for tabs that were already open): one listener, it just asks again", async ({ app: page }) => {
    await closeTips(page);
    await install(page);
    await expect.poll(() => saved(page)).toEqual([[]]);
    await install(page); // second copy: sees the first one is alive, only says hello again
    await expect.poll(() => saved(page)).toEqual([[], []]); // the app answered the new hello once
    await page.evaluate(() => window.postMessage({ source: "reel-feed-app", t: "library", ids: ["1141407915517139"] }, location.origin));
    await expect.poll(() => saved(page)).toEqual([[], [], ["1141407915517139"]]); // stored once, not twice
  });

  test("a copy cut off from the extension (it was reloaded) stops quietly", async ({ app: page }) => {
    await closeTips(page);
    await install(page);
    await expect.poll(() => saved(page)).toEqual([[]]);
    await page.evaluate(() => {
      (window as any).chrome = { runtime: {} }; // what a cut-off copy sees: no extension id
      window.postMessage({ source: "reel-feed-app", t: "library", ids: ["1141407915517139"] }, location.origin);
    });
    await page.waitForTimeout(300);
    expect(await saved(page)).toEqual([[]]); // nothing stored, no error
  });
});

test.describe("extension side panel: which reels are already added", () => {
  test.beforeEach(async ({ page }) => {
    // the panel looks up each reel's title; keep that off the network
    await page.route(`${APP}api/fb/meta**`, (r) => {
      const url = new URL(r.request().url()).searchParams.get("url") ?? "";
      const id = /reel\/(\d+)/.exec(url)?.[1] ?? "0";
      return r.fulfill({ json: { title: `Reel title ${id.slice(-1)}`, caption: `Reel title ${id.slice(-1)}\nAbout it` } });
    });
    await page.addInitScript((ids) => {
      const w = window as any;
      const opts = () => w.__opts ?? {}; // what the test says about Freed's tabs
      const store: Record<string, unknown> = {};
      const listeners: ((ch: unknown, area: string) => void)[] = [];
      w.__created = [];
      w.__injected = [];
      w.__reloaded = [];
      const reels = ids.map((id: string, i: number) => ({ id, views: (i + 1) * 10_000, viewsText: "", thumb: "", pos: i }));
      const snapshot = {
        t: "reels",
        key: "/nike/",
        running: false,
        cap: 300,
        page: { name: "Nike", url: "https://www.facebook.com/nike/", reelsTab: true },
        reels,
      };
      /** What the app's message does: the bridge stores the list, the panel hears about the change. */
      w.__setLibrary = (library: unknown) => {
        const old = store.library;
        store.library = library;
        for (const f of listeners) f({ library: { oldValue: old, newValue: library } }, "local");
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
          // Freed's tabs when asked by address, otherwise the Facebook tab you're on
          query: async (q?: { url?: string }) =>
            q?.url ? (opts().appTabs ?? []) : [{ id: 1, url: "https://www.facebook.com/nike/reels/" }],
          sendMessage: async () => snapshot,
          create: (o: { url: string }) => w.__created.push(o.url),
          reload: async (id: number) => w.__reloaded.push(id),
          onActivated: { addListener() {} },
          onUpdated: { addListener() {} },
        },
        scripting: {
          executeScript: async (o: { target: { tabId: number } }) => {
            w.__injected.push(o.target.tabId);
            // an app that answers the bridge's hello
            if (opts().answers) setTimeout(() => w.__setLibrary({ ids: opts().ids ?? [], at: Date.now() }), 100);
            return [];
          },
        },
        windows: {},
        runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: "9.9.9" }) },
      };
    }, IDS);
  });

  /** Opens the panel; `opts` says what Freed's tabs do (none open / open and answer / open, silent). */
  const open = async (page: Page, opts: { appTabs?: { id: number }[]; answers?: boolean; ids?: string[] } = {}) => {
    await page.addInitScript((o) => {
      (window as any).__opts = o;
    }, opts);
    await page.goto(PANEL_URL);
    await expect(page.locator("#list li")).toHaveCount(5);
  };
  const setLibrary = (page: Page, ids: string[], at = Date.now()) =>
    page.evaluate(([i, t]) => (window as any).__setLibrary({ ids: i, at: t }), [ids, at] as const);

  test("Freed isn't open: says so, offers to open it, marks nothing, blocks nothing", async ({ page }) => {
    await open(page);
    await expect(page.locator("#syncNote")).toContainText("Freed isn't open in a tab");
    await expect(page.locator("#openApp")).toHaveText("Open Freed");
    await expect(page.locator(".badge")).toHaveCount(0);
    await page.getByRole("button", { name: "Select shown" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 5 to Freed");
    await page.locator("#openApp").click();
    expect(await page.evaluate(() => (window as any).__created)).toEqual([`${APP}added`]);
  });

  test("a Freed tab that was already open: the panel puts the bridge in and gets the marks by itself", async ({ page }) => {
    await open(page, { appTabs: [{ id: 7 }], answers: true, ids: [IDS[1], IDS[3]] });
    await expect(page.locator(".badge")).toHaveCount(2);
    await expect(page.locator("#syncNote")).toContainText("Freed says you've added 2 videos");
    expect(await page.evaluate(() => (window as any).__injected)).toEqual([7]);
    await expect(page.locator("#openApp")).toHaveText("↻ Refresh");
    await expect(page.locator("#openApp")).toBeEnabled(); // the first check has finished
    await page.locator("#openApp").click(); // asks again
    await expect.poll(() => page.evaluate(() => (window as any).__injected)).toEqual([7, 7]);
  });

  test("a Freed tab that doesn't answer (old version): says so and offers to reload it", async ({ page }) => {
    await open(page, { appTabs: [{ id: 7 }] }); // open, but nobody answers the bridge
    await expect(page.locator("#syncNote")).toContainText("didn't answer");
    await expect(page.locator("#openApp")).toHaveText("Reload Freed tab");
    await page.locator("#openApp").click();
    expect(await page.evaluate(() => (window as any).__reloaded)).toEqual([7]);
  });

  test("added reels get a green ✓ Added mark, are dimmed, can't be ticked, and are counted", async ({ page }) => {
    await open(page);
    await setLibrary(page, [IDS[1], IDS[3]]);
    await expect(page.locator(".badge")).toHaveCount(2);
    await expect(page.locator(".badge").first()).toHaveText("✓ Added");
    await expect(page.locator("#list li.added")).toHaveCount(2);
    for (const li of await page.locator("#list li.added").all()) await expect(li.locator("input")).toBeDisabled();
    await expect(page.locator("#status")).toContainText("2 already added · 3 not added yet");
    await expect(page.locator("#syncNote")).toContainText("Freed says you've added 2 videos");
    // the marked ones really are the two sent
    await expect(page.locator("#list li.added")).toContainText(["Reel title 2", "Reel title 4"]);
  });

  test('"Marks not showing? Details" tells what the panel sees, with sample ids from both sides', async ({ page }) => {
    await open(page, { appTabs: [{ id: 7 }], answers: true, ids: [IDS[1], IDS[3]] });
    await expect(page.locator(".badge")).toHaveCount(2);
    await page.getByText("Marks not showing? Details").click();
    const text = page.locator("#diagText");
    await expect(text).toContainText("Extension version: 9.9.9");
    await expect(text).toContainText("Freed tabs found: 1   (check: ok)");
    await expect(text).toContainText("videos it reports: 2");
    await expect(text).toContainText(`Freed's ids (first 3): ${IDS[1]}, ${IDS[3]}`);
    await expect(text).toContainText("Reels on this page: 5   · marked as added: 2");
    await expect(text).toContainText(`This page's ids (first 3): ${IDS.slice(0, 3).join(", ")}`);
  });

  test("Select shown skips the added ones; Add sends only the new ones", async ({ page }) => {
    await open(page);
    await setLibrary(page, [IDS[1], IDS[3]]);
    await page.getByRole("button", { name: "Select shown" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 3 to Freed");
    await page.locator("#sendBtn").click();
    const urls = await page.evaluate(() => (window as any).__created);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`${APP}added#add=${[IDS[0], IDS[2], IDS[4]].join(",")}`);
  });

  test("Select top 60 new picks only reels that aren't added yet, most viewed first", async ({ page }) => {
    await open(page);
    await setLibrary(page, [IDS[1], IDS[3]]);
    await page.getByRole("button", { name: "Select top 60 new" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 3 to Freed"); // 5 reels, 2 already added
    await expect(page.locator("#list li.added input:checked")).toHaveCount(0);
    await setLibrary(page, [IDS[0], IDS[1], IDS[2], IDS[3]]);
    await page.getByRole("button", { name: "Select top 60 new" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 1 to Freed");
  });

  test("a long list (450 reels) is drawn 400 at a time; Select top 60 and the filters still use all of them", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any;
      const reels = Array.from({ length: 450 }, (_, i) => ({
        id: String(1000000000 + i),
        views: (i + 1) * 1000,
        viewsText: "",
        thumb: "",
        pos: i,
      }));
      const snap = {
        t: "reels",
        key: "/big/",
        running: false,
        cap: 5000,
        page: { name: "Big", url: "https://www.facebook.com/big/", reelsTab: true },
        reels,
      };
      w.chrome.tabs.sendMessage = async () => snap; // (this runs after the base setup above)
    });
    await page.goto(PANEL_URL);
    await expect(page.locator("#list li")).toHaveCount(401); // 400 reels and the "Show more" row
    await expect(page.locator("#counts")).toContainText("450 shown");
    await page.getByRole("button", { name: /^Show 50 more/ }).click();
    await expect(page.locator("#list li")).toHaveCount(450);
    await page.getByRole("button", { name: "Select top 60 new" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 60 to Freed");
    await page.locator("#minViews").fill("400K");
    await expect(page.locator("#list li")).toHaveCount(51);
  });

  test("the guard's note and meter show in the panel; the button stays off while it asks for a break", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any;
      const reels = Array.from({ length: 5 }, (_, i) => ({ id: String(2000000000 + i), views: 1000, viewsText: "", thumb: "", pos: i }));
      const guard = {
        reels: 1240,
        ms: 12 * 60000,
        cooldownUntil: Date.now() + 8 * 60000,
        limits: { dayReels: 3000, dayMs: 30 * 60000, steps: 150 },
        note: { level: "stop", text: "Take a break: you can use Keep scrolling again in 8 min." },
      };
      const snap = {
        t: "reels",
        key: "/g/",
        running: false,
        cap: 5000,
        page: { name: "G", url: "https://www.facebook.com/g/", reelsTab: true },
        reels,
        guard,
      };
      w.chrome.tabs.sendMessage = async () => snap;
    });
    await page.goto(PANEL_URL);
    await expect(page.locator("#guardNote")).toContainText("Take a break");
    await expect(page.locator("#guardMeter")).toContainText("1,240 of 3,000 reels · 12 of 30 min");
    await expect(page.locator("#scrollBtn")).toBeDisabled();
  });

  test("the Show filter: all / not added yet / already added", async ({ page }) => {
    await open(page);
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

  test("it updates the moment Freed reports a change, even for a reel you had ticked", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Select shown" }).click();
    await expect(page.locator("#sendBtn")).toHaveText("Add 5 to Freed");
    await setLibrary(page, [IDS[2]]); // you finished adding one in Freed
    await expect(page.locator("#sendBtn")).toHaveText("Add 4 to Freed"); // it came off the selection
    await expect(page.locator("#list li.added")).toHaveCount(1);
    await setLibrary(page, []); // …and deleted it there
    await expect(page.locator(".badge")).toHaveCount(0);
    await expect(page.locator("#syncNote")).toContainText("added 0 videos");
  });
});
