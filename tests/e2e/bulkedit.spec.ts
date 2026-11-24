import type { Page } from "@playwright/test";
import { closeTips, expect, menuPage, test } from "./fixtures";

const META = {
  views: 65000,
  reactions: 1100,
  page: { name: "Boost Marketing", path: "/61595841376442" },
  embeddable: true,
  cats: ["sales"],
};
const IDS = ["1111111111", "2222222222", "3333333333"];

test.beforeEach(async ({ app: page }) => {
  await page.route("**/api/fb/meta**", (r) => {
    const id = /reel\/(\d+)/.exec(new URL(r.request().url()).searchParams.get("url") ?? "")?.[1] ?? "0";
    return r.fulfill({ json: { ...META, id, url: `https://www.facebook.com/reel/${id}/`, title: `Reel ${id}`, caption: `Reel ${id}` } });
  });
  await page.route("**/api/fb/thumb/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/api/fb/pagepic**", (r) => r.fulfill({ status: 404, body: "" }));
});

async function addThree(page: Page) {
  await page.locator("#menuBtn").click();
  await menuPage(page, "added");
  await page.locator("#panelBody").getByRole("button", { name: "＋ Add several at once" }).click();
  const dlg = page.locator(".dlg");
  await dlg.getByLabel("Facebook video links").fill(IDS.map((i) => `https://www.facebook.com/reel/${i}/`).join("\n"));
  await dlg.getByRole("button", { name: "Look them up" }).click();
  await expect(dlg.locator(".fbbulk-row.st-ok")).toHaveCount(3);
  await dlg.getByRole("button", { name: "Add 3" }).click();
  await expect(dlg).toBeHidden();
}

const manualNow = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("ecomgy-reel-feed.v1") ?? "{}")
      .manual.map((m: { id: string; cats: string[]; lists: string[] }) => [m.id, m.cats, m.lists])
      .sort(),
  );

test.describe("edit several videos at once", () => {
  test("on a Facebook page: select videos, set their categories and put them in a list together; Undo puts it back", async ({
    app: page,
  }) => {
    await closeTips(page);
    await addThree(page);
    // the page's own screen
    await menuPage(page, "channels");
    const body = page.locator("#panelBody");
    await body.getByRole("button", { name: "📘 Facebook" }).click();
    await body.getByRole("button", { name: "Pages", exact: true }).click();
    await body.getByRole("button", { name: /^Open Boost Marketing in the app/ }).click();
    const pageBody = page.locator("#pageBody");
    await expect(pageBody.locator(".scard")).toHaveCount(3);

    // nothing is picked until you ask to select
    await expect(pageBody.locator(".scard-pick")).toHaveCount(0);
    await pageBody.getByRole("button", { name: "☑ Select videos" }).click();
    await pageBody.locator(".scard").nth(0).click();
    await pageBody.locator(".scard").nth(1).click();
    await expect(pageBody.locator(".selbar-count")).toHaveText("2 selected");
    await pageBody.locator(".selbar").getByRole("button", { name: "All", exact: true }).click();
    await expect(pageBody.locator(".selbar-count")).toHaveText("3 selected");
    await pageBody.locator(".scard").nth(2).click(); // un-pick one
    await expect(pageBody.locator(".selbar-count")).toHaveText("2 selected");

    await pageBody.getByRole("button", { name: /^✎ Edit 2/ }).click();
    const dlg = page.locator(".dlg");
    await expect(dlg).toContainText("Edit 2 videos");
    await dlg.getByLabel("What to do with the categories").selectOption("set");
    await dlg
      .locator(".catpick")
      .getByRole("button", { name: /^Self-growth/ })
      .click();
    await dlg
      .getByRole("group", { name: "Put in these lists" })
      .getByRole("button", { name: /Competitors/ })
      .click();
    await dlg.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".toast")).toContainText("Updated 2 videos");

    await expect
      .poll(async () => {
        const rows = (await manualNow(page)) as [string, string[], string[]][];
        return rows.filter(([, cats, lists]) => cats[0] === "growth" && lists.length === 1).length;
      })
      .toBe(2);
    const rows = (await manualNow(page)) as [string, string[], string[]][];
    expect(rows.filter(([, cats]) => cats[0] === "sales")).toHaveLength(1); // the one you didn't pick keeps its own

    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await expect
      .poll(async () =>
        ((await manualNow(page)) as [string, string[], string[]][]).every(([, cats, lists]) => cats[0] === "sales" && lists.length === 0),
      )
      .toBe(true);
  });

  test("on a YouTube channel: pick its Shorts and set their categories together (lists belong to channels, so only categories)", async ({
    app: page,
  }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "youtube");
    const body = page.locator("#panelBody");
    await body
      .locator(".ch-item", { hasText: "Ads Lab" })
      .getByRole("button", { name: /^Open Ads Lab in the app/ })
      .click();
    const pageBody = page.locator("#pageBody");
    await pageBody.getByRole("button", { name: "☑ Select videos" }).click();
    await pageBody.locator(".selbar").getByRole("button", { name: "All", exact: true }).click();
    const n = Number(((await pageBody.locator(".selbar-count").textContent()) ?? "").split(" ")[0]);
    expect(n).toBeGreaterThan(0);
    await pageBody.getByRole("button", { name: /^✎ Edit/ }).click();
    const dlg = page.locator(".dlg");
    await expect(dlg).toContainText("only their categories change");
    await expect(dlg.getByRole("group", { name: "Put in these lists" })).toHaveCount(0); // no per-video lists for YouTube Shorts
    await dlg.getByLabel("What to do with the categories").selectOption("set");
    await dlg
      .locator(".catpick")
      .getByRole("button", { name: /^Self-growth/ })
      .click();
    await dlg.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".toast")).toContainText(`Updated ${n} video`);
    await expect
      .poll(() => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("ecomgy-reel-feed.v1") ?? "{}").catFix ?? {}).length))
      .toBe(n);
  });

  test("cancel leaves nothing selected; an empty choice changes nothing", async ({ app: page }) => {
    await closeTips(page);
    await addThree(page);
    await menuPage(page, "channels");
    const body = page.locator("#panelBody");
    await body.getByRole("button", { name: "📘 Facebook" }).click();
    await body.getByRole("button", { name: "Pages", exact: true }).click();
    await body.getByRole("button", { name: /^Open Boost Marketing in the app/ }).click();
    const pageBody = page.locator("#pageBody");
    await pageBody.getByRole("button", { name: "☑ Select videos" }).click();
    await expect(pageBody.getByRole("button", { name: /^✎ Edit/ })).toBeDisabled(); // nothing picked yet
    await pageBody.locator(".scard").first().click();
    await pageBody.getByRole("button", { name: /^✎ Edit 1/ }).click();
    await page.locator(".dlg").getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".toast")).toContainText("Nothing picked");
    await pageBody.getByRole("button", { name: "Cancel" }).click();
    await expect(pageBody.getByRole("button", { name: "☑ Select videos" })).toBeVisible();
    await expect(pageBody.locator(".scard-pick")).toHaveCount(0);
  });
});
