import { closeTips, expect, menuPage, player, reload, swipe, test } from "./fixtures";

/** Notes: the amber chip on every video, the note sheet, and the Notes page in the Menu. */
test.describe("notes on videos", () => {
  test("every video has a highlighted note chip; a note shows on it and survives a reload", async ({ app: page }) => {
    await closeTips(page);
    const chip = page.locator("#noteBtn");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Add note");
    // highlighted: solid amber (not a faint grey button like the others)
    await expect(chip).toHaveCSS("background-color", "rgb(255, 200, 61)");

    await chip.click();
    const dlg = page.locator(".dlg");
    await expect(dlg).toContainText("Note");
    await expect(dlg.locator(".note-vid")).not.toBeEmpty(); // names the video
    await dlg.getByLabel("Your note on this video").fill("Hook in the first 2 s — copy this opening");
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dlg).toBeHidden();

    // the chip now shows your words
    await expect(chip).toHaveClass(/has/);
    await expect(chip).toContainText("Hook in the first 2 s");

    await reload(page);
    await expect(page.locator("#noteBtn")).toContainText("Hook in the first 2 s");

    // another video has its own (empty) chip; going back shows the note again
    const first = await page.locator("#title").textContent();
    await swipe(page, "up");
    await expect(page.locator("#title")).not.toHaveText(first ?? "");
    await expect(page.locator("#noteBtn")).toContainText("Add note");
    await swipe(page, "down");
    await expect(page.locator("#noteBtn")).toContainText("Hook in the first 2 s");
  });

  test("N opens the note, the video pauses while you write, and closing keeps what you typed", async ({ app: page }) => {
    await closeTips(page);
    await expect.poll(async () => (await player(page))?.state).toBe(1); // playing
    await page.keyboard.press("n");
    const dlg = page.locator(".dlg");
    await expect(dlg).toBeVisible();
    await expect.poll(async () => (await player(page))?.state).not.toBe(1); // paused
    await dlg.getByLabel("Your note on this video").fill("typed, then Esc");
    await page.keyboard.press("Escape"); // closing any way keeps the note
    await expect(dlg).toBeHidden();
    await expect(page.locator("#noteBtn")).toContainText("typed, then Esc");
    await expect.poll(async () => (await player(page))?.state).toBe(1); // plays on
  });

  test("Add time puts the video's time into the note", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#noteBtn").click();
    const dlg = page.locator(".dlg");
    await dlg.getByRole("button", { name: "⏱ Add time" }).click();
    await expect(dlg.getByLabel("Your note on this video")).toHaveValue(/^\[\d+:\d\d\] $/);
  });

  test("the Notes page lists notes, searches them, edits and deletes with Undo", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#noteBtn").click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Your note on this video").fill("Idea: price reveal at the end");
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dlg).toBeHidden();

    await page.locator("#menuBtn").click();
    await menuPage(page, "notes");
    await expect(page).toHaveURL(/\/notes$/);
    const card = page.locator(".note-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Idea: price reveal at the end");

    await page.getByLabel("Search your notes").fill("nothing like this");
    await expect(page.locator(".note-card")).toHaveCount(0);
    await page.getByLabel("Search your notes").fill("price reveal");
    await expect(page.locator(".note-card")).toHaveCount(1);

    // edit it from the page
    await card.getByRole("button", { name: "✎ Edit" }).click();
    await dlg.getByLabel("Your note on this video").fill("Idea: price reveal at the START");
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator(".note-card")).toContainText("at the START");

    // delete, then Undo
    await page.locator(".note-card").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".note-card")).toHaveCount(0);
    await expect(page.locator("#panelBody")).toContainText("No notes yet");
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".note-card")).toHaveCount(1);
    await expect(page.locator(".note-card")).toContainText("at the START");
  });
});
