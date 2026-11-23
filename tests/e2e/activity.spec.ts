import type { Page } from "@playwright/test";
import { closeTips, expect, login, menuPage, test } from "./fixtures";

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
});

/** Adds the video from the Added page (the menu is left open on it). */
async function addVideo(page: Page) {
  if (!(await page.locator("#closePanel").isVisible())) await page.locator("#menuBtn").click();
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
  await expect(page.locator(".fb-card")).toHaveCount(1);
}

test.describe("where your data stands", () => {
  test("sync not connected: a warning when you add something, a dot on the Menu button, and a Connect button", async ({ app: page }) => {
    await closeTips(page);
    await addVideo(page);
    await expect(page.locator(".toast")).toContainText("Not backed up", { timeout: 9000 }); // right after the "Added ✓" toast
    await expect(page.locator("#menuBtn")).toHaveAttribute("data-cloud", "local");
    await expect(page.locator("#menuBtn")).toHaveAttribute("aria-label", /not backed up/);
    const line = page.locator("#panelBody .cloud-line");
    await expect(line).toContainText("Not backed up");
    await line.getByRole("button", { name: "Connect" }).click();
    await expect(page.locator("#panelBody")).toContainText("Log in"); // Menu → Sync
  });

  test("connected: your change reaches the cloud within seconds, and the status says saved", async ({ app: page, sync }) => {
    await closeTips(page);
    await login(page);
    await expect(page.locator("#menuBtn")).not.toHaveAttribute("data-cloud", /local|error/);
    const before = sync.statePuts;
    await addVideo(page);
    // not after a minute: well inside a few seconds
    await expect.poll(() => sync.statePuts, { timeout: 5000 }).toBeGreaterThan(before);
    await expect(page.locator("#panelBody .cloud-line")).toContainText("All saved to the cloud", { timeout: 5000 });
    const saved = sync.versions.at(-1)?.data as any;
    expect(saved.manual.map((m: { id: string }) => m.id)).toEqual([META.id]);
    expect(saved.activity.some((e: { x: string }) => e.x.includes("Added a Facebook video"))).toBe(true);
  });
});

test.describe("Menu → Activity", () => {
  test("every change is written down in words, can be filtered and searched, and exported", async ({ app: page, sync }) => {
    await closeTips(page);
    await login(page);
    await addVideo(page);
    // a note and a save on it too
    await page.locator(".fb-card").getByRole("button", { name: "♡ Save" }).click();
    await expect.poll(() => sync.statePuts, { timeout: 5000 }).toBeGreaterThan(0);

    await menuPage(page, "activity");
    const body = page.locator("#panelBody");
    await expect(body.locator(".act-summary")).toContainText("changes this week");
    await expect(body.locator(".act-bars .act-fill")).toHaveCount(7); // a bar for each of the last 7 days
    await expect(body.locator(".cloud-line")).toBeVisible();
    await expect(body.locator(".act-row").filter({ hasText: "Added a Facebook video “Hide the price, lose the sale”" })).toBeVisible();
    await expect(body.locator(".act-row").filter({ hasText: "Saved a video" })).toBeVisible();
    // each line says more than one sentence: who made it, views, categories
    await expect(body.locator(".act-row").filter({ hasText: "Added a Facebook video" })).toContainText("Boost Marketing · 65K views");
    await expect(body.locator(".act-badge", { hasText: "Added" }).first()).toBeVisible();
    await expect(body.locator(".act-row").filter({ hasText: "Saved a video" })).toContainText(/📱 phone|💻 computer/); // which device it happened on (these tests emulate a phone)
    await expect(body.locator(".act-day").first()).toContainText("Today");

    // filters
    await body.getByRole("button", { name: /^Sync · / }).click();
    await expect(body.locator(".act-row").first()).toContainText("Saved");
    await expect(body.locator(".act-row").filter({ hasText: "Added a Facebook video" })).toHaveCount(0);
    await body.getByRole("button", { name: /^Changes · / }).click();
    await expect(body.locator(".act-row").filter({ hasText: "Added a Facebook video" })).toHaveCount(1);
    // search
    await body.getByRole("searchbox", { name: "Search the activity log" }).fill("zzzz");
    await expect(body).toContainText("Nothing matches.");
    await body.getByRole("searchbox", { name: "Search the activity log" }).fill("hide the price");
    await expect(body.locator(".act-row")).toHaveCount(2); // the add and the save of that video
    await expect(body.locator(".act-row").filter({ hasText: "Saved a video" })).toContainText("Hide the price, lose the sale"); // the title is looked up for saves

    // export what's shown
    const download = page.waitForEvent("download");
    await body.getByRole("button", { name: /Export/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^reel-feed-activity-\d{4}-\d{2}-\d{2}\.csv$/);

    // the cloud's own trail
    await body.getByRole("button", { name: /^All · / }).click();
    await body.getByText("Cloud history (every save, last 30 days)").click();
    await expect(body.locator(".act-cloud")).toContainText("Sync from"); // one line per save (the test server names them itself)
  });

  test("a bulk add is one line, not sixty", async ({ app: page }) => {
    await page.route("**/api/fb/meta**", (r) => {
      const id = /reel\/(\d+)/.exec(new URL(r.request().url()).searchParams.get("url") ?? "")?.[1] ?? "0";
      return r.fulfill({ json: { ...META, id, url: `https://www.facebook.com/reel/${id}/`, title: `Reel ${id}`, cats: ["sales"] } });
    });
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "added");
    await page.locator("#panelBody").getByRole("button", { name: "＋ Add several at once" }).click();
    const dlg = page.locator(".dlg");
    await dlg
      .getByLabel("Facebook video links")
      .fill(["1111111111", "2222222222", "3333333333"].map((i) => `https://www.facebook.com/reel/${i}/`).join("\n"));
    await dlg.getByRole("button", { name: "Look them up" }).click();
    await expect(dlg.locator(".fbbulk-row.st-ok")).toHaveCount(3);
    await dlg.getByRole("button", { name: "Add 3" }).click();
    await expect(dlg).toBeHidden();
    await menuPage(page, "activity");
    const rows = page.locator("#panelBody .act-row").filter({ hasText: "Added 3 Facebook videos at once" });
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("Reel 1111111111");
    // the batch opens into the videos in it
    await expect(page.locator("#panelBody .act-mini").first()).toBeHidden();
    await rows.getByRole("button", { name: "Show the 3 videos" }).click();
    await expect(page.locator("#panelBody .act-mini")).toHaveCount(3);
    await expect(page.locator("#panelBody .act-mini").first()).toContainText("Reel");
    await rows.getByRole("button", { name: "Hide the videos" }).click();
    await expect(page.locator("#panelBody .act-mini").first()).toBeHidden();
    await expect(page.locator("#panelBody .act-row").filter({ hasText: "Added a Facebook video" })).toHaveCount(0);
  });

  test("nothing yet: says so", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "activity");
    await expect(page.locator("#panelBody")).toContainText("Nothing yet");
  });
});
