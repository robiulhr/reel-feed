import { describe, expect, it, vi } from "vitest";
import { normQuery, similarPastSearch, vagueWarning } from "../../src/quota";
import { similarInLibrary, suggestQuery } from "../../src/similar";
import { busy, latest, once } from "../../src/ui";
import { makeDataset } from "../fixtures/data";
import type { AppApi } from "../../src/app";

describe("quota helpers", () => {
  it("normQuery ignores word order, case and repeats", () => {
    expect(normQuery("Pricing psychology customers")).toBe(normQuery("customers PRICING psychology psychology"));
  });

  it("normQuery keeps Bangla words whole (vowel signs included)", () => {
    expect(normQuery("দাম কমানো")).toBe("কমানো দাম");
  });

  it("similarPastSearch finds a close earlier search within 7 days", () => {
    const now = Date.now() / 1000;
    const recent = [
      { q: "pricing psychology customers", norm: normQuery("pricing psychology customers"), at: now - 3600, n: 20 },
      { q: "old search", norm: normQuery("pricing psychology"), at: now - 30 * 86400, n: 5 },
    ];
    expect(similarPastSearch("customers pricing psychology", recent)?.q).toBe("pricing psychology customers");
    expect(similarPastSearch("brand storytelling", recent)).toBeNull();
  });

  it("warns about one-word searches", () => {
    expect(vagueWarning("business")).not.toBe("");
    expect(vagueWarning("pricing psychology customers")).toBe("");
  });
});

describe("More like this (library)", () => {
  const ds = makeDataset();
  const app = { ds } as unknown as AppApi;

  it("finds Shorts on the same topic, not the Short itself", () => {
    const src = ds.videos.find((v) => v.t === "Pricing psychology secrets")!;
    const res = similarInLibrary(app, src);
    expect(res.length).toBeGreaterThan(0);
    expect(res.some((r) => r.short.id === src.id)).toBe(false);
    expect(res[0].short.t.toLowerCase()).toContain("pricing");
  });

  it("at most 3 results per channel", () => {
    const src = ds.videos[0];
    const per = new Map<number, number>();
    for (const r of similarInLibrary(app, src)) per.set(r.short.ch, (per.get(r.short.ch) ?? 0) + 1);
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(3);
  });

  it("suggests distinctive words for a YouTube search", () => {
    const src = ds.videos.find((v) => v.t === "Pricing psychology for ecommerce")!;
    const q = suggestQuery(app, src);
    expect(q.split(" ").length).toBeLessThanOrEqual(4);
    expect(q).toMatch(/ecommerce|pricing|psychology/);
    expect(q).not.toMatch(/\bfor\b/);
  });
});

describe("UI safety helpers", () => {
  it("busy(): a second tap while working is ignored", async () => {
    const btn = document.createElement("button");
    btn.textContent = "Add";
    let runs = 0;
    let release!: () => void;
    const work = () => { runs++; return new Promise<void>((r) => (release = r)); };
    const first = busy(btn, "Adding…", work);
    const second = busy(btn, "Adding…", work); // double tap
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Adding…");
    release();
    await first;
    expect(await second).toBeUndefined();
    expect(runs).toBe(1);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Add");
  });

  it("busy(): the button is unlocked even if the action fails", async () => {
    const btn = document.createElement("button");
    await expect(busy(btn, "…", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(btn.disabled).toBe(false);
  });

  it("once(): overlapping calls run once", async () => {
    const fn = vi.fn(() => new Promise((r) => setTimeout(r, 20)));
    const g = once(fn);
    await Promise.all([g(), g(), g()]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("latest(): only the newest request counts", () => {
    const l = latest();
    const a = l.next();
    const b = l.next();
    expect(l.isLatest(a)).toBe(false);
    expect(l.isLatest(b)).toBe(true);
  });
});
