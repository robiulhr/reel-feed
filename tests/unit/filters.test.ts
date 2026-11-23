import { describe, expect, it } from "vitest";
import { feedFilter } from "../../src/rank";
import { migrateLocal, VIEW_MINS } from "../../src/store";
import { makeDataset, NOW } from "../fixtures/data";

const DAY = 86400;

/** Four Shorts with known age and views, among the fixture library's others. */
function library() {
  const ds = makeDataset();
  const [fresh, oldHuge, mid, oldSmall] = ds.videos;
  Object.assign(fresh, { p: NOW - 2 * DAY, v: 500_000 }); // new and big
  Object.assign(oldHuge, { p: NOW - 200 * DAY, v: 5_000_000 }); // months old, huge
  Object.assign(mid, { p: NOW - 60 * DAY, v: 20_000 }); // two months, medium
  Object.assign(oldSmall, { p: NOW - 2 * 365 * DAY, v: 900 }); // two years, small
  return { ds, ids: { fresh: fresh.id, oldHuge: oldHuge.id, mid: mid.id, oldSmall: oldSmall.id } };
}
const four = (ds: ReturnType<typeof makeDataset>, ids: Record<string, string>, o: object) => {
  const pass = feedFilter(ds, { ...migrateLocal({}), ...o });
  const mine = new Set(Object.values(ids));
  return Object.keys(ids).filter((k) => ds.videos.some((s) => s.id === ids[k] && mine.has(s.id) && pass(s)));
};

describe("views and time filters", () => {
  it("fewest views keeps only Shorts with at least that many", () => {
    const { ds, ids } = library();
    expect(four(ds, ids, { minV: 100_000 }).sort()).toEqual(["fresh", "oldHuge"]);
    expect(four(ds, ids, { minV: 10_000 }).sort()).toEqual(["fresh", "mid", "oldHuge"]);
    expect(four(ds, ids, { minV: 0 }).sort()).toEqual(["fresh", "mid", "oldHuge", "oldSmall"]);
  });

  it("time ranges include 3 months and 1 year", () => {
    const { ds, ids } = library();
    expect(four(ds, ids, { win: "90" }).sort()).toEqual(["fresh", "mid"]);
    expect(four(ds, ids, { win: "365" }).sort()).toEqual(["fresh", "mid", "oldHuge"]);
    expect(four(ds, ids, { win: "7" })).toEqual(["fresh"]);
  });

  it("views and time work together: big AND recent, not big and old", () => {
    const { ds, ids } = library();
    expect(four(ds, ids, { minV: 100_000, win: "90" })).toEqual(["fresh"]); // the 5M-view one is 200 days old
    expect(four(ds, ids, { minV: 100_000, win: "365" }).sort()).toEqual(["fresh", "oldHuge"]);
    expect(four(ds, ids, { minV: 1_000_000, win: "30" })).toEqual([]);
  });

  it("views and time also work together with a category and a language", () => {
    const { ds } = library();
    const base = { ...migrateLocal({}), minV: 100_000, win: "90" as const };
    const withCat = ds.videos.filter(feedFilter(ds, { ...base, cats: ["ads"] }));
    for (const s of withCat) {
      expect(s.v).toBeGreaterThanOrEqual(100_000);
      expect(NOW - s.p).toBeLessThanOrEqual(90 * DAY);
      expect(s.k).toContain("ads");
    }
    const noLang = ds.videos.filter(feedFilter(ds, { ...base, lang: "hi" }));
    expect(noLang.every((s) => s.lg === "hi")).toBe(true);
  });

  it("a phone's saved settings are cleaned: odd values become 'any'", () => {
    expect(migrateLocal({}).minV).toBe(0);
    expect(migrateLocal({ minV: 12_345 } as never).minV).toBe(0);
    expect(migrateLocal({ minV: 100_000, win: "90" } as never)).toMatchObject({ minV: 100_000, win: "90" });
    expect(migrateLocal({ win: "forever" } as never).win).toBe("all");
    expect(VIEW_MINS[0]).toBe(0);
  });
});
