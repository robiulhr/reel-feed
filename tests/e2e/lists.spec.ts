import { closeTips, expect, swipe, test } from "./fixtures";

test.describe("channel lists (Competitors, Inspiration…)", () => {
  test("mark a channel as a competitor → its own feed, and its own tab in Saved", async ({ app: page }) => {
    await closeTips(page);
    const name = (await page.locator("#chName").textContent())!.trim();
    await page.locator("#saveBtn").click(); // save this Short first

    // ⋯ → Add channel to a list → Competitors
    await page.locator("#moreBtn").click();
    await page.getByRole("button", { name: "📋 Add channel to a list" }).click();
    const dlg = page.locator(".dlg");
    await expect(dlg).toContainText(`Lists for ${name}`);
    await dlg.getByRole("button", { name: "🎯 Competitors" }).click();
    // a list of your own, made right here (Enter adds it, doesn't close the dialog)
    await dlg.getByLabel("New list name").fill("Shopify experts");
    await dlg.getByLabel("New list name").press("Enter");
    await expect(dlg.getByRole("button", { name: "📋 Shopify experts" })).toHaveAttribute("aria-pressed", "true");
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeHidden();

    // the list's feed: only that channel
    await page.locator("#chips").getByRole("button", { name: "Competitors feed" }).click();
    for (let i = 0; i < 3; i++) {
      await expect(page.locator("#chName")).toHaveText(name);
      await swipe(page, "up");
    }
    // ✕ goes back to all channels
    await page
      .locator("#chips")
      .getByRole("button", { name: /Competitors feed. Back to all channels/ })
      .click();
    await expect(page.locator("#chips").getByRole("button", { name: "Competitors feed" })).toBeVisible();

    // Saved: a tab per list
    await page.locator("#menuBtn").click();
    await page.locator('[data-p="saved"]').click();
    const lists = page.getByRole("group", { name: "Channel list" });
    await expect(lists.getByRole("button", { name: "🎯 Competitors · 1" })).toBeVisible();
    await expect(lists.getByRole("button", { name: "📋 Shopify experts · 1" })).toBeVisible();
    await lists.getByRole("button", { name: "🎯 Competitors · 1" }).click();
    await expect(page.locator("#panelBody .card")).toHaveCount(1);
  });

  test("the channel page shows and changes its lists; Edit lists renames and deletes", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#chName").click();
    await page
      .locator("#page")
      .getByRole("button", { name: /Lists: none/ })
      .click();
    await page.locator(".dlg").getByRole("button", { name: "✨ Inspiration" }).click();
    await page.locator(".dlg").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#page").getByRole("button", { name: /Lists: Inspiration/ })).toBeVisible();
    await page.goBack();

    await page.locator("#filtBtn").click();
    const sheet = page.locator(".dlg").first();
    await expect(sheet.getByRole("group", { name: "Channel lists" })).toContainText("✨ Inspiration · 1");
    await sheet.getByRole("button", { name: "Edit lists" }).click();
    const man = page.locator(".dlg").last();
    await expect(man).toContainText("Your channel lists");
    await man.getByRole("button", { name: "Delete AI updates" }).click();
    await man.getByRole("button", { name: "Save" }).click();
    await expect(sheet.getByRole("group", { name: "Channel lists" })).not.toContainText("AI updates");
    await sheet.getByRole("group", { name: "Channel lists" }).getByRole("button", { name: "✨ Inspiration · 1" }).click();
    await sheet.getByRole("button", { name: /Show/ }).click();
    await expect(page.locator("#chips").getByRole("button", { name: /Inspiration feed. Back/ })).toBeVisible();
  });
});
