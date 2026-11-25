import type { Page } from "@playwright/test";
import { closeTips, expect, menuPage, swipe, test } from "./fixtures";

/** The video on screen finishes (the test player's "ended" event). */
const endVideo = (page: Page) =>
  page.evaluate(() => {
    const yt = (window as unknown as { __yt: { players: { f: HTMLElement; _set(n: number): void }[] } }).__yt;
    yt.players.find((p) => p.f.closest(".yt-slot")?.classList.contains("on"))?._set(0);
  });
const playerState = (page: Page) =>
  page.evaluate(() => {
    const yt = (window as unknown as { __yt: { players: { f: HTMLElement; state: number }[] } }).__yt;
    return yt.players.find((p) => p.f.closest(".yt-slot")?.classList.contains("on"))?.state;
  });
const title = (page: Page) => page.locator("#title").textContent();

async function more(page: Page) {
  await page.locator("#moreBtn").click();
  await expect(page.locator("#moreSheet")).toBeVisible();
}
async function setEnd(page: Page, label: RegExp) {
  await more(page);
  await page.locator("#moreSheet").getByRole("button", { name: label }).click();
  await page.keyboard.press("Escape");
}

test.describe("when a video ends", () => {
  test("it repeats by default; Next goes on to the next video; Stop stops", async ({ app: page }) => {
    await closeTips(page);
    await expect.poll(() => playerState(page)).toBe(1);
    const first = (await title(page)) ?? "";
    await endVideo(page);
    await page.waitForTimeout(400);
    expect(await title(page)).toBe(first); // repeated

    await setEnd(page, /^⏭ Next/);
    await endVideo(page);
    await expect(page.locator("#title")).not.toHaveText(first); // went on by itself

    await setEnd(page, /^⏹ Stop/);
    const second = (await title(page)) ?? "";
    await expect.poll(() => playerState(page)).toBe(1);
    await endVideo(page);
    await expect.poll(() => playerState(page)).toBe(2); // paused at the end
    expect(await title(page)).toBe(second);
  });

  test("the choice is remembered after a reload", async ({ app: page }) => {
    await closeTips(page);
    await setEnd(page, /^⏭ Next/);
    await page.reload();
    await closeTips(page);
    await more(page);
    await expect(page.locator("#moreSheet").getByRole("button", { name: /^⏭ Next/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("Repeat list: at the end of a list it starts again from the first", async ({ app: page }) => {
    await closeTips(page);
    await more(page);
    await page
      .locator("#moreSheet")
      .getByRole("button", { name: /Repeat list/ })
      .click(); // also switches to Next
    await expect(page.locator("#moreSheet").getByRole("button", { name: /^⏭ Next/ })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");

    await page.locator("#searchBtn").click();
    await page.locator("#pageBody").getByLabel("Search your videos, notes and topics").fill("brand");
    await expect(page.locator("#pageBody .scard").first()).toBeVisible();
    const n = await page.locator("#pageBody .scard").count();
    expect(n).toBeGreaterThan(1);
    await page
      .locator("#pageBody")
      .getByRole("button", { name: /Play all/ })
      .click();
    await expect(page.locator("#ctxBar")).toBeVisible();
    const first = (await title(page)) ?? "";
    for (let i = 0; i < n; i++) {
      await endVideo(page); // each end goes on; the last one goes back to the start
      await page.waitForTimeout(350);
    }
    expect(await title(page)).toBe(first);
  });
});

test.describe("playlists", () => {
  test("make a playlist from a video's ⋯ menu, add a second video, put them in order and play it", async ({ app: page }) => {
    await closeTips(page);
    const a = (await title(page)) ?? "";
    await more(page);
    await page
      .locator("#moreSheet")
      .getByRole("button", { name: /Add to a playlist/ })
      .click();
    const dlg = page.locator(".dlg");
    await dlg.getByLabel("Name of a new playlist").fill("Night");
    await dlg.getByRole("button", { name: "＋ Create" }).click();
    await expect(dlg.getByRole("button", { name: /Night/ })).toHaveAttribute("aria-pressed", "true"); // the video is in it
    await dlg.getByRole("button", { name: "Close" }).click();

    await swipe(page, "up");
    await expect(page.locator("#title")).not.toHaveText(a);
    const b = (await title(page)) ?? "";
    await more(page);
    await page
      .locator("#moreSheet")
      .getByRole("button", { name: /Add to a playlist/ })
      .click();
    await page.locator(".dlg").getByRole("button", { name: /Night/ }).click(); // add to the one that exists
    await page.locator(".dlg").getByRole("button", { name: "Close" }).click();

    await page.locator("#menuBtn").click();
    await menuPage(page, "playlists");
    const body = page.locator("#panelBody");
    await body.locator(".pl-open").filter({ hasText: "Night" }).click();
    await expect(body.locator(".topic-vid")).toHaveCount(2);
    await expect(body.locator(".topic-vid").nth(0)).toContainText(a);
    await body
      .getByRole("button", { name: /^Move .* down$/ })
      .first()
      .click(); // a goes after b
    await expect(body.locator(".topic-vid").nth(0)).toContainText(b);

    await body.getByRole("button", { name: /^▶ Play/ }).click();
    await expect(page.locator("#ctxBar")).toBeVisible();
    await expect(page.locator("#title")).toHaveText(b); // plays in the order you made
    await more(page);
    await expect(page.locator("#moreSheet").getByRole("button", { name: /^⏭ Next/ })).toHaveAttribute("aria-pressed", "true"); // a playlist plays one after another
  });

  test("Delete asks first and has Undo", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "playlists");
    const body = page.locator("#panelBody");
    await body.getByLabel("Name of a new playlist").fill("Temp");
    await body.getByRole("button", { name: "＋ Create" }).click();
    await body.getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator(".dlg").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(body).toContainText("No playlists yet");
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await expect(body.locator(".pl-open").filter({ hasText: "Temp" })).toHaveCount(1);
  });
});

test.describe("sleep mode", () => {
  test("a timer dims the screen, then stops the video and puts the screen back", async ({ app: page }) => {
    await closeTips(page);
    await expect.poll(() => playerState(page)).toBe(1);
    await page.clock.install();
    await more(page);
    await page
      .locator("#moreSheet")
      .getByRole("button", { name: /Sleep timer/ })
      .click();
    const dlg = page.locator(".dlg");
    await expect(dlg).toContainText("Sleep timer");
    await dlg.getByRole("button", { name: "15 min" }).click();
    await dlg.getByRole("button", { name: "Start" }).click();
    const screen = page.locator(".sleep-screen");
    await expect(screen).toBeVisible();
    await expect(screen.locator(".sleep-clock")).not.toBeEmpty();
    await expect(screen.locator(".sleep-left")).toContainText("min");
    expect(await playerState(page)).toBe(1); // the video plays on behind it

    await screen.click({ position: { x: 150, y: 200 } }); // tap: the buttons show
    await expect(screen.getByRole("button", { name: "☀ Wake up" })).toBeVisible();
    await page.clock.fastForward("15:30");
    await expect(page.locator(".sleep-screen")).toHaveCount(0);
    await expect.poll(() => playerState(page)).toBe(2); // stopped
  });

  test("Wake up shows the screen again and Stop ends sleep mode", async ({ app: page }) => {
    await closeTips(page);
    await more(page);
    await page
      .locator("#moreSheet")
      .getByRole("button", { name: /Sleep timer/ })
      .click();
    await page.locator(".dlg").getByRole("button", { name: "Start" }).click();
    const screen = page.locator(".sleep-screen");
    await screen.click({ position: { x: 150, y: 200 } });
    await screen.getByRole("button", { name: "☀ Wake up" }).click();
    await expect(page.locator(".sleep-screen")).toHaveCount(0);
    await expect(page.locator(".sleep-pill")).toBeVisible(); // the timer is still on
    await page.locator(".sleep-pill").click();
    await page.locator(".dlg").getByRole("button", { name: "Stop sleep mode" }).click();
    await expect(page.locator(".sleep-pill")).toHaveCount(0);
  });
});
