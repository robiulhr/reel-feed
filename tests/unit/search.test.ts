import { beforeEach, describe, expect, it } from "vitest";
import { searchNotes, searchTopics, searchVideos, wordsOf } from "../../src/searchcore";
import { applyOp, state } from "../../src/store";

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
const app = {
  ds: {
    channels: [
      { st: "active", n: "Ads Lab" },
      { st: "removed", n: "Gone Channel" },
    ],
    videos: [
      short("aaaaaa", "Why every brand ends up in a price war"),
      short("bbbbbb", "How to write a hook in two seconds", { v: 90000 }),
      short("cccccc", "Pricing your service without fear", { ch: 0 }),
      short("dddddd", "Secret about prices", { ch: 1 }),
      short("eeeeee", "ফেসবুক বিজ্ঞাপন টিপস"),
    ],
  },
} as never;

beforeEach(() => {
  state.saved = [];
  state.notes = {};
  state.topics = [];
});

describe("search: videos", () => {
  it("words match from the start, every word must match, any order", () => {
    expect(searchVideos(app, "pric").map((s) => s.id)).toEqual(expect.arrayContaining(["aaaaaa", "cccccc"]));
    expect(searchVideos(app, "war price").map((s) => s.id)).toEqual(["aaaaaa"]);
    expect(searchVideos(app, "price banana")).toEqual([]);
  });

  it("matches the channel name, and leaves out removed channels", () => {
    expect(searchVideos(app, "ads lab").length).toBeGreaterThan(0);
    expect(searchVideos(app, "secret")).toEqual([]); // that channel was removed
  });

  it("finds Bangla titles", () => {
    expect(searchVideos(app, "বিজ্ঞাপন").map((s) => s.id)).toEqual(["eeeeee"]);
  });

  it("finds a video by your own note on it, and by the topic it is pinned in", () => {
    applyOp(state, { t: "note", id: "bbbbbb", x: "copy this opening for our reel", at: 100, ti: "How to write a hook" });
    expect(searchVideos(app, "opening").map((s) => s.id)).toEqual(["bbbbbb"]);
    applyOp(state, {
      t: "topicNew",
      p: {
        id: "t1",
        name: "Cold outreach",
        why: "",
        st: "idea",
        kw: [],
        vids: [{ id: "cccccc", at: 1, ti: "" }],
        no: [],
        notes: [],
        links: [],
        at: 1,
        up: 1,
      },
    });
    expect(searchVideos(app, "outreach").map((s) => s.id)).toEqual(["cccccc"]);
  });

  it("filters: saved, with notes", () => {
    state.saved = ["aaaaaa"];
    expect(searchVideos(app, "price", "saved").map((s) => s.id)).toEqual(["aaaaaa"]);
    applyOp(state, { t: "note", id: "cccccc", x: "pricing idea", at: 1, ti: "" });
    expect(searchVideos(app, "pric", "notes").map((s) => s.id)).toEqual(["cccccc"]);
  });

  it("an exact word ranks above one that only starts with it", () => {
    const ids = searchVideos(app, "price").map((s) => s.id);
    expect(ids[0]).toBe("aaaaaa"); // "price" itself, before "pricing"
  });

  it("an empty search finds nothing", () => {
    expect(searchVideos(app, "   ")).toEqual([]);
    expect(wordsOf("  Hello,  World! ")).toEqual(["hello", "world"]);
  });
});

describe("search: notes and topics", () => {
  it("finds notes by their words or their video's title", () => {
    applyOp(state, { t: "note", id: "bbbbbb", x: "great hook", at: 5, ti: "Two second opener" });
    expect(searchNotes("opener").map(([id]) => id)).toEqual(["bbbbbb"]);
    expect(searchNotes("hook").map(([id]) => id)).toEqual(["bbbbbb"]);
    expect(searchNotes("zzz")).toEqual([]);
  });

  it("finds topics by name, why, search words or notes", () => {
    applyOp(state, {
      t: "topicNew",
      p: {
        id: "t1",
        name: "Price war",
        why: "discount culture",
        st: "researching",
        kw: ["undercutting"],
        vids: [],
        no: [],
        notes: [{ i: "n1", x: "Nike avoided it", at: 1 }],
        links: [],
        at: 1,
        up: 1,
      },
    });
    for (const q of ["price", "discount", "undercut", "nike"])
      expect(
        searchTopics(q).map((t) => t.id),
        q,
      ).toEqual(["t1"]);
    expect(searchTopics("banana")).toEqual([]);
  });
});
