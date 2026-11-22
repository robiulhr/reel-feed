import { closeTips, expect, login, player, swipe, test } from "./fixtures";

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
    await page.reload();
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
    await page.mouse.dblclick(box.x + box.width * 0.85, box.y + box.height / 2);
    await expect(page.locator("#skipHint")).toHaveText(/10s/);
    const after = (await player(page))!.t;
    expect(after - before).toBeGreaterThanOrEqual(9);
    await page.waitForTimeout(400);
    await page.mouse.dblclick(box.x + box.width * 0.15, box.y + box.height / 2);
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
    await page.locator('[data-p="history"]').click();
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
    await page.locator('[data-p="channels"]').click();
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

  test("Remove: triple tap on the full list → one save, and never touches the next channel", async ({ app: page, sync }) => {
    await closeTips(page);
    await login(page);
    await page.locator('[data-p="channels"]').click();
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
    await page.locator('[data-p="channels"]').click();
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
  test("a category chip filters the feed; All clears it", async ({ app: page }) => {
    await closeTips(page);
    const sales = page.locator('#chips button[data-cat="sales"]');
    await sales.click();
    await expect(sales).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#meta")).toContainText("Sales");
    await swipe(page, "up");
    await expect(page.locator("#meta")).toContainText("Sales");
    await page.locator('#chips button[data-cat=""]').click();
    await expect(sales).toHaveAttribute("aria-pressed", "false");
  });

  test("Filters sheet: time, language and topics apply together and show in the bar", async ({ app: page }) => {
    await closeTips(page);
    await page.locator("#filtBtn").click();
    const sheet = page.getByRole("dialog", { name: "Filters" });
    await sheet.getByRole("button", { name: "30 days" }).click();
    await sheet.getByRole("button", { name: /^Sales & Customers/ }).click();
    const show = sheet.locator(".btn.primary");
    await expect(show).toHaveText(/^Show [0-9]+ Shorts$/);
    await show.click();
    await expect(page.locator("#filtBtn")).toHaveAttribute("aria-label", "Filters, 2 on");
    await expect(page.locator('#chips button[data-clear="win"]')).toBeVisible();
    await expect(page.locator('#chips button[data-cat="sales"]')).toHaveAttribute("aria-pressed", "true");
    await page.locator('#chips button[data-clear="win"]').click(); // ✕ removes the time range
    await expect(page.locator("#filtBtn")).toHaveAttribute("aria-label", "Filters, 1 on");
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
    await page.locator('[data-p="sorting"]').click();
    const body = page.locator("#panelBody");
    await expect(body).toContainText("9 of 30 Shorts");
    await expect(body.locator(".sort-row")).toHaveCount(9);
    await body.locator(".sort-row").first().getByRole("button", { name: "✓ Right" }).click();
    await expect(body.locator(".sort-row")).toHaveCount(8);
    await expect(body).toContainText("sorted 1 yourself");
  });
});
