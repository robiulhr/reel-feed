import { closeTips, expect, test } from "./fixtures";

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

  test("paste a link → filled in → plays in the feed → save, unsave, edit, delete", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await page.locator('[data-p="added"]').click();
    await expect(page).toHaveURL(/\/added$/);
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
    await page.locator('[data-p="saved"]').click();
    await expect(page.getByRole("group", { name: "Source" }).getByRole("button", { name: "f Facebook · 1" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Channel list" }).getByRole("button", { name: "🎯 Competitors · 1" })).toBeVisible();
    await page.locator(".grid .card .x").click(); // unsave
    await expect(page.locator("#panelBody")).toContainText("No saved Shorts yet");
    await page.locator('[data-p="added"]').click();
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
    await page.locator('[data-p="saved"]').click();
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
    await page.goto("/v/fb1141407915517139");
    const frame = page.locator(".fb-slot iframe");
    await expect(frame).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page).not.toHaveURL(/fb1141407915517139/);
    await expect(frame).toBeHidden();
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

    await page.goto("/channel/fb%3A61595841376442");
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
});
