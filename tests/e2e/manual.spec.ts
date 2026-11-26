import type { Page } from "@playwright/test";
import { asFile, makeDataset } from "../fixtures/data";
import { closeTips, expect, goTo, menuPage, test } from "./fixtures";
/** Facebook's player SDK, faked: one controllable player per video (play, pause, sound, position). */
const FAKE_FB = `
(function () {
  window.__fb = { players: [] };
  var ready = null;
  window.FB = {
    init: function () {},
    Event: { subscribe: function (name, fn) { if (name === 'xfbml.ready') ready = fn; } },
    XFBML: {
      parse: function (el) {
        var box = el.querySelector('.fb-video');
        var f = document.createElement('iframe');
        f.src = 'about:blank';
        f.style.visibility = 'visible'; // like Facebook's own frame
        f.dataset.href = box.dataset.href;
        box.append(f);
        var subs = {};
        var p = {
          href: box.dataset.href, playing: false, muted: true, t: 0,
          subscribe: function (n, fn) { (subs[n] = subs[n] || []).push(fn); return { release: function () {} }; },
          emit: function (n) { (subs[n] || []).forEach(function (fn) { fn(); }); },
          play: function () { var self = this; this.playing = true; this.emit('startedPlaying'); this.emit('startedBuffering'); setTimeout(function () { self.emit('finishedBuffering'); }, 50); },
          pause: function () { this.playing = false; this.emit('paused'); },
          mute: function () { this.muted = true; }, unmute: function () { this.muted = false; },
          setVolume: function () {}, seek: function (t) { this.t = t; },
          getCurrentPosition: function () { return this.t; }, getDuration: function () { return 30; },
          getIframe: function () { return f; }
        };
        window.__fb.players.push(p);
        setTimeout(function () { ready && ready({ type: 'video', id: box.id, instance: p }); }, 10);
      }
    }
  };
  setTimeout(function () { window.fbAsyncInit && window.fbAsyncInit(); }, 0);
})();`;

const META = {
  id: "1141407915517139",
  url: "https://www.facebook.com/reel/1141407915517139/",
  title: "Hide the price, lose the sale",
  caption: "Hide the price, lose the sale\n#fcommerce #onlinebusiness #sales",
  views: 65000,
  reactions: 1100,
  page: { name: "Boost Marketing", path: "/61595841376442" },
  embeddable: true,
  cats: ["sales", "ecom"],
};

test.describe("Facebook videos you add by link", () => {
  test.beforeEach(async ({ app: page }) => {
    await page.route("https://connect.facebook.net/**", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_FB }));
    await page.route("**/api/fb/meta**", (r) => r.fulfill({ json: META }));
    await page.route("**/api/fb/thumb/**", (r) => r.fulfill({ status: 404, body: "" }));
  });

  test("several Freed tabs open at once: nothing one tab added is lost when another saves", async ({ app: page }) => {
    test.setTimeout(90_000); // three tabs at once: slow on a small CI machine
    const file = asFile(makeDataset());
    // every tab answers lookups with the video number in the link
    const routesFor = async (p: Page) => {
      await p.route("**/data/meta.json", (r) => r.fulfill({ json: { generatedAt: file.generatedAt, videos: file.videos.length } }));
      await p.route("**/data/starter.json", (r) => r.fulfill({ json: file }));
      await p.route("**/data/shorts.json", (r) => r.fulfill({ json: file }));
      await p.route("https://www.youtube.com/**", (r) => r.abort());
      await p.route("https://fonts.googleapis.com/**", (r) => r.abort());
      await p.route("**/api/fb/thumb/**", (r) => r.fulfill({ status: 404, body: "" }));
      await p.route("**/api/fb/meta**", (r) => {
        const id = /reel\/(\d+)/.exec(new URL(r.request().url()).searchParams.get("url") ?? "")?.[1] ?? "0";
        return r.fulfill({ json: { ...META, id, url: `https://www.facebook.com/reel/${id}/`, title: `Reel ${id}` } });
      });
    };
    const add = async (p: Page, id: string) => {
      if (!(await p.locator("#closePanel").isVisible())) await p.locator("#menuBtn").click(); // (the Menu may still be open)
      await menuPage(p, "added");
      await p.locator("#panelBody").getByRole("button", { name: "＋ Add a Facebook video" }).click();
      const dlg = p.locator(".dlg");
      await dlg.getByLabel("Facebook video link").fill(`https://www.facebook.com/reel/${id}/`);
      await dlg.getByLabel("Facebook video link").press("Enter");
      await expect(dlg).toContainText("Found:");
      const sales = dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ });
      if ((await sales.getAttribute("aria-pressed")) !== "true") await sales.click();
      await dlg.getByRole("button", { name: "Add", exact: true }).click();
      await expect(dlg).toBeHidden();
      await expect(p.locator(".fb-card").filter({ hasText: `Reel ${id}` })).toBeVisible();
    };

    await routesFor(page);
    await closeTips(page);
    // a second tab, opened while the first has nothing yet (so it never hears about the first one's video)
    const tab2 = await page.context().newPage();
    await routesFor(tab2);
    await tab2.goto("/");
    await expect(tab2.locator("#title")).not.toBeEmpty();
    await closeTips(tab2);

    await add(page, "1111111111"); // tab 1
    await add(tab2, "2222222222"); // tab 2 (didn't know about the first)
    await add(page, "3333333333"); // tab 1 again: used to save its old copy over tab 2's video

    // tab 1 shows tab 2's video without a reload (the tabs tell each other)…
    await expect(page.locator(".fb-card")).toHaveCount(3);
    // …and a brand new tab has all three
    const tab3 = await page.context().newPage();
    await routesFor(tab3);
    await tab3.goto("/");
    await expect(tab3.locator("#title")).not.toBeEmpty();
    await closeTips(tab3);
    await tab3.locator("#menuBtn").click();
    await menuPage(tab3, "added");
    await expect(tab3.locator(".fb-card")).toHaveCount(3);
    for (const id of ["1111111111", "2222222222", "3333333333"])
      await expect(tab3.locator(".fb-card").filter({ hasText: `Reel ${id}` })).toBeVisible();
    await tab2.close();
    await tab3.close();
  });

  test("the app tells the browser extension which videos are added (add, delete, and when it says hello)", async ({ app: page }) => {
    await closeTips(page);
    // listen like the extension's bridge does
    await page.evaluate(() => {
      (window as any).__lib = [];
      addEventListener("message", (e) => {
        if (e.source === window && e.data?.source === "reel-feed-app" && e.data.t === "library") (window as any).__lib.push(e.data.ids);
      });
    });
    const last = () => page.evaluate(() => (window as any).__lib.at(-1) ?? null);
    const hello = () => page.evaluate(() => window.postMessage({ source: "reel-feed-ext", t: "hello" }, location.origin));

    await hello(); // the extension was installed after the app opened
    await expect.poll(last).toEqual([]);

    await page.locator("#menuBtn").click();
    await menuPage(page, "added");
    await page.locator("#panelBody").getByRole("button", { name: "＋ Add a Facebook video" }).click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Facebook video link").fill(META.url);
    await dlg.getByLabel("Facebook video link").press("Enter");
    await expect(dlg).toContainText("Found: Boost Marketing");
    const sales = dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ });
    if ((await sales.getAttribute("aria-pressed")) !== "true") await sales.click();
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dlg).toBeHidden();
    await expect.poll(last).toEqual([META.id]); // sent right after adding, nothing asked for

    await page.locator(".fb-card").getByRole("button", { name: "Delete" }).click();
    await page.locator(".dlg").getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(last).toEqual([]);
    // only the public video numbers are in the message
    expect(JSON.stringify(await last())).not.toMatch(/Boost|note|http/i);
  });

  test("paste a link → filled in → plays in the feed → save, unsave, edit, delete", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "added");
    await expect(page).toHaveURL(/\/channels$/);
    await page.locator("#panelBody").getByRole("button", { name: "＋ Add a Facebook video" }).click();

    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Facebook video link").fill("https://www.facebook.com/share/v/1CwWegbMzR/");
    await dlg.getByLabel("Facebook video link").press("Enter");
    await expect(dlg).toContainText("Found: Boost Marketing · 65K views · 1.1K reactions");
    await expect(dlg.getByLabel("Title")).toHaveValue("Hide the price, lose the sale");
    await expect(dlg.getByLabel("Page name")).toHaveValue("Boost Marketing");
    await expect(dlg.getByLabel("Page link")).toHaveValue("https://www.facebook.com/61595841376442");
    await dlg.getByLabel("Note (only you see it)").fill("Price transparency hook");
    // a category is needed (the guess may already have picked some)
    const sales = dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ });
    if ((await sales.getAttribute("aria-pressed")) !== "true") await sales.click();
    await dlg.getByRole("button", { name: "🎯 Competitors" }).click();
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dlg).toBeHidden();

    // the Added page
    const card = page.locator(".fb-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Hide the price, lose the sale");
    await expect(card).toContainText("Boost Marketing");
    await expect(card).toContainText("Price transparency hook");

    // plays in the feed, in Facebook's player, driven by the app's controls
    await page.getByRole("button", { name: "▶ Play these 1" }).click();
    await expect(page.locator("#chName")).toHaveText("Boost Marketing");
    await expect(page.locator(".fb-slot.on iframe")).toHaveAttribute("data-href", META.url);
    await expect.poll(() => page.evaluate(() => (window as any).__fb.players.at(-1).playing)).toBe(true);
    await expect(page.locator("#spinner")).toBeHidden(); // buffering finished: no spinner left over the video
    await page.locator("#tap").click({ position: { x: 150, y: 300 } });
    await expect.poll(() => page.evaluate(() => (window as any).__fb.players.at(-1).playing)).toBe(false);
    // sound on while paused, then play: it starts muted and the sound comes on once it plays
    await page.locator("#muteBtn").click();
    await page.locator("#tap").click({ position: { x: 150, y: 300 } });
    const fbp = () =>
      page.evaluate(() => {
        const p = (window as any).__fb.players.at(-1);
        return { playing: p.playing, muted: p.muted };
      });
    await expect.poll(fbp).toEqual({ playing: true, muted: false });
    await page.locator("#tap").click({ position: { x: 150, y: 300 } });
    await expect.poll(() => page.evaluate(() => (window as any).__fb.players.at(-1).playing)).toBe(false);
    await expect(page.locator("#meta")).toContainText("f Facebook");

    // ⋯ has Facebook's own options
    await page.locator("#moreBtn").click();
    await expect(page.getByRole("button", { name: "↗ Open video on Facebook" })).toBeVisible();
    await expect(page.getByRole("button", { name: "↗ Open page on Facebook" })).toBeVisible();
    await expect(page.getByRole("button", { name: "✨ More like this" })).toBeHidden();
    await page.getByRole("button", { name: "Cancel" }).click();

    // save it → Saved (its own Facebook chip, and the Competitors tab); Added is a separate list
    await page.locator("#saveBtn").click();
    await page.locator("#ctxBack").click(); // ← leaves the "Added" list: the Added page comes back
    await expect(page.locator(".fb-card")).toHaveCount(1);
    await menuPage(page, "saved");
    await expect(page.getByRole("group", { name: "Source" }).getByRole("button", { name: "f Facebook · 1" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Channel list" }).getByRole("button", { name: "🎯 Competitors · 1" })).toBeVisible();
    await page.locator(".grid .card .x").click(); // unsave
    await expect(page.locator("#panelBody")).toContainText("No saved Shorts yet");
    await menuPage(page, "added");
    await expect(page.locator(".fb-card")).toHaveCount(1); // still added

    // edit the note
    await page.locator(".fb-card").getByRole("button", { name: "✎ Edit" }).click();
    await dlg.getByLabel("Note (only you see it)").fill("Use for the Black Friday reel");
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".fb-card")).toContainText("Use for the Black Friday reel");

    // delete (saved again first: deleting takes it out of Saved too)
    await page.locator(".fb-card").getByRole("button", { name: "♡ Save" }).click();
    await page.locator(".fb-card").getByRole("button", { name: "Delete" }).click();
    await page.locator(".dlg").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.locator(".fb-card")).toHaveCount(0);
    await menuPage(page, "saved");
    await expect(page.locator("#panelBody")).toContainText("No saved Shorts yet");
  });

  test("a list with only a video you added: its chip and Filters play it", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#moreBtn").click();
    await page.getByRole("button", { name: "＋ Add a Facebook video" }).click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Facebook video link").fill("https://www.facebook.com/reel/1141407915517139/");
    await dlg.getByLabel("Facebook video link").press("Enter");
    await expect(dlg).toContainText("Found: Boost Marketing");
    const sales = dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ });
    if ((await sales.getAttribute("aria-pressed")) !== "true") await sales.click();
    await dlg.getByRole("button", { name: "🎯 Competitors" }).click();
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("button", { name: "Competitors feed" })).toBeVisible();
    // the Filters sheet can pick it too
    await page.locator("#filtBtn").click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    await sheet.getByRole("button", { name: "🎯 Competitors · 1" }).click();
    const show = sheet.locator(".btn.primary");
    await expect(show).toHaveText(/^Show 1 Shorts?$/);
    await show.click();
    await expect(page.locator(".fb-slot.on iframe")).toHaveAttribute("data-href", META.url);
  });

  test("moving on from a Facebook video hides its player", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#moreBtn").click();
    await page.getByRole("button", { name: "＋ Add a Facebook video" }).click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Facebook video link").fill("https://www.facebook.com/reel/1141407915517139/");
    await dlg.getByLabel("Facebook video link").press("Enter");
    await expect(dlg).toContainText("Found: Boost Marketing");
    const sales = dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ });
    if ((await sales.getAttribute("aria-pressed")) !== "true") await sales.click();
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dlg).toBeHidden();
    await goTo(page, "/v/fb1141407915517139");
    const frame = page.locator(".fb-slot iframe");
    await expect(frame).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page).not.toHaveURL(/fb1141407915517139/);
    await expect(frame).toBeHidden();
  });

  test("adding a video you already added: a clear warning, Add stays off, and a way to it", async ({ app: page }) => {
    await closeTips(page);
    const open = async (link: string) => {
      await page.locator("#moreBtn").click();
      await page.getByRole("button", { name: "＋ Add a Facebook video" }).click();
      const dlg = page.locator(".dlg");
      await dlg.getByLabel("Facebook video link").fill(link);
      await dlg.getByLabel("Facebook video link").press("Enter");
      return dlg;
    };
    let dlg = await open("https://www.facebook.com/reel/1141407915517139/");
    await expect(dlg).toContainText("Found: Boost Marketing");
    const sales = dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ });
    if ((await sales.getAttribute("aria-pressed")) !== "true") await sales.click();
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dlg).toBeHidden();

    for (const link of ["https://www.facebook.com/reel/1141407915517139/?s=1", "https://www.facebook.com/share/v/1CwWegbMzR/"]) {
      dlg = await open(link);
      const warn = dlg.getByRole("alert");
      await expect(warn).toContainText("You already added this video");
      await expect(warn).toContainText("Boost Marketing");
      await expect(dlg.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await expect(dlg).toBeHidden();
    }
    dlg = await open("https://www.facebook.com/reel/1141407915517139/");
    await dlg.getByRole("alert").getByRole("button", { name: "✎ Edit it" }).click();
    await expect(page.getByRole("dialog", { name: "Edit Facebook video" })).toBeVisible();
  });

  test("a Facebook page has its own screen with its videos and a link to Facebook", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#moreBtn").click();
    await page.getByRole("button", { name: "＋ Add a Facebook video" }).click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Facebook video link").fill("https://www.facebook.com/reel/1141407915517139/");
    await dlg.getByLabel("Facebook video link").press("Enter");
    await expect(dlg).toContainText("Found: Boost Marketing");
    const sales = dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ });
    if ((await sales.getAttribute("aria-pressed")) !== "true") await sales.click();
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dlg).toBeHidden();

    await goTo(page, "/channel/fb%3A61595841376442");
    await expect(page.locator("#pageTitle")).toHaveText("Boost Marketing");
    await expect(page.getByRole("button", { name: "↗ Open page on Facebook" })).toBeVisible();
    await expect(page.locator("#pageBody .scard")).toHaveCount(1);

    // another video from this page: the page is filled in already, and it joins the same page
    await page.route("**/api/fb/meta**", (r) =>
      r.fulfill({ json: { ...META, id: "2222222222222", url: "https://www.facebook.com/reel/2222222222222/", title: "Second one" } }),
    );
    await page.getByRole("button", { name: "＋ Add a video from this page" }).click();
    await expect(dlg.getByLabel("Page name")).toHaveValue("Boost Marketing");
    await dlg.getByLabel("Facebook video link").fill("https://www.facebook.com/reel/2222222222222/");
    await dlg.getByLabel("Facebook video link").press("Enter");
    await expect(dlg.getByLabel("Title")).toHaveValue("Second one");
    await expect(dlg.getByLabel("Page name")).toHaveValue("Boost Marketing");
    const sales2 = dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ });
    if ((await sales2.getAttribute("aria-pressed")) !== "true") await sales2.click();
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator("#pageBody .scard")).toHaveCount(2);
    await page.locator("#pageBody .scard").filter({ hasNotText: "Second one" }).click();
    await expect(page.locator(".fb-slot.on iframe")).toHaveAttribute("data-href", META.url);
  });

  test("add several at once: title and caption on each, its own categories and lists, or set for all selected", async ({ app: page }) => {
    // each link looks up as its own video
    await page.route("**/api/fb/meta**", (r) => {
      const link = new URL(r.request().url()).searchParams.get("url") ?? "";
      const id = link.split("/reel/")[1]?.split("/")[0] ?? "0";
      const title = `Reel ${id}`;
      return r.fulfill({
        json: { ...META, id, url: `https://www.facebook.com/reel/${id}/`, title, caption: `${title}\nAbout ${id}`, cats: [] },
      });
    });
    await closeTips(page);

    // from the Added page: paste a message with one link in it
    await page.locator("#menuBtn").click();
    await menuPage(page, "added");
    await page.locator("#panelBody").getByRole("button", { name: "＋ Add several at once" }).click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Facebook video links").fill("look at this https://www.facebook.com/reel/1111111111/ nice");
    await dlg.getByRole("button", { name: "Look them up" }).click();
    const row1 = dlg.locator(".fbbulk-row");
    await expect(row1).toHaveCount(1);
    await expect(row1.locator(".fbbulk-title")).toHaveText("Reel 1111111111");
    await expect(row1.locator(".fbbulk-desc")).toHaveText("About 1111111111"); // the caption, without the title again
    await expect(row1).toContainText("No category yet");
    await expect(dlg.getByRole("button", { name: "Add 1" })).toBeDisabled();
    // its own category
    await row1.getByRole("button", { name: "Change categories and lists for Reel 1111111111" }).click();
    await row1
      .locator(".catpick")
      .getByRole("button", { name: /^Sales & Customers/ })
      .click();
    await dlg.getByRole("button", { name: "Add 1" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator(".fb-card")).toHaveCount(1);

    // the extension's hand-over: reel ids in the link
    await goTo(page, "/"); // so the next address is a full page load, like opening it from the extension
    await goTo(page, "/added#add=1111111111,2222222222,3333333333,4444444444");
    await expect(page).toHaveURL(/\/channels$/); // the ids are taken out of the address
    await expect(dlg.locator(".fbbulk-row")).toHaveCount(4);
    await expect(dlg.locator(".fbbulk-row.st-dup")).toContainText("Already added");
    await expect(dlg.locator(".fbbulk-row.st-ok")).toHaveCount(3);
    await expect(dlg.getByRole("checkbox", { name: "Add Reel 1111111111" })).toBeDisabled();
    await dlg.getByRole("checkbox", { name: "Add Reel 3333333333" }).uncheck(); // leave one out

    // for all selected: a category and a list
    const all = dlg.locator(".fbbulk-all");
    await all.getByText("Set categories & lists for all selected").click();
    const row2 = dlg.locator(".fbbulk-row").filter({ hasText: "Reel 2222222222" });
    const row4 = dlg.locator(".fbbulk-row").filter({ hasText: "Reel 4444444444" });
    await all
      .locator(".catpick")
      .getByRole("button", { name: /^Sales & Customers/ })
      .click();
    // no Apply click: the category is on both ticked videos at once
    await expect(row2.locator(".fbbulk-tags")).toContainText("Sales & Customers");
    await expect(row4.locator(".fbbulk-tags")).toContainText("Sales & Customers");
    await all.getByRole("button", { name: "🎯 Competitors" }).click(); // and so is the list
    await expect(row2.locator(".fbbulk-tags")).toContainText("Competitors");
    await expect(row4.locator(".fbbulk-tags")).toContainText("Competitors");
    await expect(all).toContainText("Put on 2 selected videos.");
    await expect(dlg.locator(".fbbulk-row").filter({ hasText: "Reel 3333333333" })).toContainText("No category yet");
    // then one on its own: not on that list
    await row4.getByRole("button", { name: "Change categories and lists for Reel 4444444444" }).click();
    await row4.locator(".fbbulk-edit").getByRole("button", { name: "🎯 Competitors" }).click();
    await row4.getByRole("button", { name: "Done with categories and lists for Reel 4444444444" }).click();
    await expect(row4.locator(".fbbulk-tags")).not.toContainText("Competitors");
    // watch one right here; watching another closes the first
    await page.route("https://www.facebook.com/plugins/**", (r) => r.fulfill({ contentType: "text/html", body: "<p>video</p>" }));
    await row2.getByRole("button", { name: "Watch Reel 2222222222" }).click();
    await expect(row2.locator(".fbbulk-player iframe")).toHaveAttribute("src", /plugins\/video\.php\?href=.*2222222222/);
    await row4.getByRole("button", { name: "Watch Reel 4444444444" }).click();
    await expect(row4.locator(".fbbulk-player iframe")).toBeVisible();
    await expect(dlg.locator(".fbbulk-player")).toHaveCount(1);
    await row4.getByRole("button", { name: "Stop Reel 4444444444" }).click();
    await expect(dlg.locator(".fbbulk-player")).toHaveCount(0);

    await dlg.getByRole("button", { name: "Add 2" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator(".toast")).toContainText("Added 2 ✓ — 1 you had already");
    await expect(page.locator(".fb-card")).toHaveCount(3);
    await expect(page.locator(".fb-card").filter({ hasText: "Reel 3333333333" })).toHaveCount(0);
    const listOf = async (title: string) => {
      await page.locator(".fb-card").filter({ hasText: title }).getByRole("button", { name: "✎ Edit" }).click();
      await expect(dlg.locator(".catpick").getByRole("button", { name: /^Sales & Customers/ })).toHaveAttribute("aria-pressed", "true");
      const on = await dlg.getByRole("button", { name: "🎯 Competitors" }).getAttribute("aria-pressed");
      await dlg.getByRole("button", { name: "Cancel" }).click();
      await expect(dlg).toBeHidden();
      return on;
    };
    expect(await listOf("Reel 2222222222")).toBe("true");
    expect(await listOf("Reel 4444444444")).toBe("false");
  });
});
