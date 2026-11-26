import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { closeTips, expect, gotoStart, test } from "./fixtures";

const playing = (page: Page) =>
  page.evaluate(() => {
    const yt = (window as unknown as { __yt: { players: { state: number }[] } }).__yt;
    return yt.players.some((p) => p.state === 1);
  });

/** Opens the app on Home (the default choice; the fixtures open the feed so the other tests stay about the feed). */
async function openHome(page: Page) {
  await page.evaluate(() => localStorage.setItem("rf.openOn", "home"));
  await gotoStart(page); // (a reload would stay on the Short's own address, /v/…, which opens the feed)
  await expect(page.locator("#home")).toBeVisible();
}

test.describe("Home", () => {
  test("opens with a Shorts row, the long videos and the bottom bar; nothing plays", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    await expect(page.locator("#homeRow .home-short").first()).toBeVisible();
    await expect(page.locator("#homeLong .home-long-card").first()).toBeVisible();
    await expect(page.locator("#homeLong .hl-dur").first()).toHaveText(/^(\d+:)?\d+:\d\d$/); // a length on each long video
    const bar = page.locator("#tabbar");
    await expect(bar).toBeVisible();
    for (const name of ["Home", "Shorts", "Search", "Menu"]) await expect(bar.getByRole("button", { name })).toBeVisible();
    expect(await playing(page)).toBe(false);
    await expect(page).toHaveURL(/\/home$/);
  });

  test("tapping a Short plays it in the feed; ⌂ comes back to Home, and so does Back", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    const first = page.locator("#homeRow .home-short").first();
    const title = (await first.locator(".home-short-t").textContent()) ?? "";
    await first.click();
    await expect(page.locator("#home")).toBeHidden();
    await expect(page.locator("#title")).toHaveText(title);
    await expect.poll(() => playing(page)).toBe(true);

    await page.locator("#homeBtn").click();
    await expect(page.locator("#home")).toBeVisible();
    await expect.poll(() => playing(page)).toBe(false);

    await page.locator("#tabbar").getByRole("button", { name: "Shorts" }).click();
    await expect(page.locator("#home")).toBeHidden();
    await expect.poll(() => playing(page)).toBe(true); // the feed carries on

    await page.goBack();
    await expect(page.locator("#home")).toBeVisible();
    expect(await playing(page)).toBe(false);
  });

  test("the Shorts tab starts the feed when it hasn't started yet", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    await page.locator("#tabbar").getByRole("button", { name: "Shorts" }).click();
    await expect(page.locator("#home")).toBeHidden();
    await expect(page.locator("#title")).not.toBeEmpty();
    await expect.poll(() => playing(page)).toBe(true);
  });

  test("a filter narrows both the Shorts row and the long videos", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    const shorts = () => page.locator("#homeRow .home-short").count();
    const longs = () => page.locator("#homeLong .home-long-card").count();
    const [s0, l0] = [await shorts(), await longs()];
    expect(s0).toBeGreaterThan(0);
    expect(l0).toBeGreaterThan(0);
    const chip = page.locator("#chips button[aria-pressed='false']").first();
    await chip.click();
    await expect(page.locator("#chips button[aria-pressed='true']").first()).toBeVisible();
    await expect.poll(async () => (await shorts()) <= s0 && (await longs()) <= l0).toBe(true);
    await expect(page.locator("#home")).toBeVisible(); // still on Home: nothing started playing
    expect(await playing(page)).toBe(false);
  });

  test("the For You / Trending / Most viewed… tabs and the views filter are on Home too, and change what it shows", async ({
    app: page,
  }) => {
    await closeTips(page);
    await openHome(page);
    const tabs = page.locator("#tabs");
    await expect(tabs.getByRole("button", { name: "Most viewed" })).toBeVisible();
    await tabs.getByRole("button", { name: "Most viewed" }).click();
    await expect(tabs.getByRole("button", { name: "Most viewed" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#home")).toBeVisible();
    const views = async () =>
      page.locator("#homeLong .hl-meta").evaluateAll((els) =>
        els.map((e) => {
          const m = /([\d.]+)([KM]?) views/.exec(e.textContent ?? "");
          return m ? Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "K" ? 1e3 : 1) : 0;
        }),
      );
    const v = await views();
    expect(v.length).toBeGreaterThan(1);
    expect([...v].sort((a, b) => b - a)).toEqual(v); // most viewed first
    await page.locator("#filtBtn").click(); // the Filters sheet (views, time, language) opens from Home as well
    await expect(page.locator(".dlg")).toContainText("views");
  });

  test("Search and Menu in the bottom bar open their pages over Home; Back returns", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    await page.locator("#tabbar").getByRole("button", { name: "Search" }).click();
    await expect(page.locator("#page")).toBeVisible();
    await page.goBack(); // Back closes the Search page and lands on Home, not on the feed
    await expect(page.locator("#page")).toBeHidden();
    await expect(page.locator("#home")).toBeVisible();
    await page.locator("#tabbar").getByRole("button", { name: "Menu" }).click();
    await expect(page.locator("#panel")).toBeVisible();
  });

  test("Home passes the WCAG check", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    await expect(page.locator("#homeLong .home-long-card").first()).toBeVisible();
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("#players").analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  test("scrolling Home with the mouse wheel or the arrow keys stays on Home", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 400);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(700);
    await expect(page.locator("#home")).toBeVisible();
    expect(await playing(page)).toBe(false);
  });
  test("↻ Refresh and pulling down at the top both refresh Home", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    await page.locator("#homeRefresh").click();
    await expect(page.locator(".toast")).toContainText("Fresh feed");
    await expect(page.locator("#homeRow .home-short").first()).toBeVisible();
    await expect(page.locator("#home")).toBeVisible();
    await page.waitForTimeout(3500); // the toast goes away
    // a pull: finger down 160px from the top of the list
    await page.evaluate(() => {
      const el = document.getElementById("homeScroll") as HTMLElement;
      const t = (y: number) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
      const fire = (type: string, y: number) =>
        el.dispatchEvent(
          new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [t(y)], changedTouches: [t(y)] }),
        );
      fire("touchstart", 200);
      fire("touchmove", 280);
      fire("touchmove", 380);
      fire("touchend", 380);
    });
    await expect(page.locator(".toast")).toContainText("Fresh feed");
    await expect(page.locator("#home")).toBeVisible();
  });

  test("a link to one Short opens the feed, not Home", async ({ app: page }) => {
    await closeTips(page);
    await openHome(page);
    const id = await page
      .locator("#homeRow .home-short")
      .first()
      .evaluate((b) => (b.querySelector("img")?.getAttribute("src") ?? "").match(/vi\/([^/]+)\//)?.[1] ?? "");
    expect(id).not.toBe("");
    await page.goto(`/v/${id}`);
    await expect(page.locator("#home")).toBeHidden();
    await expect(page.locator("#title")).not.toBeEmpty();
  });
});
