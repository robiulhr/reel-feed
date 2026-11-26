import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { closeTips, expect, test } from "./fixtures";

async function wcagProblems(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("#players").analyze();
  return r.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const BOX = "Search your videos, notes and topics";

test.describe("search", () => {
  test("the 🔍 button opens search; typing finds videos from the library; a result plays", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#searchBtn").click();
    const body = page.locator("#pageBody");
    const input = body.getByLabel(BOX);
    await expect(input).toBeFocused();
    await expect(body).toContainText("videos in your library");

    const title = (await page.locator("#title").textContent()) ?? "";
    const word =
      title
        .split(/\s+/)
        .find((w) => w.replace(/\W/g, "").length > 3)
        ?.replace(/\W/g, "") ?? title;
    await input.fill(word.slice(0, word.length - 1)); // a half-typed word still matches (it matches from the start)
    await expect(body.locator(".scard").first()).toBeVisible();
    await expect(body.locator(".u-h", { hasText: "Videos" })).toBeVisible();

    await body.locator(".scard").first().click();
    await expect(page.locator("#pageBody")).toBeHidden();
    await expect(page.locator("#ctxBar")).toBeVisible(); // playing the results as a list
  });

  test("nothing found: says so and offers a YouTube search; the filters can be switched", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#searchBtn").click();
    const body = page.locator("#pageBody");
    await body.getByLabel(BOX).fill("zzqxqzz");
    await expect(body).toContainText("Nothing in your library");
    await expect(body.getByRole("button", { name: /Search YouTube for it/ })).toBeVisible();
    await body.getByRole("button", { name: "Saved", exact: true }).click();
    await expect(body.getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("/ opens it from the keyboard; your notes show up too", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#noteBtn").click();
    await page.locator(".dlg").getByLabel("Your note on this video").fill("zebra stripes opening idea");
    await page.locator(".dlg").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".dlg")).toBeHidden(); // (on a slow machine the key arrived while the sheet was still closing)
    await page.keyboard.press("/");
    const body = page.locator("#pageBody");
    await body.getByLabel(BOX).fill("zebra");
    await expect(body.locator(".u-h", { hasText: "Notes" })).toBeVisible();
    await expect(body.locator(".search-row")).toContainText("zebra stripes opening idea");
    await expect(body.locator(".u-h", { hasText: "Videos · 1" })).toBeVisible(); // the video carrying that note
  });

  test("the search page passes the WCAG check", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#searchBtn").click();
    await page.waitForTimeout(500);
    expect(await wcagProblems(page), "empty").toEqual([]);
    await page.locator("#pageBody").getByLabel(BOX).fill("a");
    await page.waitForTimeout(600);
    expect(await wcagProblems(page), "with results").toEqual([]);
  });
});
