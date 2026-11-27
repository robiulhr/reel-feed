import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { closeTips, expect, gotoStart, test } from "./fixtures";

/** The first long video's fake player (the one the player page made). */
const watched = (page: Page) =>
  page.evaluate(() => {
    const ps = (window as unknown as { __yt: { players: any[] } }).__yt.players;
    const p = ps.find((x) => x.f.closest("#watch"));
    return p ? { vid: p.vid, t: p.getCurrentTime(), rate: p.rate, state: p.state } : null;
  });

async function openFirstLong(page: Page, pos?: number) {
  await page.evaluate((v) => {
    localStorage.setItem("rf.openOn", "home");
    if (v)
      localStorage.setItem(
        "rf.pos",
        JSON.stringify(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`longvid${String(i).padStart(4, "0")}`, [v, Date.now()]]))),
      );
  }, pos ?? 0);
  await gotoStart(page);
  await expect(page.locator("#home")).toBeVisible();
  const card = page.locator("#homeLong .home-long-card").first();
  const title = (await card.locator(".hl-title").textContent()) ?? "";
  await card.click();
  await expect(page.locator("#watch")).toBeVisible();
  return title;
}

test.describe("Long-video player page", () => {
  test("a long video opens its own page and plays; Back and Home return to Home", async ({ app: page }) => {
    await closeTips(page);
    const title = await openFirstLong(page);
    await expect(page.locator(".w-title")).toHaveText(title);
    await expect.poll(async () => (await watched(page))?.state).toBe(1);
    await expect(page.locator("#tabbar")).toBeHidden();
    await page.goBack();
    await expect(page.locator("#watch")).toBeHidden();
    await expect(page.locator("#home")).toBeVisible();
    await expect(page.locator("#tabbar")).toBeVisible();

    await page.locator("#homeLong .home-long-card").first().click();
    await expect(page.locator("#watch")).toBeVisible();
    await page.locator(".w-bar").getByRole("button", { name: /Home/ }).click();
    await expect(page.locator("#watch")).toBeHidden();
    await expect(page.locator("#home")).toBeVisible();
  });

  test("it starts where you stopped, and the speed buttons work and are remembered", async ({ app: page }) => {
    await closeTips(page);
    await openFirstLong(page, 40);
    await expect.poll(async () => (await watched(page))?.t ?? 0).toBeGreaterThanOrEqual(40);
    await page.getByRole("button", { name: "1.5×" }).click();
    await expect.poll(async () => (await watched(page))?.rate).toBe(1.5);
    await expect(page.getByRole("button", { name: "1.5×" })).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await page.locator("#homeLong .home-long-card").first().click();
    await expect(page.getByRole("button", { name: "1.5×" })).toHaveAttribute("aria-pressed", "true");
  });

  test("⏭ and Up next follow the list; ⏮ goes back", async ({ app: page }) => {
    await closeTips(page);
    const first = await openFirstLong(page);
    const second = (await page.locator("#homeLong .hl-title").nth(1).textContent()) ?? "";
    await expect(page.locator(".w-next")).toContainText(second);
    await page.locator(".w-bar").getByRole("button", { name: /Next/ }).click();
    await expect(page.locator(".w-title")).toHaveText(second);
    await expect.poll(async () => (await watched(page))?.vid).not.toBeNull();
    await page
      .locator(".w-bar")
      .getByRole("button", { name: /Previous/ })
      .click();
    await expect(page.locator(".w-title")).toHaveText(first);
    await expect(page.locator(".w-bar").getByRole("button", { name: /Previous/ })).toBeDisabled();
  });

  test("Note at the current time saves a note with the time in it", async ({ app: page }) => {
    await closeTips(page);
    await openFirstLong(page, 40);
    await page.getByRole("button", { name: /Note at/ }).click();
    const area = page.locator(".note-area");
    await expect(area).toHaveValue(/^\[(0:[45]\d|1:00)\] $/);
    await area.pressSequentially("great hook");
    await page.locator(".dlg-actions").getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".w-note")).toContainText("great hook");
    await expect(page.locator(".w-stamp").first()).toBeVisible();
  });

  test("the player page passes the WCAG check", async ({ app: page }) => {
    await closeTips(page);
    await openFirstLong(page);
    const r = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .include("#watch")
      .exclude("iframe")
      .analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
});

test.describe("Long-video page: address, save, share", () => {
  test("it has its own address; Back returns to Home; a link and a refresh open it again", async ({ app: page }) => {
    await closeTips(page);
    const title = await openFirstLong(page);
    await expect(page).toHaveURL(/\/w\/longvid\d+$/);
    const url = page.url();
    await page.getByRole("button", { name: /Next/ }).click();
    await expect(page).toHaveURL(/\/w\/longvid\d+$/);
    expect(page.url()).not.toBe(url);
    await page.goBack(); // the address followed the video without adding steps: Back lands on Home
    await expect(page.locator("#watch")).toBeHidden();
    await expect(page.locator("#home")).toBeVisible();
    await expect(page).toHaveURL(/\/home$/);

    await page.goto(url); // a link / a refresh on a video
    await expect(page.locator("#watch")).toBeVisible();
    await expect(page.locator(".w-title")).toHaveText(title);
    await page.locator(".w-bar").getByRole("button", { name: /Home/ }).click();
    await expect(page.locator("#home")).toBeVisible();
  });

  test("Save, Topic, Share and ⋯ are there", async ({ app: page }) => {
    await closeTips(page);
    await openFirstLong(page);
    const save = page.getByRole("button", { name: /Save/ });
    await save.click();
    await expect(page.getByRole("button", { name: /Saved/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /Saved/ }).click();
    await expect(page.getByRole("button", { name: /^♡ Save/ })).toBeVisible();
    await page.getByRole("button", { name: /Share/ }).click();
    await expect(page.locator(".dlg")).toContainText("Ecomgy link");
    await page.locator(".dlg-actions").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator(".dlg")).toContainText("Add to a playlist");
    await page.locator(".dlg-actions").getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("button", { name: /Topic/ })).toBeVisible();
  });
});

test("Back from a Short opened on Home returns to Home (the ← button too)", async ({ app: page }) => {
  await closeTips(page);
  await page.evaluate(() => localStorage.setItem("rf.openOn", "home"));
  await gotoStart(page);
  await page.locator("#homeRow .home-short").first().click();
  await expect(page.locator("#home")).toBeHidden();
  await page.locator("#ctxBack").click();
  await expect(page.locator("#home")).toBeVisible();
  await expect(page).toHaveURL(/\/home$/);
});

test.describe("Long videos in your library", () => {
  test("a long video you watched is in History, and opening it from there uses the player page", async ({ app: page }) => {
    await closeTips(page);
    const title = await openFirstLong(page, 40);
    await expect.poll(async () => (await watched(page))?.t ?? 0).toBeGreaterThanOrEqual(40);
    await page.locator(".w-bar").getByRole("button", { name: /Home/ }).click();
    await page.locator("#tabbar").getByRole("button", { name: "Menu" }).click();
    await page
      .getByRole("button", { name: /History/ })
      .first()
      .click();
    const row = page.locator("#panelBody .h-row", { hasText: title });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator("#watch")).toBeVisible();
    await expect(page.locator(".w-title")).toHaveText(title);
  });
});

test.describe("Home: continue watching, player keys", () => {
  test("a long video you started shows under Continue watching, and opens at the saved place", async ({ app: page }) => {
    await closeTips(page);
    await page.evaluate(() => {
      localStorage.setItem("rf.openOn", "home");
      localStorage.setItem("rf.pos", JSON.stringify({ longvid0000: [50, Date.now()] }));
    });
    await gotoStart(page);
    await expect(page.locator("#homeCont")).toBeVisible();
    await expect(page.locator("#homeContRow .home-long-card")).toHaveCount(1);
    await page.locator("#homeContRow .home-long-card").first().click();
    await expect(page.locator("#watch")).toBeVisible();
    await expect.poll(async () => (await watched(page))?.t ?? 0).toBeGreaterThanOrEqual(50);
  });

  test("keys: K pauses and plays, L jumps ahead 10 s", async ({ app: page }) => {
    await closeTips(page);
    await openFirstLong(page, 20);
    await expect.poll(async () => (await watched(page))?.state).toBe(1);
    await page.keyboard.press("k");
    await expect.poll(async () => (await watched(page))?.state).toBe(2);
    await page.keyboard.press("k");
    await expect.poll(async () => (await watched(page))?.state).toBe(1);
    const t0 = (await watched(page))?.t ?? 0;
    await page.keyboard.press("l");
    await expect.poll(async () => (await watched(page))?.t ?? 0).toBeGreaterThanOrEqual(Math.min(t0 + 9, 59));
  });
});

test.describe("Long video cards: the channel name is its own button", () => {
  test("tapping the channel name opens the channel; tapping the picture opens the video", async ({ app: page }) => {
    await closeTips(page);
    await page.evaluate(() => localStorage.setItem("rf.openOn", "home"));
    await gotoStart(page);
    const card = page.locator("#homeLong .home-long-card").first();
    await expect(card.locator(".hl-avatar")).toBeVisible();
    const name = (await card.locator(".hl-ch").textContent()) ?? "";
    await card.locator(".hl-ch").click();
    await expect(page.locator("#page")).toBeVisible();
    await expect(page.locator("#pageTitle")).toHaveText(name);
    await expect(page.locator("#watch")).toBeHidden();
    await page.goBack();
    await expect(page.locator("#page")).toBeHidden();
    await page.locator("#homeLong .home-long-card .hl-main").first().click();
    await expect(page.locator("#watch")).toBeVisible();
  });
});
