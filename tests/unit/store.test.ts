import { describe, expect, it } from "vitest";
import { applyOp, emptyShared, fromFile, mergeInto, toFile, type HistItem } from "../../src/store";

describe("store: changes (ops)", () => {
  it("save is idempotent and newest first; unsave removes", () => {
    const s = emptyShared();
    applyOp(s, { t: "save", id: "a" });
    applyOp(s, { t: "save", id: "b" });
    applyOp(s, { t: "save", id: "a" }); // double tap
    expect(s.saved).toEqual(["b", "a"]);
    applyOp(s, { t: "unsave", id: "a" });
    expect(s.saved).toEqual(["b"]);
  });

  it("hide / unhide never duplicates", () => {
    const s = emptyShared();
    applyOp(s, { t: "hide", h: "@x" });
    applyOp(s, { t: "hide", h: "@x" });
    expect(s.hidden).toEqual(["@x"]);
    applyOp(s, { t: "unhide", h: "@x" });
    expect(s.hidden).toEqual([]);
  });

  it("learning is capped at ±20 for channel and category", () => {
    const s = emptyShared();
    for (let i = 0; i < 30; i++) applyOp(s, { t: "learn", h: "@x", cat: "ads", d: 2 });
    expect(s.affCh["@x"]).toBe(20);
    expect(s.affCat.ads).toBe(20);
    for (let i = 0; i < 50; i++) applyOp(s, { t: "learn", h: "@x", cat: "ads", d: -2 });
    expect(s.affCh["@x"]).toBe(-20);
    applyOp(s, { t: "resetLearn" });
    expect(s.affCh).toEqual({});
  });

  it("seen keeps the latest time", () => {
    const s = emptyShared();
    applyOp(s, { t: "seen", id: "a", at: 100 });
    applyOp(s, { t: "seen", id: "a", at: 50 });
    expect(s.seen.a).toBe(100);
  });

  it("watch history: one entry per Short, newest first, keeps the best watched fraction within an hour", () => {
    const s = emptyShared();
    const w = (id: string, at: number, f: number): HistItem => ({ id, at, f });
    applyOp(s, { t: "watch", item: w("a", 1000, 0.9) });
    applyOp(s, { t: "watch", item: w("b", 1100, 0.2) });
    applyOp(s, { t: "watch", item: w("a", 1200, 0.3) }); // re-watched a few minutes later
    expect(s.hist.map((h) => h.id)).toEqual(["a", "b"]);
    expect(s.hist[0].f).toBe(0.9);
    applyOp(s, { t: "histDel", id: "b" });
    expect(s.hist.map((h) => h.id)).toEqual(["a"]);
    applyOp(s, { t: "histClear" });
    expect(s.hist).toEqual([]);
  });

  it("history is capped at 600 entries", () => {
    const s = emptyShared();
    for (let i = 0; i < 700; i++) applyOp(s, { t: "watch", item: { id: `v${i}`, at: i, f: 1 } });
    expect(s.hist.length).toBe(600);
    expect(s.hist[0].id).toBe("v699");
  });

  it("API log ignores the same spend twice", () => {
    const s = emptyShared();
    applyOp(s, { t: "api", at: 5, units: 3, what: "Look up @x" });
    applyOp(s, { t: "api", at: 5, units: 3, what: "Look up @x" });
    expect(s.apiLog.length).toBe(1);
  });
});

describe("store: the GitHub file format", () => {
  it("round-trips everything that syncs (seen order kept)", () => {
    const s = emptyShared();
    applyOp(s, { t: "save", id: "a" });
    applyOp(s, { t: "hide", h: "@x" });
    applyOp(s, { t: "seen", id: "old", at: 10 });
    applyOp(s, { t: "seen", id: "new", at: 20 });
    applyOp(s, { t: "learn", h: "@x", cat: "ads", d: 1 });
    applyOp(s, { t: "watch", item: { id: "a", at: 30, f: 1 } });
    applyOp(s, { t: "api", at: 40, units: 103, what: "Search" });
    const back = fromFile(JSON.parse(JSON.stringify(toFile(structuredClone(s)))));
    expect(back.saved).toEqual(["a"]);
    expect(back.hidden).toEqual(["@x"]);
    expect(Object.keys(back.seen).sort((a, b) => back.seen[a] - back.seen[b])).toEqual(["old", "new"]);
    expect(back.affCh["@x"]).toBe(1);
    expect(back.hist[0].id).toBe("a");
    expect(back.apiLog[0].units).toBe(103);
  });

  it("an empty/missing file gives empty data", () => {
    expect(fromFile(null)).toEqual(emptyShared());
  });
});

describe("store: merging a second device", () => {
  it("merges without duplicates and keeps both devices' saves", () => {
    const github = emptyShared();
    applyOp(github, { t: "save", id: "from-phone" });
    applyOp(github, { t: "watch", item: { id: "x", at: 1, f: 1 } });
    const laptop = emptyShared();
    applyOp(laptop, { t: "save", id: "from-laptop" });
    applyOp(laptop, { t: "save", id: "from-phone" });
    applyOp(laptop, { t: "watch", item: { id: "x", at: 1, f: 1 } });
    mergeInto(github, laptop);
    expect(new Set(github.saved)).toEqual(new Set(["from-phone", "from-laptop"]));
    expect(github.saved.length).toBe(2);
    expect(github.hist.length).toBe(1);
  });
});
