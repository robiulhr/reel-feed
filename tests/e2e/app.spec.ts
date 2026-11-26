import type { Page } from "@playwright/test";
import { makeDataset } from "../fixtures/data";
import { closeTips, expect, login, menuPage, player, reload, swipe, test } from "./fixtures";

test.describe("layout", () => {
  test("fits the screen: no sideways scrolling, ↻ and ☰ always reachable", async ({ app: page }) => {
    await closeTips(page);
    const fit = await page.evaluate(() => {
      const inView = (id: string) => {
        const r = document.getElementById(id)!.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.width > 0;
      };
      return { noSideScroll: document.documentElement.scrollWidth <= innerWidth, menu: inView("menuBtn"), refresh: inView("refreshBtn") };
    });
    expect(fit).toEqual({ noSideScroll: true, menu: true, refresh: true });
  });

  test("tabs never overlap each other", async ({ app: page }) => {
    await closeTips(page);
    const overlaps = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#tabs button")].map((x) => x.getBoundingClientRect());
      return b.some((r, i) => i > 0 && r.left < b[i - 1].right - 0.5);
    });
    expect(overlaps).toBe(false);
  });
});

test.describe("watching", () => {
  test("first-time tips appear once", async ({ app: page }) => {
    await expect(page.locator("#tips")).toBeVisible();
    await page.locator("#tipsOk").click();
    await reload(page);
    await expect(page.locator("#title")).not.toBeEmpty();
    await expect(page.locator("#tips")).toBeHidden();
  });

  test("swipe up → next Short, swipe down → back", async ({ app: page }) => {
    await closeTips(page);
    const first = await page.locator("#title").textContent();
    await swipe(page, "up");
    const second = await page.locator("#title").textContent();
    expect(second).not.toBe(first);
    await swipe(page, "down");
    await expect(page.locator("#title")).toHaveText(first!);
  });

  test("swipe left opens the channel page", async ({ app: page }) => {
    await closeTips(page);
    const name = await page.locator("#chName").textContent();
    await swipe(page, "left");
    await expect(page.locator("#page")).toBeVisible();
    await expect(page.locator("#pageTitle")).toHaveText(name!);
  });

  test("double-tap right skips 10 s forward, left goes back", async ({ app: page }) => {
    await closeTips(page);
    await page.waitForTimeout(300);
    const box = (await page.locator("#tap").boundingBox())!;
    await page.evaluate(() =>
      (window as any).__yt.players.forEach((p: any) => {
        p.seekTo(20);
      }),
    );
    const before = (await player(page))!.t;
    // (above the buttons stacked at the bottom right, so the tap reaches the video)
    await page.mouse.dblclick(box.x + box.width * 0.85, box.y + box.height * 0.25);
    await expect(page.locator("#skipHint")).toHaveText(/10s/);
    const after = (await player(page))!.t;
    expect(after - before).toBeGreaterThanOrEqual(9);
    await page.waitForTimeout(400);
    await page.mouse.dblclick(box.x + box.width * 0.15, box.y + box.height * 0.25);
    expect((await player(page))!.t).toBeLessThan(after - 8);
  });

  test("double-tap in the middle saves (and once more doesn't unsave)", async ({ app: page }) => {
    await closeTips(page);
    const box = (await page.locator("#tap").boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#saveBtn")).toHaveClass(/on/);
    await page.waitForTimeout(400);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#saveBtn")).toHaveClass(/on/);
  });

  test("press and hold = 2× while held", async ({ app: page }) => {
    await closeTips(page);
    await page.evaluate(() => {
      const tap = document.getElementById("tap")!;
      const r = tap.getBoundingClientRect();
      const t = new Touch({ identifier: 7, target: tap, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      tap.dispatchEvent(new TouchEvent("touchstart", { touches: [t], changedTouches: [t], bubbles: true }));
    });
    await expect(page.locator("#speedHint")).toBeVisible();
    expect((await player(page))!.rate).toBe(2);
    await page.evaluate(() => {
      const tap = document.getElementById("tap")!;
      const t = new Touch({ identifier: 7, target: tap, clientX: 10, clientY: 10 });
      tap.dispatchEvent(new TouchEvent("touchend", { changedTouches: [t], bubbles: true }));
    });
    await expect(page.locator("#speedHint")).toBeHidden();
    expect((await player(page))!.rate).toBe(1);
  });

  test("drag the progress bar to jump", async ({ app: page }) => {
    await closeTips(page);
    await page.waitForTimeout(200);
    const bar = (await page.locator("#progress").boundingBox())!;
    await page.mouse.move(bar.x + bar.width * 0.2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width * 0.5, bar.y + bar.height / 2, { steps: 4 });
    await expect(page.locator("#scrubTime")).toBeVisible();
    await page.mouse.up();
    const t = (await player(page))!.t;
    expect(t).toBeGreaterThan(25);
    expect(t).toBeLessThan(35);
  });

  test("sound: tap unmutes and shows the volume slider; speed from the ⋯ menu", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#muteBtn").click();
    await expect(page.locator("#volPop")).toBeVisible();
    expect((await player(page))!.muted).toBe(false);
    await page.locator("#volPop .vol-range").fill("40");
    expect((await player(page))!.vol).toBe(40);
    await page.locator("#moreBtn").click();
    await page.locator('#moreSheet button[data-r="1.5"]').click();
    await expect(page.locator("#meta")).toContainText("1.5×");
  });
});

test.describe("menus", () => {
  test("History lists what you watched", async ({ app: page }) => {
    await closeTips(page);
    const first = await page.locator("#title").textContent();
    await page.waitForTimeout(1300); // watch a little
    await swipe(page, "up");
    await page.locator("#menuBtn").click();
    await menuPage(page, "history");
    await expect(page.locator("#panelBody .h-row").first()).toContainText(first!.slice(0, 15));
  });

  test("↻ refresh gives a fresh feed", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#refreshBtn").click();
    await expect(page.locator("#toast")).toContainText("Fresh feed");
  });

  test("going offline shows a clear message", async ({ app: page, context }) => {
    await closeTips(page);
    await context.setOffline(true);
    await expect(page.locator("#banner")).toContainText("offline");
    await context.setOffline(false);
  });
});

test.describe("channels (with the fake sync server)", () => {
  test("Add: triple tap → exactly one save", async ({ app: page, sync }) => {
    await closeTips(page);
    await login(page);
    await menuPage(page, "youtube");
    await page.getByRole("button", { name: "+ Add channel" }).click();
    await page.locator(".ch-add-form input").fill("@pricinglab");
    await page.locator(".ch-add-form button[type=submit]").click();
    const add = page.locator(".ch-card .btn.primary");
    await expect(add).toHaveText("Add");
    await add.click({ clickCount: 3, delay: 20 });
    await expect(page.locator("#toast")).toContainText("Added Pricing Lab");
    await page.waitForTimeout(700);
    expect(sync.channelPosts.length).toBe(1);
    expect(sync.channels.some((c) => c.handle === "@pricinglab")).toBe(true);
  });

  test("a channel in the list: open it in the app (Back returns), on YouTube, or add it to a list", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "youtube");
    const row = page.locator(".ch-item").first();
    const name = (await row.locator(".ch-title a").textContent())!.trim();
    await expect(row.getByRole("link", { name: `Open ${name} on YouTube` })).toHaveAttribute("href", /^https:\/\/www\.youtube\.com\//);
    await row.getByRole("button", { name: `Open ${name} in the app` }).click();
    await expect(page).toHaveURL(/\/channel\//);
    await expect(page.locator("#pageTitle")).toHaveText(name);
    await page.goBack();
    await expect(page).toHaveURL(/\/channels$/);
    // the name opens it in the app too
    await page.locator(".ch-item").first().locator(".ch-title a").click();
    await expect(page.locator("#pageTitle")).toHaveText(name);
    await page.goBack();
    // lists
    await page
      .locator(".ch-item")
      .first()
      .getByRole("button", { name: new RegExp(`change the lists for ${name}`) })
      .click();
    const dlg = page.getByRole("dialog", { name: `Lists for ${name}` });
    await dlg.getByRole("button", { name: "🎯 Competitors" }).click();
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(
      page
        .locator(".ch-item")
        .first()
        .getByRole("button", { name: new RegExp(`change the lists for ${name}`) }),
    ).toHaveText("📋 🎯 Competitors");
  });

  test("Remove: triple tap on the full list → one save, and never touches the next channel", async ({ app: page, sync }) => {
    await closeTips(page);
    await login(page);
    await menuPage(page, "youtube");
    await expect(page.locator(".ch-item")).toHaveCount(3);
    const first = page.locator(".ch-item").first();
    const name = (await first.locator(".ch-title a").textContent())!.trim();
    await first.getByRole("button", { name: "Remove" }).click({ clickCount: 3, delay: 20 });
    await expect(page.locator("#toast")).toContainText(`Removed ${name}`);
    await page.waitForTimeout(800);
    expect(sync.channelPosts.length).toBe(1);
    expect(sync.channels.filter((c) => c.status === "removed").map((c) => c.name)).toEqual([name]);
    // it stays in place, marked Removed, with Restore right there
    await expect(page.locator(".ch-item").first()).toContainText("Removed");
    await page.locator(".ch-item").first().getByRole("button", { name: "Restore" }).click();
    await expect(page.locator("#toast")).toContainText(`Restored ${name}`);
    await page.waitForTimeout(800);
    expect(sync.channels.some((c) => c.status === "removed")).toBe(false);
  });

  test("Delete asks first with the app's own dialog", async ({ app: page, sync }) => {
    await closeTips(page);
    await login(page);
    await menuPage(page, "youtube");
    await page.locator(".ch-search").fill("Ads");
    await page.locator(".ch-item", { hasText: "Ads Lab" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.locator("#toast")).toContainText("Removed Ads Lab");
    await page.locator(".ch-controls select").nth(1).selectOption("removed");
    await page.locator(".ch-item", { hasText: "Ads Lab" }).getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".dlg")).toContainText("Delete Ads Lab permanently?");
    await page.locator(".dlg").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".dlg")).toBeHidden();
    expect(sync.channels.some((c) => c.handle === "@ads")).toBe(true);
  });
});

test.describe("categories", () => {
  test("a main-category chip filters the feed; All clears it", async ({ app: page }) => {
    await closeTips(page);
    const selling = page.locator('#chips button[data-group="sell"]');
    await selling.click();
    await expect(page.locator('#chips button[data-group="sell"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#meta")).toContainText(/Sales|E-com/);
    await swipe(page, "up");
    await expect(page.locator("#meta")).toContainText(/Sales|E-com/);
    await page.locator('#chips button[data-cat=""]').click();
    await expect(page.locator('#chips button[data-group="sell"]')).toHaveAttribute("aria-pressed", "false");
  });

  test("Filters sheet: a main category picks all its topics; a topic can be picked alone", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#filtBtn").click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    const selling = sheet.getByRole("button", { name: /^Selling,/ });
    const ecom = sheet.getByRole("button", { name: /^E-commerce,/ });
    const sales = sheet.getByRole("button", { name: /^Sales & Customers,/ });
    await selling.click();
    await expect(selling).toHaveAttribute("aria-pressed", "true");
    await expect(ecom).toHaveAttribute("aria-pressed", "true");
    await expect(sales).toHaveAttribute("aria-pressed", "true");
    await ecom.click(); // one topic off → the main category is only partly on
    await expect(selling).toHaveAttribute("aria-pressed", "mixed");
    await sheet.locator(".btn.primary").click();
    await expect(page.locator('#chips button[data-cat="sales"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("Filters sheet: time, language and topics apply together and show in the bar", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#filtBtn").click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    await sheet.getByRole("button", { name: "30 days" }).click();
    await sheet.getByRole("button", { name: /^Sales & Customers,/ }).click();
    const show = sheet.locator(".btn.primary");
    await expect(show).toHaveText(/^Show [0-9]+ Shorts$/);
    await show.click();
    await expect(page.locator("#filtBtn")).toHaveAttribute("aria-label", "Filters, 2 on");
    await expect(page.locator('#chips button[data-clear="win"]')).toBeVisible();
    await expect(page.locator('#chips button[data-cat="sales"]')).toHaveAttribute("aria-pressed", "true");
    await page.locator('#chips button[data-clear="win"]').click(); // ✕ removes the time range
    await expect(page.locator("#filtBtn")).toHaveAttribute("aria-label", "Filters, 1 on");
  });

  test("Filters sheet: topic + views + time (3 months, 1 year…) all combine, show as chips, and stay set", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#filtBtn").click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    const show = sheet.locator(".btn.primary");
    const shown = async () => Number(((await show.textContent()) ?? "").replace(/[^0-9]/g, ""));
    // the new choices are there
    for (const t of ["1 year", "3 months", "30 days", "7 days", "Today"])
      await expect(sheet.getByRole("button", { name: t, exact: true })).toBeVisible();
    for (const v of ["Any views", "1K+", "10K+", "100K+", "1M+"])
      await expect(sheet.getByRole("button", { name: v, exact: true })).toBeVisible();

    await sheet.getByRole("button", { name: /^Sales & Customers,/ }).click();
    const topicOnly = await shown();
    await sheet.getByRole("button", { name: "10K+", exact: true }).click();
    const withViews = await shown();
    expect(withViews).toBeLessThan(topicOnly); // fewer views than 10K are left out
    await sheet.getByRole("button", { name: "3 months", exact: true }).click();
    expect(await shown()).toBe(withViews); // (everything in the test library is recent)
    await sheet.getByRole("button", { name: "Today", exact: true }).click();
    expect(await shown()).toBeLessThanOrEqual(withViews);
    await sheet.getByRole("button", { name: "3 months", exact: true }).click();
    await show.click();

    await expect(page.locator("#filtBtn")).toHaveAttribute("aria-label", "Filters, 3 on");
    await expect(page.locator('#chips button[data-clear="win"]')).toContainText("3 months");
    await expect(page.locator('#chips button[data-clear="minV"]')).toContainText("10K+ views");
    await expect(page.locator('#chips button[data-cat="sales"]')).toHaveAttribute("aria-pressed", "true");

    // they stay set when the sheet is opened again
    await page.locator("#filtBtn").click();
    await expect(sheet.getByRole("button", { name: "10K+", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(sheet.getByRole("button", { name: "3 months", exact: true })).toHaveAttribute("aria-pressed", "true");
    await sheet.getByRole("button", { name: "Cancel" }).click();

    await page.locator('#chips button[data-clear="minV"]').click(); // ✕ takes off just the views
    await expect(page.locator("#filtBtn")).toHaveAttribute("aria-label", "Filters, 2 on");
    await expect(page.locator('#chips button[data-clear="win"]')).toContainText("3 months");
  });

  test("⋯ → Wrong category? saves your pick and shows it", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#moreBtn").click();
    await page.locator('[data-a="fixcat"]').click();
    const dlg = page.getByRole("dialog", { name: "Categories for this Short" });
    const picked = dlg.locator('button[aria-pressed="true"]');
    while ((await picked.count()) > 0) await picked.first().click(); // start from nothing
    await expect(picked).toHaveCount(0);
    await dlg.getByRole("button", { name: "Comedy", exact: true }).click();
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#meta")).toContainText("Comedy");
    await expect(page.locator("#meta")).not.toContainText("?");
  });

  test("Menu → Sorting lists the guessed Shorts; ✓ Right takes one off the list", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "sorting");
    const body = page.locator("#panelBody");
    await expect(body).toContainText("9 of 30 Shorts");
    await expect(body.locator(".sort-row")).toHaveCount(9);
    await body.locator(".sort-row").first().getByRole("button", { name: "✓ Right" }).click();
    await expect(body.locator(".sort-row")).toHaveCount(8);
    await expect(body).toContainText("sorted 1 yourself");
  });
});

/**
 * Reloads with some saved data on this device (as if from earlier). Written before the app starts —
 * writing it into the running page would be overwritten when the page saves on its way out.
 */
async function withData(page: Page, data: Record<string, unknown>) {
  await page.addInitScript((d) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    const k = "ecomgy-reel-feed.v1";
    localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? "{}"), ...d, tipsSeen: true }));
  }, data);
  await reload(page);
}
/** Every library Short in Saved. */
async function saveAll(page: Page) {
  const ids = makeDataset().videos.map((v) => v.id);
  await withData(page, { saved: ids });
  return ids.length;
}

test.describe("saved, undo and backups", () => {
  test("Saved: main category and topic chips, search, and Play these", async ({ app: page }) => {
    const n = await saveAll(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "saved");
    const body = page.locator("#panelBody");
    await expect(body.getByRole("button", { name: `▶ Play all saved (${n})` })).toBeVisible();
    await expect(body.locator(".grid .card")).toHaveCount(n);
    // a main category: fewer Shorts, and its topics appear
    const group = body.locator('.sv-chips[aria-label="Main category"] .chip').nth(1);
    const groupCount = Number((await group.textContent())!.split("·").pop());
    await group.click();
    await expect(body.locator(".grid .card")).toHaveCount(groupCount);
    await expect(body.getByRole("button", { name: `▶ Play these ${groupCount}` })).toBeVisible();
    // search narrows it further; playing starts the filtered list
    await body.getByRole("searchbox", { name: "Search saved Shorts" }).fill("zzzz-nothing");
    await expect(body).toContainText("Nothing saved matches these filters.");
    await body.getByRole("searchbox", { name: "Search saved Shorts" }).fill("");
    await expect(body.locator(".grid .card")).toHaveCount(groupCount);
    await body.getByRole("button", { name: /^▶ Play these/ }).click();
    await expect(page.locator("#ctxTitle")).toContainText(/Saved/);
  });

  test("removing a saved Short can be undone, in the same place", async ({ app: page }) => {
    await saveAll(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "saved");
    const body = page.locator("#panelBody");
    const second = await body.locator(".grid .card .cap").nth(1).textContent();
    await body
      .locator(".grid .card")
      .nth(1)
      .getByRole("button", { name: /^Remove / })
      .click();
    await expect(body.locator(".grid .card .cap").nth(1)).not.toHaveText(second!);
    await page.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect(body.locator(".grid .card .cap").nth(1)).toHaveText(second!);
  });

  test("Reset what the feed learned asks first, and Undo brings it back", async ({ app: page }) => {
    await withData(page, { affCh: { "@ads": 6 }, affCat: { ads: 3 } });
    await page.locator("#menuBtn").click();
    await menuPage(page, "about");
    await page.getByRole("button", { name: "Reset what the feed learned" }).click();
    const dlg = page.getByRole("dialog", { name: "Reset what the feed learned?" });
    await dlg.getByRole("button", { name: "Cancel" }).click();
    const learned = () => page.evaluate(() => JSON.parse(localStorage.getItem("ecomgy-reel-feed.v1")!).affCh);
    await page.getByRole("button", { name: "Reset what the feed learned" }).click();
    await page.getByRole("dialog", { name: "Reset what the feed learned?" }).getByRole("button", { name: "Reset" }).click();
    await expect.poll(learned).toEqual({});
    await page.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect.poll(learned).toEqual({ "@ads": 6 });
  });

  test("Backups: back up now, then Restore puts everything back", async ({ app: page }) => {
    const n = await saveAll(page);
    await page.locator("#menuBtn").click();
    await menuPage(page, "backups");
    const body = page.locator("#panelBody");
    await body.getByRole("button", { name: "Back up now" }).click();
    await expect(body.locator(".bk-row").first()).toContainText("Made by you");
    await expect(body.locator(".bk-row").first()).toContainText(`${n} saved`);
    // lose the saved list, then restore the backup
    await menuPage(page, "saved");
    for (let i = 0; i < 3; i++)
      await body
        .locator(".grid .card")
        .first()
        .getByRole("button", { name: /^Remove / })
        .click();
    await expect(body.locator(".grid .card")).toHaveCount(n - 3);
    await menuPage(page, "backups");
    await body.locator(".bk-row").filter({ hasText: "Made by you" }).getByRole("button", { name: "Restore" }).click();
    await page.getByRole("dialog", { name: "Restore this backup?" }).getByRole("button", { name: "Restore" }).click();
    await expect(page.locator("#toast")).toContainText("Restored");
    await menuPage(page, "saved");
    await expect(body.locator(".grid .card")).toHaveCount(n);
  });

  test("Backups: an earlier version from GitHub can be restored", async ({ app: page, sync }) => {
    const ids = makeDataset().videos.map((v) => v.id);
    sync.versions.push({
      sha: "a".repeat(40),
      at: Date.parse("2026-11-01T10:00:00Z"),
      msg: "Sync from phone (2 changes)",
      data: { v: 2, updatedAt: "2026-11-01T10:00:00Z", saved: ids.slice(0, 2), hidden: [], seen: [], bad: [], affCh: {}, affCat: {} },
    });
    await page.locator("#menuBtn").click();
    await menuPage(page, "backups");
    const body = page.locator("#panelBody");
    await expect(body).toContainText("Turn on Sync");
    await page.locator("#closePanel").click();
    await login(page);
    await menuPage(page, "backups");
    await body.getByRole("button", { name: "Show versions" }).click();
    const row = body.locator(".bk-row").filter({ hasText: "Sync from phone" });
    await row.getByRole("button", { name: /^Restore the version from / }).click();
    const dialog = page.getByRole("dialog", { name: "Restore this version?" });
    await expect(dialog).toContainText("2 saved");
    await dialog.getByRole("button", { name: "Restore" }).click();
    await expect(page.locator("#toast")).toContainText("Restored");
    await menuPage(page, "saved");
    await expect(body.locator(".grid .card")).toHaveCount(2);
  });
});
