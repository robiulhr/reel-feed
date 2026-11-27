import { closeTips, expect, test } from "./fixtures";

test.use({ viewport: { width: 1400, height: 850 } });

test.describe("Wide screen: the Shorts feed uses the space", () => {
  test("a rail on the left and a panel on the right; the rail goes to Home and back", async ({ app: page }) => {
    await closeTips(page);
    const rail = page.locator("#tabbar");
    await expect(rail).toBeVisible();
    await expect(page.locator("#sidePanel")).toContainText("Details");
    await expect(page.locator("#sidePanel")).toContainText("Your note");
    await expect(rail.getByRole("button", { name: "Shorts" })).toHaveAttribute("aria-current", "page");
    await rail.getByRole("button", { name: "Home" }).click();
    await expect(page.locator("#home")).toBeVisible();
    await expect(rail.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
    await rail.getByRole("button", { name: "Shorts" }).click();
    await expect(page.locator("#home")).toBeHidden();
    await expect(page.locator("#title")).not.toBeEmpty();
  });

  test("scrolling the panel with the wheel does not change the video", async ({ app: page }) => {
    await closeTips(page);
    const title = await page.locator("#title").textContent();
    await page.locator("#sidePanel").hover();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(700);
    await expect(page.locator("#title")).toHaveText(title ?? "");
  });

  test("the panel follows the video", async ({ app: page }) => {
    await closeTips(page);
    const first = await page.locator("#sidePanel .sp-title").textContent();
    await page.locator("#nextBtn").click();
    await expect(page.locator("#sidePanel .sp-title")).not.toHaveText(first ?? "");
  });
});

test.describe("Wide screen: Menu and Search", () => {
  test("the Menu has its sections in a sidebar and opens on one of them", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    const nav = page.locator("#panelNav");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("button", { name: /Saved/ })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("button", { name: /History/ }).click();
    await expect(page.locator("#panelTitle")).toHaveText("Watch history");
    await expect(nav.getByRole("button", { name: /History/ })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#panelBack")).toBeHidden();
  });

  test("Search is a wide centred panel and can show only Shorts or only long videos", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#searchBtn").click();
    const box = await page.locator(".page-inner").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(900);
    const body = page.locator("#pageBody");
    await body.getByLabel("Search your videos, notes and topics").fill("Rolex");
    await expect(body.locator(".u-h", { hasText: "Long videos" })).toBeVisible();
    await body.getByRole("button", { name: "Long videos" }).click();
    await expect(body.locator(".u-h", { hasText: "Long videos" })).toBeVisible();
    await expect(body.locator(".scard")).toHaveCount(0);
    await body.getByRole("button", { name: "Shorts" }).click();
    await expect(body.locator(".u-h", { hasText: "Long videos" })).toHaveCount(0);
  });
});

test.describe("Wide screen: the search bar in the Home header", () => {
  test("it is centred on Home and opens Search", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#tabbar").getByRole("button", { name: "Home" }).click();
    const bar = page.locator("#searchBar");
    await expect(bar).toBeVisible();
    await bar.click();
    await expect(page.locator("#page")).toBeVisible();
  });
});
