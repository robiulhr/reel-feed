/**
 * Browser-test setup: every network request is answered by the test itself.
 *  - Shorts data → small made-up library (tests/fixtures/data.ts)
 *  - YouTube player → a fake YT.Player that behaves like the real one (states, time, speed, volume)
 *  - thumbnails → a tiny image
 *  - sync server (http://sync.test) → an in-memory fake that counts every change it receives
 */
import { test as base, expect, type Page } from "@playwright/test";
import { asFile, makeDataset } from "../fixtures/data";

const FAKE_YT = `
(function () {
  var S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  window.__yt = { players: [] };
  function Player(id, o) {
    var holder = document.getElementById(id);
    var f = document.createElement('iframe');
    f.src = 'about:blank';
    holder.replaceWith(f);
    this.f = f; this.o = o; this.t = 0; this.rate = 1; this.vol = 100; this.muted = true;
    this.state = -1; this.vid = null; this.last = 0;
    window.__yt.players.push(this);
    var self = this;
    setTimeout(function () { o.events && o.events.onReady && o.events.onReady({ target: self }); if (o.videoId) self.loadVideoById({ videoId: o.videoId, startSeconds: (o.playerVars && o.playerVars.start) || 0 }); }, 0);
  }
  Player.prototype._set = function (s) { this.state = s; var e = this.o.events; e && e.onStateChange && e.onStateChange({ data: s, target: this }); };
  Player.prototype._tick = function () { if (this.state === 1) { var n = performance.now(); this.t = Math.min(60, this.t + (n - this.last) / 1000 * this.rate); this.last = n; } };
  Player.prototype.loadVideoById = function (a) { var self = this; var id = typeof a === 'object' ? a.videoId : a; this.vid = id; this.f.dataset.vid = id; this.t = (typeof a === 'object' && a.startSeconds) || 0; this._set(3); setTimeout(function () { self.last = performance.now(); self._set(1); }, 30); };
  Player.prototype.playVideo = function () { this.last = performance.now(); this._set(1); };
  Player.prototype.pauseVideo = function () { this._tick(); this._set(2); };
  Player.prototype.seekTo = function (t) { this._tick(); this.t = t; };
  Player.prototype.getCurrentTime = function () { this._tick(); return this.t; };
  Player.prototype.getDuration = function () { return this.vid ? 60 : 0; };
  Player.prototype.mute = function () { this.muted = true; };
  Player.prototype.unMute = function () { this.muted = false; };
  Player.prototype.isMuted = function () { return this.muted; };
  Player.prototype.setVolume = function (v) { this.vol = v; };
  Player.prototype.getVolume = function () { return this.vol; };
  Player.prototype.setPlaybackRate = function (r) { this._tick(); this.rate = r; };
  Player.prototype.getPlaybackRate = function () { return this.rate; };
  Player.prototype.destroy = function () {};
  window.YT = { Player: Player, PlayerState: S };
  setTimeout(function () { window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); }, 0);
})();`;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export interface FakeSync {
  channelPosts: { ops: any[] }[];
  statePuts: number;
  channels: any[];
  lookups: number;
  /** Earlier versions of the synced data (GitHub commit history), oldest first. Every PUT adds one. */
  versions: { sha: string; at: number; msg: string; data: any }[];
}

export const test = base.extend<{ app: Page; sync: FakeSync }>({
  sync: async ({}, use) => {
    await use({
      channelPosts: [],
      statePuts: 0,
      lookups: 0,
      versions: [],
      channels: [
        { name: "Alpha Biz", handle: "@alpha", cat: "stories" },
        { name: "Ads Lab", handle: "@ads", cat: "ads" },
        { name: "Founder Talk", handle: "@founder", cat: "founders" },
      ],
    });
  },
  app: async ({ page, sync }, use) => {
    const file = asFile(makeDataset());
    await page.route("**/data/meta.json", (r) => r.fulfill({ json: { generatedAt: file.generatedAt, videos: file.videos.length } }));
    await page.route("**/data/starter.json", (r) => r.fulfill({ json: file }));
    await page.route("**/data/shorts.json", (r) => r.fulfill({ json: file }));
    // long videos: the first videos of the library again, with other ids and a length in seconds
    const longFile = {
      ...file,
      videos: file.videos
        .slice(0, 8)
        .map((v: unknown[], i: number) => [...v.slice(0, 14), 600 + i * 937])
        .map((v, i) => [`longvid${String(i).padStart(4, "0")}`, ...v.slice(1)]),
    };
    await page.route("**/data/long.json", (r) => r.fulfill({ json: longFile }));
    // these tests are about the Shorts feed: it opens first, as the "Open on" choice would make it (home.spec.ts picks Home)
    await page.addInitScript(() => {
      if (localStorage.getItem("rf.openOn") === null) localStorage.setItem("rf.openOn", "feed");
    });
    await page.route("https://www.youtube.com/iframe_api", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_YT }));
    await page.route("https://i.ytimg.com/**", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
    await page.route("https://fonts.googleapis.com/**", (r) => r.abort());

    let state: any = null;
    let stateSha = 0;
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    };
    await page.route("http://sync.test/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const method = req.method();
      const ok = (json: unknown) => route.fulfill({ status: 200, headers: cors, json });
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (path === "/login") {
        return req.postDataJSON().password === "pw"
          ? ok({ session: "test.session" })
          : route.fulfill({ status: 401, headers: cors, json: { error: "Wrong password" } });
      }
      if (path === "/state" && method === "GET") return ok({ data: state, sha: state ? `s${stateSha}` : null });
      if (path === "/state" && method === "PUT") {
        sync.statePuts++;
        state = req.postDataJSON().data;
        stateSha++;
        sync.versions.push({ sha: String(stateSha).padStart(40, "0"), at: Date.now(), msg: "Sync from test", data: state });
        return ok({ sha: `s${stateSha}` });
      }
      // the same data file, passed through as encoded text (what the app uses now)
      const enc = (d: unknown) => Buffer.from(JSON.stringify(d), "utf8").toString("base64");
      if (path === "/state2" && method === "GET") return ok({ content: state ? enc(state) : null, sha: state ? `s${stateSha}` : null });
      if (path === "/state2" && method === "PUT") {
        const body = req.postDataJSON();
        sync.statePuts++;
        state = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
        stateSha++;
        sync.versions.push({ sha: String(stateSha).padStart(40, "0"), at: Date.now(), msg: "Sync from test", data: state });
        return ok({ sha: `s${stateSha}` });
      }
      if (path === "/state/at2" && method === "GET") {
        const v = sync.versions.find((x) => x.sha === new URL(req.url()).searchParams.get("sha"));
        return v ? ok({ content: enc(v.data) }) : route.fulfill({ status: 404, headers: cors, json: { error: "Unknown version" } });
      }
      if (path === "/state/versions" && method === "GET")
        return ok({ versions: [...sync.versions].reverse().map(({ sha, at, msg }) => ({ sha, at, msg })) });
      if (path === "/state/at" && method === "GET") {
        const v = sync.versions.find((x) => x.sha === new URL(req.url()).searchParams.get("sha"));
        return v ? ok({ data: v.data }) : route.fulfill({ status: 404, headers: cors, json: { error: "Unknown version" } });
      }
      if (path === "/channels" && method === "GET") return ok({ data: sync.channels, sha: "c" });
      if (path === "/channels" && method === "POST") {
        const { ops } = req.postDataJSON();
        sync.channelPosts.push({ ops });
        for (const op of ops) {
          const c = sync.channels.find((x) => x.handle.toLowerCase() === (op.h ?? op.channel?.handle ?? "").toLowerCase());
          if (op.t === "add" && !c) sync.channels.push({ ...op.channel });
          if (op.t === "remove" && c) c.status = "removed";
          if (op.t === "restore" && c) delete c.status;
          if (op.t === "cat" && c) c.cat = op.cat;
          if (op.t === "delete" && c) sync.channels.splice(sync.channels.indexOf(c), 1);
        }
        return ok({ data: sync.channels });
      }
      if (path === "/lookup") {
        sync.lookups++;
        return ok({
          needsSearch: false,
          units: 3,
          quota: { used: 3, budget: 3000 },
          results: [
            {
              id: "UCpricing00000000000000a",
              name: "Pricing Lab",
              handle: "@pricinglab",
              thumb: "",
              subs: 54321,
              videos: 400,
              desc: "Pricing psychology",
              shorts: 70,
              latestShort: Math.floor(Date.now() / 1000) - 3600,
              suggestedCat: "ads",
            },
          ],
        });
      }
      if (path === "/quota")
        return ok({
          enabled: true,
          day: "2026-01-01",
          used: 0,
          budget: 3000,
          reserve: 1500,
          limit: 10000,
          maxBudget: 8500,
          savedWeek: 0,
          usedWeek: 0,
          recent: [],
        });
      if (path === "/status") return ok({ run: null });
      if (path === "/refresh") return ok({ ok: true });
      return route.fulfill({ status: 404, headers: cors, json: { error: "Not found" } });
    });

    await page.goto("/");
    await expect(page.locator("#title")).not.toBeEmpty();
    await use(page);
  },
});

export { expect };

// ---------- helpers ----------
export async function closeTips(page: Page) {
  const ok = page.locator("#tipsOk");
  if (await ok.isVisible()) await ok.click();
}

/** Swipe on the video with real touch events (up = next, down = previous, left = channel). */
export async function swipe(page: Page, dir: "up" | "down" | "left") {
  await page.evaluate((dir) => {
    const tap = document.getElementById("tap")!;
    const r = tap.getBoundingClientRect();
    const cx = r.left + r.width / 2,
      cy = r.top + r.height / 2;
    const [x0, y0, x1, y1] =
      dir === "up" ? [cx, cy + 150, cx, cy - 150] : dir === "down" ? [cx, cy - 150, cx, cy + 150] : [cx + 120, cy, cx - 120, cy + 5];
    const T = (x: number, y: number) => new Touch({ identifier: 1, target: tap, clientX: x, clientY: y });
    tap.dispatchEvent(new TouchEvent("touchstart", { touches: [T(x0, y0)], changedTouches: [T(x0, y0)], bubbles: true }));
    for (let i = 1; i <= 5; i++) {
      tap.dispatchEvent(new TouchEvent("touchmove", { touches: [T(x0 + ((x1 - x0) * i) / 5, y0 + ((y1 - y0) * i) / 5)], bubbles: true }));
    }
    tap.dispatchEvent(new TouchEvent("touchend", { changedTouches: [T(x1, y1)], bubbles: true }));
  }, dir);
  await page.waitForTimeout(400);
}

/** The fake player that's currently visible. */
export async function player(page: Page) {
  return page.evaluate(() => {
    const p = (window as any).__yt.players.find((x: any) => x.f.closest(".yt-slot")?.classList.contains("on"));
    return p ? { t: p.getCurrentTime(), rate: p.rate, vol: p.vol, muted: p.muted, vid: p.vid, state: p.state } : null;
  });
}

/**
 * Opens a Menu page the way a person does: opens the Menu if it's closed, goes back to its home screen
 * if a page is showing, then taps the page's card.
 */
export async function menuPage(page: Page, tab: string) {
  if (!(await page.locator("#closePanel").isVisible())) await page.locator("#menuBtn").click();
  const back = page.locator("#panelBack");
  if (await back.isVisible()) await back.click();
  if (tab === "added") {
    // the videos you added now live in Channels & pages → Facebook → Videos you added
    await page.locator('#panelBody [data-p="channels"]').click();
    await page.locator("#panelBody").getByRole("button", { name: "📘 Facebook" }).click();
    await page.locator("#panelBody").getByRole("button", { name: "Videos you added" }).click();
    return;
  }
  if (tab === "youtube") {
    // the YouTube channel tools (add, refresh, status filter) are under Channels & pages → 📺 YouTube
    await page.locator('#panelBody [data-p="channels"]').click();
    await page.locator("#panelBody").getByRole("button", { name: "📺 YouTube" }).click();
    return;
  }
  await page.locator(`#panelBody [data-p="${tab}"]`).click();
}

export async function login(page: Page) {
  await page.locator("#menuBtn").click();
  await menuPage(page, "sync");
  await page.locator('#panelBody input[name="password"]').fill("pw");
  await page.locator("#panelBody form button[type=submit]").click();
  await expect(page.locator("#panelBody")).toContainText("This device is logged in");
}

/** Wait until the app's history has been still for 300 ms. Closing a dialog steps Back in history; if
 *  that Back lands while a test navigates, the browser cancels the navigation (net::ERR_ABORTED). */
export async function settled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        let t = setTimeout(done, 300);
        addEventListener("popstate", () => {
          clearTimeout(t);
          t = setTimeout(done, 300);
        });
      }),
  );
}

async function again<T>(run: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= 2 || !String(e).includes("ERR_ABORTED")) throw e;
    }
  }
}

/** page.goto, after the history settles (and once more if it was cancelled anyway). */
export async function goTo(page: Page, url: string) {
  await settled(page);
  return again(() => page.goto(url));
}

/** page.reload, the same way. */
export async function reload(page: Page) {
  await settled(page);
  return again(() => page.reload());
}

/** Opens the app's start address. A load that is still finishing from the page before can abort this one (net::ERR_ABORTED): try again once. */
export async function gotoStart(page: Page) {
  try {
    await page.goto("/");
  } catch {
    await page.waitForTimeout(300);
    await page.goto("/");
  }
}
