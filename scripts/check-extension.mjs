/**
 * Checks the browser extension for real: starts Microsoft Edge (or another Chromium) with a throwaway
 * profile and the extension loaded from `extension/`, opens Reel Feed with one added video in its saved
 * data, and verifies the whole chain: the app announces it → the bridge script stores it → the side
 * panel connects and marks that reel "✓ Added". Nothing of your own browser profile is touched.
 *
 *   npm run check:extension                       (uses the live site)
 *   APP=http://localhost:4174/ npm run check:extension
 *   BROWSER="C:/path/to/msedge.exe" npm run check:extension
 *
 * Needs Edge (or Chromium) installed. Chrome 137+ ignores --load-extension, so it can't be used here.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const APP = process.env.APP ?? "https://reel-feed.robiulhr2201.workers.dev/";
const EXE = process.env.BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const EXT = resolve("extension");
const ID = "2166091230582141";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "reel-feed-ext-")), {
  executablePath: EXE,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
  const extId = new URL(sw.url()).host;
  const version = await sw.evaluate(() => chrome.runtime.getManifest().version);
  console.log(`extension ${extId}, version ${version}; app ${APP}`);

  // 1. the app, with one added video in its saved data (only in this throwaway profile)
  const app = await ctx.newPage();
  await app.goto(APP);
  await app.evaluate((id) => {
    const k = "ecomgy-reel-feed.v1";
    const s = JSON.parse(localStorage.getItem(k) || "{}");
    s.manual = [
      {
        id,
        url: `https://www.facebook.com/reel/${id}/`,
        t: "Check",
        note: "",
        by: "",
        cats: ["ads"],
        lists: [],
        lg: "en",
        at: Math.floor(Date.now() / 1000),
        v: 1,
        l: 1,
      },
    ];
    localStorage.setItem(k, JSON.stringify(s));
  }, ID);
  await app.reload();
  await sleep(6000);
  const lib = (await sw.evaluate(() => chrome.storage.local.get("library"))).library;
  check(JSON.stringify(lib?.ids) === JSON.stringify([ID]), "the app's list reached the extension", JSON.stringify(lib));

  // 2. the panel (opened as a tab here): it must find the open Reel Feed tab and show the answer
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await sleep(4000);
  const st = await panel.evaluate(() => ({ link, added: [...added], tabs: appTabIds.length }));
  check(st.link === "ok" && st.tabs >= 1 && st.added.includes(ID), "the panel connected to the open Reel Feed tab", JSON.stringify(st));

  // 3. pretend the panel is looking at a Reels page with 3 reels, one of them added
  await panel.evaluate((id) => {
    data = {
      t: "reels",
      key: "/x/",
      running: false,
      cap: 300,
      page: { name: "X", url: "x", reelsTab: true },
      reels: [id, "752115997659579", "1168298751995880"].map((r, i) => ({
        id: r,
        views: (i + 1) * 1000,
        viewsText: "",
        thumb: "",
        pos: i,
      })),
    };
    draw();
  }, ID);
  await sleep(500);
  const ui = await panel.evaluate(() => ({
    badges: document.querySelectorAll(".badge").length,
    status: document.getElementById("status").textContent,
  }));
  check(ui.badges === 1 && ui.status.includes("1 already added"), "the panel marks exactly the added reel", JSON.stringify(ui));

  // 4. a real Facebook Reels page. Optional: a fresh browser may get a login wall instead of reels.
  const fb = await ctx.newPage();
  await fb.goto("https://www.facebook.com/nike/reels/");
  await sleep(7000);
  await fb.bringToFront();
  await panel.evaluate(() => refresh()); // looks at the active tab (the Facebook page): puts the collector in, reads the reels
  await sleep(3000);
  const found = await panel.evaluate(() => (data?.reels ?? []).map((r) => r.id));
  if (!found.length) {
    console.log("- skipped the real Facebook page: no reels were shown to this fresh browser (login wall?)");
  } else {
    check(
      found.every((x) => /^\d{5,25}$/.test(x)),
      `the collector read ${found.length} real reel ids from Facebook`,
      found.slice(0, 3).join(", "),
    );
    // add the first one in the app, then look again
    await app.bringToFront();
    await app.evaluate((id) => {
      const k = "ecomgy-reel-feed.v1";
      const s = JSON.parse(localStorage.getItem(k) || "{}");
      s.manual = [
        {
          id,
          url: `https://www.facebook.com/reel/${id}/`,
          t: "Check",
          note: "",
          by: "",
          cats: ["ads"],
          lists: [],
          lg: "en",
          at: Math.floor(Date.now() / 1000),
          v: 1,
          l: 1,
        },
      ];
      localStorage.setItem(k, JSON.stringify(s));
    }, found[0]);
    await app.reload();
    await sleep(5000);
    await fb.bringToFront();
    await panel.evaluate(() => refresh());
    await sleep(2500);
    const real = await panel.evaluate(
      (first) => ({
        badges: document.querySelectorAll(".badge").length,
        marked: [...document.querySelectorAll("#list li.added")].length,
        first,
        added: [...added],
      }),
      found[0],
    );
    check(real.badges === 1 && real.added[0] === found[0], "the real Facebook reel you added is marked ✓ Added", JSON.stringify(real));
  }
} finally {
  await ctx.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
