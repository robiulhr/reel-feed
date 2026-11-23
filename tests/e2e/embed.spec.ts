import { expect, test } from "./fixtures";

/** /embed/fb.html: the bare page the browser extension frames to show one Facebook reel. */
test.describe("embed page for the extension", () => {
  test("shows Facebook's player for a reel id", async ({ page }) => {
    await page.route("https://www.facebook.com/plugins/**", (r) => r.fulfill({ contentType: "text/html", body: "<p>video</p>" }));
    await page.goto("/embed/fb.html?id=2166091230582141");
    const frame = page.locator("iframe");
    await expect(frame).toHaveAttribute("src", /plugins\/video\.php\?href=.*reel%2F2166091230582141%2F/);
    await expect(frame).toHaveAttribute("allow", /autoplay/);
  });

  test("shows no frame for a missing or odd id", async ({ page }) => {
    await page.goto("/embed/fb.html?id=../../evil");
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(page.locator("body")).toContainText("No reel to show.");
  });
});
