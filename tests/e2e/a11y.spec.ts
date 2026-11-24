import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { closeTips, expect, login, menuPage, test } from "./fixtures";

/** Automated WCAG 2.1 A/AA check (axe-core). The YouTube player itself is YouTube's, so it's left out. */
async function wcagProblems(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("#players").analyze();
  return r.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test.describe("accessibility", () => {
  test("main screen passes the WCAG check", async ({ app: page }) => {
    await closeTips(page);
    expect(await wcagProblems(page)).toEqual([]);
  });

  test("tips, menu and the ⋯ sheet pass the WCAG check", async ({ app: page }) => {
    test.setTimeout(90_000); // it checks the tips, the Menu and seven of its pages, one after another
    await expect(page.locator("#tips")).toBeVisible();
    expect(await wcagProblems(page)).toEqual([]);
    await closeTips(page);
    // save one Short, so Saved shows its search and filters too
    const box = (await page.locator("#tap").boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#saveBtn")).toHaveClass(/on/);
    await page.locator("#menuBtn").click();
    await expect(page.locator('#panelBody [data-p="saved"]')).toBeVisible();
    await page.waitForTimeout(500); // let the menu finish opening: colours are measured on what is really painted
    expect(await wcagProblems(page), "menu home").toEqual([]); // the new home screen too
    await page.keyboard.press("Escape");
    for (const tab of ["about", "history", "saved", "backups", "sync", "activity"]) {
      await menuPage(page, tab);
      await page.waitForTimeout(500);
      expect(await wcagProblems(page), `menu → ${tab}`).toEqual([]);
      await page.keyboard.press("Escape");
    }
    await page.locator("#moreBtn").click();
    expect(await wcagProblems(page)).toEqual([]);
  });

  test("menu: opens with the keyboard, keeps focus inside, Esc closes and returns focus", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#panel")).toBeVisible();
    await expect(page.locator("#panel")).toHaveAttribute("role", "dialog");
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("#panel"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#panel")).toBeHidden();
    await expect(page.locator("#menuBtn")).toBeFocused();
  });

  test("Enter on Cancel in a confirm dialog cancels (never confirms)", async ({ app: page, sync }) => {
    await closeTips(page);
    await login(page);
    await menuPage(page, "youtube");
    await page.locator(".ch-search").fill("Ads");
    await page.locator(".ch-item", { hasText: "Ads Lab" }).getByRole("button", { name: "Remove" }).click();
    await page.locator(".ch-controls select").nth(1).selectOption("removed");
    await page.locator(".ch-item", { hasText: "Ads Lab" }).getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".dlg")).toBeVisible();
    await page.locator(".dlg").getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".dlg")).toBeHidden();
    await page.waitForTimeout(600);
    expect(sync.channels.some((c) => c.handle === "@ads")).toBe(true);
  });

  test("video buttons say what they are and whether they're on", async ({ app: page }) => {
    await closeTips(page);
    await expect(page.locator("#saveBtn")).toHaveAttribute("aria-pressed", "false");
    await page.locator("#saveBtn").click();
    await expect(page.locator("#saveBtn")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#progress")).toHaveAttribute("role", "slider");
    await expect(page.locator('#tabs button[aria-pressed="true"]')).toHaveCount(1);
  });

  test("respects the phone's reduce-motion setting", async ({ app: page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await closeTips(page);
    const dur = await page.evaluate(() => getComputedStyle(document.querySelector(".act")!).transitionDuration);
    expect(Number.parseFloat(dur)).toBeLessThan(0.01);
    const first = await page.locator("#title").textContent();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#title")).not.toHaveText(first ?? "");
  });
});
