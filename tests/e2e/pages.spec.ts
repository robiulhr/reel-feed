import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { closeTips, expect, menuPage, test } from "./fixtures";

const META = {
  id: "1141407915517139",
  url: "https://www.facebook.com/reel/1141407915517139/",
  title: "Hide the price, lose the sale",
  caption: "Hide the price, lose the sale\n#sales",
  views: 65000,
  reactions: 1100,
  page: { name: "Boost Marketing", path: "/61595841376442" },
  embeddable: true,
  cats: ["sales"],
};

test.beforeEach(async ({ app: page }) => {
  await page.route("**/api/fb/meta**", (r) => r.fulfill({ json: META }));
  await page.route("**/api/fb/thumb/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/api/fb/pagepic**", (r) => r.fulfill({ status: 404, body: "" }));
});

async function wcagProblems(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("#players").analyze();
  return r.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

async function addVideo(page: Page) {
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
}

/** Opens Menu → Channels & pages on its All view (the Facebook tab is left on Pages, not on the videos you added). */
async function openChannels(page: Page) {
  await menuPage(page, "channels");
  const body = page.locator("#panelBody");
  await body.getByRole("button", { name: "📘 Facebook" }).click();
  await body.getByRole("button", { name: "Pages", exact: true }).click();
  await body.getByRole("button", { name: "All", exact: true }).click();
}

/** Channels and Facebook pages are one list: a page shows up beside the YouTube channels, with a badge and a filter. */
test.describe("Facebook pages in Channels", () => {
  test("a page you added a video from is listed with a 📘 badge; the platform filter narrows the list", async ({ app: page }) => {
    await closeTips(page);
    await addVideo(page);
    await openChannels(page);
    const body = page.locator("#panelBody");
    const row = body.locator(".ch-item").filter({ hasText: "Boost Marketing" });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".pill.st-fb")).toHaveText("📘 Facebook");
    await expect(row).toContainText("1 video added");
    await expect(body.locator(".ch-item .pill.st-yt").first()).toBeVisible(); // the YouTube channels carry their own badge

    await body.getByRole("button", { name: "📘 Facebook" }).click();
    await expect(body.locator(".ch-item")).toHaveCount(1);
    await body.getByRole("button", { name: "📺 YouTube" }).click();
    await expect(body.locator(".ch-item").filter({ hasText: "Boost Marketing" })).toHaveCount(0);
    await expect(body.locator(".ch-item").first()).toBeVisible();
    await body.getByRole("button", { name: "All", exact: true }).click();
    await expect(body.locator(".ch-item").filter({ hasText: "Boost Marketing" })).toHaveCount(1);
  });

  test("the Channels page with a Facebook page in it passes the WCAG check", async ({ app: page }) => {
    await closeTips(page);
    await addVideo(page);
    await openChannels(page);
    await page.waitForTimeout(600);
    expect(await wcagProblems(page)).toEqual([]);
  });

  test("▶ Open shows the page's own screen with its videos", async ({ app: page }) => {
    await closeTips(page);
    await addVideo(page);
    await openChannels(page);
    await page.locator("#panelBody").getByRole("button", { name: "📘 Facebook" }).click();
    await page
      .locator("#panelBody")
      .getByRole("button", { name: /^Open Boost Marketing in the app/ })
      .click();
    await expect(page.locator("#pageBody")).toContainText("Boost Marketing");
    await expect(page.locator("#pageBody .scard")).toHaveCount(1);
  });

  test("Rename changes its name; Remove takes its videos out, with Undo", async ({ app: page }) => {
    await closeTips(page);
    await addVideo(page);
    await openChannels(page);
    const body = page.locator("#panelBody");
    await body.getByRole("button", { name: "📘 Facebook" }).click();

    await body.getByRole("button", { name: "Rename" }).click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Name of the page").fill("Boost Marketing BD");
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(body.locator(".ch-item")).toContainText("Boost Marketing BD");

    await body.getByRole("button", { name: "Remove" }).click();
    await page.locator(".dlg").getByRole("button", { name: "Remove" }).click();
    await expect(body.locator(".ch-item")).toHaveCount(0);
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await expect(body.locator(".ch-item")).toContainText("Boost Marketing BD");
    await expect(body.locator(".ch-item")).toContainText("1 video added");
  });
});
