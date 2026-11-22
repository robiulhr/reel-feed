import { beforeEach, describe, expect, it } from "vitest";
import { buildQueue } from "../../src/rank";
import { emptyShared, migrateLocal, type State } from "../../src/store";
import { makeDataset, NOW } from "../fixtures/data";
import type { Dataset } from "../../src/types";

let ds: Dataset;
let st: State;
const opts = (exclude: string[] = []) => ({ prevVisit: NOW - 86400, exclude: new Set(exclude) });

beforeEach(() => {
  ds = makeDataset();
  st = migrateLocal({ ...emptyShared(), tipsSeen: true, dataSaver: "off", autoFull: false });
});

describe("ranking (buildQueue)", () => {
  it("returns the requested number of Shorts", () => {
    const { items } = buildQueue(ds, st, opts(), 10);
    expect(items.length).toBe(10);
  });

  it("never shows the same channel twice in a row, max 3 per channel in a run", () => {
    for (let run = 0; run < 20; run++) {
      const { items } = buildQueue(ds, st, opts(), 20);
      for (let i = 1; i < items.length; i++) expect(items[i].ch).not.toBe(items[i - 1].ch);
    }
  });

  it("skips hidden channels, removed channels, broken videos and already-seen Shorts", () => {
    st.hidden = ["@alpha"];
    st.bad = [ds.videos.find((v) => v.ch === 2)!.id];
    st.seen = { [ds.videos.find((v) => v.ch === 3)!.id]: 1 };
    const { items } = buildQueue(ds, st, opts(), 30);
    const chans = new Set(items.map((s) => ds.channels[s.ch].h));
    expect(chans.has("@alpha")).toBe(false);
    expect(chans.has("@gone")).toBe(false);
    expect(items.some((s) => st.bad.includes(s.id))).toBe(false);
    expect(items.some((s) => st.seen[s.id])).toBe(false);
  });

  it("time filter keeps only recent Shorts", () => {
    st.win = "7";
    const { items } = buildQueue(ds, st, opts(), 30);
    expect(items.length).toBeGreaterThan(0);
    for (const s of items) expect(NOW - s.p).toBeLessThanOrEqual(7 * 86400);
  });

  it("Bangla language filter keeps only Bangla Shorts", () => {
    st.lang = "bn";
    const { items } = buildQueue(ds, st, opts(), 30);
    expect(items.length).toBe(6);
    for (const s of items) expect(ds.channels[s.ch].h).toBe("@bangla");
  });

  it("when everything was seen, shows them again (recycled)", () => {
    for (const v of ds.videos) st.seen[v.id] = 1;
    const { items, recycled } = buildQueue(ds, st, opts(), 5);
    expect(recycled).toBe(true);
    expect(items.length).toBe(5);
  });

  it("Newest tab is in upload order (within diversity rules)", () => {
    st.tab = "newest";
    const { items } = buildQueue(ds, st, opts(), 5);
    const newest = Math.max(...ds.videos.filter((v) => ds.channels[v.ch].st !== "removed").map((v) => v.p));
    expect(items[0].p).toBe(newest);
  });

  it("excluded IDs (already in the queue/history) are not repeated", () => {
    const first = buildQueue(ds, st, opts(), 10).items.map((s) => s.id);
    const second = buildQueue(ds, st, opts(first), 10).items.map((s) => s.id);
    expect(second.some((id) => first.includes(id))).toBe(false);
  });
});
