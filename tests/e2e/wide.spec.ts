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

  test("the panel follows the video", async ({ app: page }) => {
    await closeTips(page);
    const first = await page.locator("#sidePanel .sp-title").textContent();
    await page.locator("#nextBtn").click();
    await expect(page.locator("#sidePanel .sp-title")).not.toHaveText(first ?? "");
  });
});
