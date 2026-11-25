/** Facebook videos you add by link: the synced changes, merging, and how they join the feeds, lists and Saved. */
import { beforeEach, describe, expect, it } from "vitest";
import { applyManual, fbIdFromLink, fbPageOf, pageKey } from "../../src/fbdata";
import { listSize } from "../../src/lists";
import { buildQueue, feedFilter, shortInList } from "../../src/rank";
import { parse, toPath } from "../../src/router";
import {
  applyOp,
  emptyShared,
  type FbPage,
  fromFile,
  isFbId,
  type ManualVideo,
  mergeInto,
  migrateLocal,
  type State,
  toFile,
} from "../../src/store";
import type { Dataset } from "../../src/types";
import { makeDataset, NOW } from "../fixtures/data";

const video = (id: string, o: Partial<ManualVideo> = {}): ManualVideo => ({
  id,
  url: `https://www.facebook.com/reel/${id}/`,
  t: "Price hook",
  note: "",
  by: "",
  cats: ["sales"],
  lists: [],
  lg: "en",
  at: NOW - 60,
  v: 21000,
  l: 249,
  ...o,
});
const page = (o: Partial<FbPage> = {}): FbPage => ({
  key: "fb:boost",
  name: "Boost Marketing",
  url: "https://www.facebook.com/boost",
  ch: "",
  ...o,
});

let ds: Dataset;
let st: State;
beforeEach(() => {
  ds = makeDataset();
  st = migrateLocal({ ...emptyShared(), tipsSeen: true, dataSaver: "off", autoFull: false });
});

describe("added Facebook videos", () => {
  it("add, edit, delete (delete also takes it out of Saved)", () => {
    applyOp(st, { t: "manAdd", v: video("1111111111") });
    applyOp(st, { t: "manAdd", v: video("1111111111", { t: "twice" }) }); // same video: ignored
    expect(st.manual).toHaveLength(1);
    applyOp(st, { t: "manEdit", v: video("1111111111", { note: "hook in 2 s" }) });
    expect(st.manual[0].note).toBe("hook in 2 s");
    applyOp(st, { t: "save", id: "fb1111111111" });
    applyOp(st, { t: "save", id: "a1" });
    applyOp(st, { t: "manDel", id: "1111111111" });
    expect(st.manual).toEqual([]);
    expect(st.saved).toEqual(["a1"]);
  });

  it("goes to GitHub and back; a broken entry is dropped; merging adds what's missing", () => {
    applyOp(st, { t: "pageSet", p: page() });
    applyOp(st, { t: "manAdd", v: video("2222222222", { by: "fb:boost" }) });
    const back = fromFile(JSON.parse(JSON.stringify(toFile(st))));
    expect(back.manual.map((m) => m.id)).toEqual(["2222222222"]);
    expect(back.fbPages).toEqual([page()]);
    expect(toFile(st).v).toBe(8);
    expect(fromFile({ v: 4, manual: [{ id: "x" }, video("3333333333")] } as never).manual.map((m) => m.id)).toEqual(["3333333333"]);

    const base = emptyShared();
    applyOp(base, { t: "manAdd", v: video("4444444444") });
    mergeInto(base, back);
    expect(base.manual.map((m) => m.id).sort()).toEqual(["2222222222", "4444444444"]);
    expect(base.fbPages.map((p) => p.key)).toEqual(["fb:boost"]);
  });

  it("a file from a newer app is refused, not overwritten (this app writes version 8)", () => {
    expect(() => fromFile({ v: 9 } as never)).toThrow();
  });

  it("join the library as Shorts: their own Facebook page, or the YouTube channel you linked", () => {
    applyOp(st, { t: "pageSet", p: page() });
    applyOp(st, { t: "pageSet", p: page({ key: "fb:alpha.fb", name: "Alpha on FB", ch: "@alpha" }) });
    applyOp(st, { t: "manAdd", v: video("5555555555", { by: "fb:boost" }) });
    applyOp(st, { t: "manAdd", v: video("6666666666", { by: "fb:alpha.fb", at: NOW - 30 }) });
    applyOp(st, { t: "manAdd", v: video("7777777777", { t: "" }) });
    const n = ds.videos.length;
    applyManual(ds, st);
    applyManual(ds, st); // again (after a change): no copies
    expect(ds.videos).toHaveLength(n + 3);
    const s5 = ds.videos.find((s) => s.id === "fb5555555555")!;
    expect(ds.channels[s5.ch]).toMatchObject({ h: "fb:boost", n: "Boost Marketing", st: "fb" });
    const s6 = ds.videos.find((s) => s.id === "fb6666666666")!;
    expect(ds.channels[s6.ch].h).toBe("@alpha");
    expect(fbPageOf(st, ds.videos.find((s) => s.ch === s6.ch && !s.fb)!, "@alpha")?.name).toBe("Alpha on FB");
    expect(ds.videos.find((s) => s.id === "fb7777777777")!.t).toMatch(/^Facebook video · /);
    expect(isFbId("fb5555555555") && !isFbId("dQw4w9WgXcQ")).toBe(true);
  });

  it("a list's feed has the video when you put it in the list, or its page is in the list", () => {
    applyOp(st, { t: "pageSet", p: page() });
    applyOp(st, { t: "manAdd", v: video("8888888888", { lists: ["comp"] }) });
    applyOp(st, { t: "manAdd", v: video("9999999999", { by: "fb:boost" }) });
    applyOp(st, { t: "listAdd", id: "insp", h: "fb:boost" });
    applyManual(ds, st);
    const ids = (list: string) => ds.videos.filter(feedFilter(ds, { ...st, list })).map((s) => s.id);
    expect(ids("comp")).toEqual(["fb8888888888"]);
    expect(ids("insp")).toEqual(["fb9999999999"]);
    expect(ids("")).toEqual(expect.arrayContaining(["fb8888888888", "fb9999999999"]));
    const comp = st.lists.find((l) => l.id === "comp")!;
    expect(shortInList(comp, ds.videos.find((s) => s.id === "fb8888888888")!, "fb:")).toBe(true);
    // a list with only a video you put in it still has a feed (its chip shows)
    expect(comp.ch).toEqual([]);
    expect(listSize(comp, st)).toBe(1);
    // its category feed too
    st.cats = ["sales"];
    const { items } = buildQueue(ds, st, { prevVisit: NOW - 86400, exclude: new Set() }, 200);
    expect(items.some((s) => s.fb)).toBe(true);
  });

  it("links: the video number from direct links, page keys, and /v/ addresses for fb ids", () => {
    expect(fbIdFromLink("https://www.facebook.com/reel/1162877719417601/?s=1")).toBe("1162877719417601");
    expect(fbIdFromLink("https://www.facebook.com/boost/videos/1234567890123/")).toBe("1234567890123");
    expect(fbIdFromLink("https://www.facebook.com/watch/?v=1234567890")).toBe("1234567890");
    expect(fbIdFromLink("https://www.facebook.com/share/v/1CwWegbMzR/")).toBeNull(); // needs the lookup
    expect(fbIdFromLink("https://example.com/reel/1234567890")).toBeNull();
    expect(pageKey("MD Zahid Hasan", "https://www.facebook.com/md.zahid.hasan.390411")).toBe("fb:md.zahid.hasan.390411");
    expect(pageKey("Boost Marketing", "/61595841376442")).toBe("fb:61595841376442");
    expect(pageKey("Boost Marketing")).toBe("fb:boost marketing");
    expect(parse(toPath({ k: "feed", v: "fb1162877719417601" }), "/")).toEqual({ k: "feed", v: "fb1162877719417601" });
    expect(parse("/added", "/")).toEqual({ k: "panel", tab: "added" });
  });
});
