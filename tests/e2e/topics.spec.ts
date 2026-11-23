import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { closeTips, expect, menuPage, reload, test } from "./fixtures";

async function wcagProblems(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).exclude("#players").analyze();
  return r.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

/** Topics: the blue chip on every video, the sheet that suggests/starts topics, and the Topics page in the Menu. */
test.describe("topics", () => {
  test("start a topic from the video on screen: its words are suggested, the chip shows it, the page lists it", async ({ app: page }) => {
    await closeTips(page);
    const chip = page.locator("#topicBtn");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Topic");

    await chip.click();
    const dlg = page.locator(".dlg");
    await expect(dlg).toContainText("Add to a topic");
    const name = dlg.getByLabel("Name of a new topic");
    await expect(name).not.toHaveValue(""); // the name is suggested from the video's title
    const suggested = await name.inputValue();
    await dlg.getByRole("button", { name: "＋ Start" }).click();
    await expect(dlg.getByRole("button", { name: new RegExp(suggested, "i") })).toHaveAttribute("aria-pressed", "true"); // pinned
    await dlg.getByRole("button", { name: "Close" }).click();
    await expect(chip).toHaveClass(/has/);
    await expect(chip).toContainText(suggested);

    await menuPage(page, "topics");
    const body = page.locator("#panelBody");
    const card = body.locator(".topic-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("1 video");
    await card.click();
    await expect(body.locator(".topic-name")).toHaveText(suggested);
    await expect(body).toContainText("Pinned videos · 1");
    await expect(body.locator(".topic-word").first()).toBeVisible(); // search words came from the title
  });

  test("start from the Menu, write notes, add a search word and a link, change the status; it all survives a reload", async ({
    app: page,
  }) => {
    await closeTips(page);
    await menuPage(page, "topics");
    const body = page.locator("#panelBody");
    await expect(body).toContainText("No topics yet");
    await body.getByLabel("Name of a new topic").fill("Price war");
    await body.getByRole("button", { name: "＋ Start" }).click();
    await expect(body.locator(".topic-name")).toHaveText("Price war");

    await body.getByLabel("A new note on this topic").fill("Brands that cut prices lose the brand");
    await body.getByRole("button", { name: "＋ Add note" }).click();
    await expect(body.locator(".note-card")).toContainText("Brands that cut prices lose the brand");

    await body.getByLabel("Add a search word").fill("discount trap");
    await body.getByRole("button", { name: "Add", exact: true }).click();
    await expect(body.locator(".topic-word")).toContainText(["price war", "discount trap"]);

    await body.getByLabel("Address of a link").fill("example.com/pricing-study");
    await body.getByLabel("What this link is").fill("pricing study");
    await body.getByRole("button", { name: "Add link" }).click();
    await expect(body.locator(".topic-link-a")).toHaveAttribute("href", "https://example.com/pricing-study");

    await body.getByRole("button", { name: "Ready to make" }).click();
    await expect(body.getByRole("button", { name: "Ready to make" })).toHaveAttribute("aria-pressed", "true");

    await reload(page);
    await menuPage(page, "topics");
    const card = page.locator("#panelBody .topic-card");
    await expect(card).toContainText("Price war");
    await expect(card).toContainText("Ready to make");
    await expect(card).toContainText("1 note");
    await card.click();
    await expect(page.locator("#panelBody .note-card")).toContainText("Brands that cut prices lose the brand");
    await expect(page.locator("#panelBody .topic-link-a")).toBeVisible();
  });

  test("a second video: the sheet suggests the topic it fits; unpin works; delete has Undo", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#topicBtn").click();
    await page.getByRole("button", { name: "＋ Start" }).click();
    await page.locator(".dlg").getByRole("button", { name: "Close" }).click();

    await menuPage(page, "topics");
    const body = page.locator("#panelBody");
    await body.locator(".topic-card").click();
    await body.getByRole("button", { name: "Unpin" }).click();
    await expect(body).toContainText("Pinned videos · 0");

    await body.getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator(".dlg").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(body).toContainText("No topics yet");
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await expect(body.locator(".topic-card")).toHaveCount(1);
  });

  test("the topics page and the sheet pass the WCAG check", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#topicBtn").click();
    await page.waitForTimeout(500);
    expect(await wcagProblems(page), "topic sheet").toEqual([]);
    await page.getByRole("button", { name: "＋ Start" }).click();
    await page.locator(".dlg").getByRole("button", { name: "Close" }).click();
    await menuPage(page, "topics");
    await page.waitForTimeout(500);
    expect(await wcagProblems(page), "topics list").toEqual([]);
    await page.locator("#panelBody .topic-card").click();
    await page.locator("#panelBody").getByLabel("A new note on this topic").fill("a note");
    await page.locator("#panelBody").getByRole("button", { name: "＋ Add note" }).click();
    await page.waitForTimeout(500);
    expect(await wcagProblems(page), "topic page").toEqual([]);
  });
});
