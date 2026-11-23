import { beforeEach, describe, expect, it } from "vitest";
import { applyOp, emptyShared, fromFile, mergeInto, type Shared, toFile } from "../../src/store";
import { type Topic, mergeTopics, normTopics, TOPIC_STATUSES } from "../../src/topicdata";

const T0 = 1_800_000_000;
const topic = (over: Partial<Topic> = {}): Topic => ({
  id: "t1",
  name: "Price war",
  why: "why brands keep cutting prices",
  st: "researching",
  kw: ["price war", "discount"],
  vids: [],
  no: [],
  notes: [],
  links: [],
  at: T0,
  up: T0,
  ...over,
});

let s: Shared;
beforeEach(() => {
  s = emptyShared();
  applyOp(s, { t: "topicNew", p: topic() });
});

describe("topics: operations", () => {
  it("a new topic is added once (the same id again is ignored)", () => {
    applyOp(s, { t: "topicNew", p: topic({ name: "Something else" }) });
    expect(s.topics).toHaveLength(1);
    expect(s.topics[0].name).toBe("Price war");
  });

  it("pinning a video adds it once, newest first; unpinning removes it", () => {
    applyOp(s, { t: "topicVid", id: "t1", v: "aaaaaa", m: "pin", at: T0 + 1, ti: "First" });
    applyOp(s, { t: "topicVid", id: "t1", v: "bbbbbb", m: "pin", at: T0 + 2, ti: "Second" });
    applyOp(s, { t: "topicVid", id: "t1", v: "bbbbbb", m: "pin", at: T0 + 3, ti: "Second" });
    expect(s.topics[0].vids.map((v) => v.id)).toEqual(["bbbbbb", "aaaaaa"]);
    applyOp(s, { t: "topicVid", id: "t1", v: "aaaaaa", m: "unpin", at: T0 + 4 });
    expect(s.topics[0].vids.map((v) => v.id)).toEqual(["bbbbbb"]);
  });

  it("“not about this” takes a pinned video out and keeps it from coming back; pinning it again clears the mark", () => {
    applyOp(s, { t: "topicVid", id: "t1", v: "aaaaaa", m: "pin", at: T0 + 1 });
    applyOp(s, { t: "topicVid", id: "t1", v: "aaaaaa", m: "skip", at: T0 + 2 });
    expect(s.topics[0].vids).toHaveLength(0);
    expect(s.topics[0].no).toEqual(["aaaaaa"]);
    applyOp(s, { t: "topicVid", id: "t1", v: "aaaaaa", m: "pin", at: T0 + 3 });
    expect(s.topics[0].no).toEqual([]);
    expect(s.topics[0].vids).toHaveLength(1);
  });

  it("a change from an older edit doesn't overwrite a newer one (two devices)", () => {
    applyOp(s, { t: "topicSet", id: "t1", name: "Price wars", why: "", st: "made", kw: ["pricing"], up: T0 + 100 });
    applyOp(s, { t: "topicSet", id: "t1", name: "Old name", why: "old", st: "idea", kw: [], up: T0 + 50 });
    expect(s.topics[0]).toMatchObject({ name: "Price wars", st: "made", kw: ["pricing"], why: "" });
  });

  it("notes: add, edit in place (the newer text wins), delete", () => {
    applyOp(s, { t: "topicNote", id: "t1", n: { i: "n1", x: "first idea", at: T0 + 1 } });
    applyOp(s, { t: "topicNote", id: "t1", n: { i: "n1", x: "better idea", at: T0 + 5 } });
    applyOp(s, { t: "topicNote", id: "t1", n: { i: "n1", x: "stale text", at: T0 + 2 } });
    expect(s.topics[0].notes).toEqual([{ i: "n1", x: "better idea", at: T0 + 5 }]);
    applyOp(s, { t: "topicNote", id: "t1", n: { i: "n1", x: "", at: T0 + 9 } });
    expect(s.topics[0].notes).toEqual([]);
  });

  it("links: add and remove", () => {
    applyOp(s, { t: "topicLink", id: "t1", l: { i: "l1", u: "https://example.com/a", x: "article", at: T0 + 1 } });
    expect(s.topics[0].links).toHaveLength(1);
    applyOp(s, { t: "topicLink", id: "t1", l: { i: "l1", u: "", x: "", at: T0 + 2 } });
    expect(s.topics[0].links).toHaveLength(0);
  });

  it("deleting a topic removes it; operations on a missing topic are ignored", () => {
    applyOp(s, { t: "topicDrop", id: "t1" });
    applyOp(s, { t: "topicNote", id: "t1", n: { i: "n1", x: "late", at: T0 + 1 } });
    expect(s.topics).toEqual([]);
  });

  it("the most recently changed topic is first", () => {
    applyOp(s, { t: "topicNew", p: topic({ id: "t2", name: "Second", up: T0 + 10 }) });
    expect(s.topics.map((t) => t.id)).toEqual(["t2", "t1"]);
    applyOp(s, { t: "topicNote", id: "t1", n: { i: "n1", x: "touch", at: T0 + 20 } });
    expect(s.topics.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

describe("topics: cleaning and merging", () => {
  it("broken topics are dropped; search words are lower-cased and de-duplicated; an unknown status becomes researching", () => {
    const out = normTopics([
      { id: "ok", name: " Hooks ", st: "weird", kw: ["Hook  Ideas", "hook ideas", ""], vids: [{ id: "aaaaaa" }, { id: "aaaaaa" }, {}] },
      { id: "", name: "no id" },
      { id: "noname", name: "  " },
      "nonsense",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Hooks", st: "researching", kw: ["hook ideas"] });
    expect(out[0].vids).toHaveLength(1);
    expect(TOPIC_STATUSES.map((x) => x.id)).toContain(out[0].st);
  });

  it("merging keeps what is here and adds what is missing (pins, notes, links, new topics)", () => {
    applyOp(s, { t: "topicVid", id: "t1", v: "aaaaaa", m: "pin", at: T0 + 1 });
    const other: Topic[] = [
      topic({
        vids: [{ id: "bbbbbb", at: T0 + 2, ti: "B" }],
        notes: [{ i: "n9", x: "from the other device", at: T0 + 3 }],
        up: T0 + 3,
      }),
      topic({ id: "t9", name: "Brand voice" }),
    ];
    mergeTopics(s.topics, other);
    const t1 = s.topics.find((t) => t.id === "t1")!;
    expect(t1.vids.map((v) => v.id).sort()).toEqual(["aaaaaa", "bbbbbb"]);
    expect(t1.notes).toHaveLength(1);
    expect(s.topics.map((t) => t.id).sort()).toEqual(["t1", "t9"]);
  });

  it("merging never undoes a pin that is already here", () => {
    applyOp(s, { t: "topicVid", id: "t1", v: "aaaaaa", m: "pin", at: T0 + 1 });
    mergeTopics(s.topics, [topic({ no: ["aaaaaa"] })]);
    expect(s.topics[0].vids.map((v) => v.id)).toEqual(["aaaaaa"]);
  });
});

describe("topics: in the synced file", () => {
  it("go to the file (version 7) and back; an older file without topics still loads", () => {
    applyOp(s, { t: "topicNote", id: "t1", n: { i: "n1", x: "keep me", at: T0 + 1 } });
    const file = toFile(s);
    expect(file.v).toBe(7);
    const back = fromFile(JSON.parse(JSON.stringify(file)));
    expect(back.topics[0].notes[0].x).toBe("keep me");
    expect(fromFile({ v: 6, saved: ["x"] } as never).topics).toEqual([]);
  });

  it("a first sync folds this device's topics into the cloud copy", () => {
    const base = emptyShared();
    applyOp(base, { t: "topicNew", p: topic({ id: "cloud", name: "In the cloud" }) });
    mergeInto(base, s);
    expect(base.topics.map((t) => t.id).sort()).toEqual(["cloud", "t1"]);
  });
});

describe("topics: finding videos by themselves", () => {
  const short = (id: string, t: string, over: Record<string, unknown> = {}) => ({
    id,
    ch: 0,
    t,
    p: 1,
    v: 1000,
    l: 0,
    c: 0,
    o: 0.5,
    e: 0.5,
    tr: 0,
    r: 0,
    k: [],
    lg: "en",
    g: false,
    ...over,
  });
  const titles = [
    "Why every brand ends up in a price war",
    "How a price war destroys small shops",
    "Escape the price war with better branding",
    "My morning routine for editing reels",
    "Three hook ideas for your next video",
    "Cheap discounts are a trap for stores",
    ...Array.from({ length: 30 }, (_, i) => `Filler video number ${i} about cooking pasta`),
  ];
  const app = {
    ds: {
      channels: [{ st: "active", n: "Ch" }],
      videos: titles.map((t, i) => short(`vid${String(i).padStart(4, "0")}`, t)),
    },
  } as never;

  it("matches the videos about the topic's words, not the unrelated ones", async () => {
    const { matchInLibrary } = await import("../../src/similar");
    const found = matchInLibrary(app, "price war", new Set()).map((s) => s.t);
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.every((t) => /price war/i.test(t))).toBe(true);
    expect(found).not.toContain("My morning routine for editing reels");
  });

  it("leaves out pinned videos and the ones marked “not about this”", async () => {
    const { matchInLibrary } = await import("../../src/similar");
    const skip = new Set(["vid0000", "vid0001"]);
    const found = matchInLibrary(app, "price war", skip).map((s) => s.id);
    expect(found).not.toContain("vid0000");
    expect(found).not.toContain("vid0001");
    expect(found).toContain("vid0002");
  });

  it("says a video fits a topic it is about, and not one it isn't", async () => {
    const { textSimilarity } = await import("../../src/similar");
    const about = textSimilarity(app, "Why every brand ends up in a price war", "price war discount");
    const other = textSimilarity(app, "My morning routine for editing reels", "price war discount");
    expect(about).toBeGreaterThan(0.18);
    expect(other).toBeLessThan(0.18);
  });
});
