import { makeDataset } from "../fixtures/data";
import { closeTips, expect, goTo, menuPage, reload, test } from "./fixtures";

const path = (page: { url(): string }) => new URL(page.url()).pathname;
const videos = makeDataset().videos;

test.describe("page addresses and Back", () => {
  test("the address follows the Short on screen", async ({ app: page }) => {
    await closeTips(page);
    await expect.poll(() => path(page)).toMatch(/^\/v\/vid\d{8}$/);
    const id = path(page).split("/")[2];
    await expect(page.locator("#title")).toHaveText(videos.find((v) => v.id === id)!.t);
  });

  test("Menu pages have their own address; Back closes the menu (tab switches add no steps)", async ({ app: page }) => {
    await closeTips(page);
    const feedPath = path(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "saved");
    await expect.poll(() => path(page)).toBe("/saved");
    await menuPage(page, "api");
    await expect.poll(() => path(page)).toBe("/usage");
    await page.goBack();
    await expect(page.locator("#panel")).toBeHidden();
    expect(path(page)).toBe(feedPath);
    // ✕ works the same way
    await page.locator("#menuBtn").click();
    await page.locator("#closePanel").click();
    await expect(page.locator("#panel")).toBeHidden();
    expect(path(page)).toBe(feedPath);
  });

  test("a link to a Short plays that Short first", async ({ app: page }) => {
    const v = videos[13];
    await goTo(page, `/v/${v.id}`);
    await expect(page.locator("#title")).toHaveText(v.t);
  });

  test("a refresh on a Menu page opens it again, and Back goes to the feed (not out of the app)", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "history");
    await reload(page);
    await expect(page.locator("#panel")).toBeVisible();
    await expect(page.locator("#panelTitle")).toHaveText("Watch history"); // the page, with its back arrow
    await expect(page.locator("#panelBack")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#panel")).toBeHidden();
    await expect(page.locator("#title")).not.toBeEmpty();
  });

  test("channel page: own address, Back closes it", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#chName").click();
    await expect(page.locator("#page")).toBeVisible();
    await expect.poll(() => path(page)).toMatch(/^\/channel\/[\w.-]+$/);
    // opening the same address directly works too
    const chPath = path(page);
    await page.goBack();
    await expect(page.locator("#page")).toBeHidden();
    await goTo(page, chPath);
    await expect(page.locator("#page")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#page")).toBeHidden();
  });

  test("⋯ sheet and dialogs close with Back, without leaving the screen under them", async ({ app: page }) => {
    await closeTips(page);
    const feedPath = path(page);
    await page.locator("#moreBtn").click();
    await expect(page.locator("#moreSheet")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#moreSheet")).toBeHidden();
    expect(path(page)).toBe(feedPath);
    // a dialog inside the menu: Back closes the dialog, the menu stays
    await page.locator("#menuBtn").click();
    await menuPage(page, "about");
    await page
      .locator("#panelBody")
      .getByRole("button", { name: /Reset what the feed learned/ })
      .click();
    await expect(page.getByRole("dialog", { name: /Reset/ })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog", { name: /Reset/ })).toHaveCount(0);
    await expect(page.locator("#panel")).toBeVisible();
    expect(path(page)).toBe("/about");
    // the sheet's step was taken out again: one Back closes the menu
    await page.goBack();
    await expect(page.locator("#panel")).toBeHidden();
  });

  test("⋯ → More like this, then Back returns to the feed in one step", async ({ app: page }) => {
    await closeTips(page);
    const feedPath = path(page);
    await page.locator("#moreBtn").click();
    await page.locator('#moreSheet [data-a="similar"]').click();
    await expect(page.locator("#page")).toBeVisible();
    await expect.poll(() => path(page)).toMatch(/^\/similar\/vid\d{8}$/);
    await page.goBack();
    await expect(page.locator("#page")).toBeHidden();
    expect(path(page)).toBe(feedPath);
  });

  test("playing a list from Saved: Back leaves the list and the Saved page comes back", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#saveBtn").click();
    await page.locator("#menuBtn").click();
    await menuPage(page, "saved");
    await page.locator("#panelBody .grid .card .card-play").first().click();
    await expect(page.locator("#ctxBar")).toBeVisible();
    await expect(page.locator("#panel")).toBeHidden();
    await page.goBack();
    await expect(page.locator("#ctxBar")).toBeHidden();
    await expect(page.locator("#panel")).toBeVisible();
    expect(path(page)).toBe("/saved");
  });

  test("Share gives a link to this Short in the app", async ({ app: page }) => {
    await page.addInitScript(() => {
      (window as unknown as { shared: string[] }).shared = [];
      navigator.share = async (d?: ShareData) => {
        (window as unknown as { shared: string[] }).shared.push(d?.url ?? "");
      };
    });
    await reload(page);
    await closeTips(page);
    await page.locator("#shareBtn").click();
    const id = path(page).split("/")[2];
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { shared: string[] }).shared[0]))
      .toBe(new URL(`/v/${id}`, page.url()).href);
  });
});
