import { beforeEach, describe, expect, it } from "vitest";
import { applyPlaylistOp, mergePlaylists, moved, normPlaylists, type Playlist, playOrder } from "../../src/playlistdata";
import { applyOp, emptyShared, fromFile, migrateLocal, mergeInto, type Shared, toFile } from "../../src/store";

const T0 = 1_800_000_000;
const pl = (over: Partial<Playlist> = {}): Playlist => ({
  id: "p1",
  name: "Tilawat for sleep",
  ids: ["aaaaaa", "bbbbbb"],
  at: T0,
  up: T0,
  ...over,
});

let s: Shared;
beforeEach(() => {
  s = emptyShared();
  applyOp(s, { t: "plNew", p: pl() });
});

describe("playlists: operations", () => {
  it("a new playlist is added once; the same id again is ignored", () => {
    applyOp(s, { t: "plNew", p: pl({ name: "Other" }) });
    expect(s.playlists).toHaveLength(1);
    expect(s.playlists[0].name).toBe("Tilawat for sleep");
  });

  it("adding a video puts it at the end, once", () => {
    applyOp(s, { t: "plAdd", id: "p1", v: "cccccc", up: T0 + 1 });
    applyOp(s, { t: "plAdd", id: "p1", v: "cccccc", up: T0 + 2 });
    applyOp(s, { t: "plAdd", id: "p1", v: "aaaaaa", up: T0 + 3 });
    expect(s.playlists[0].ids).toEqual(["aaaaaa", "bbbbbb", "cccccc"]);
  });

  it("a new order and name: the newer change wins, an older one from another device doesn't overwrite it", () => {
    applyOp(s, { t: "plSet", id: "p1", name: "Night", ids: ["bbbbbb", "aaaaaa"], up: T0 + 50 });
    applyOp(s, { t: "plSet", id: "p1", name: "Old name", ids: ["aaaaaa"], up: T0 + 10 });
    expect(s.playlists[0]).toMatchObject({ name: "Night", ids: ["bbbbbb", "aaaaaa"] });
  });

  it("deleting removes it; operations on a missing playlist are ignored", () => {
    applyOp(s, { t: "plDrop", id: "p1" });
    applyOp(s, { t: "plAdd", id: "p1", v: "zzzzzz", up: T0 + 1 });
    expect(s.playlists).toEqual([]);
  });

  it("the most recently changed playlist comes first", () => {
    applyOp(s, { t: "plNew", p: pl({ id: "p2", name: "Second", up: T0 + 10 }) });
    expect(s.playlists.map((p) => p.id)).toEqual(["p2", "p1"]);
    applyOp(s, { t: "plAdd", id: "p1", v: "dddddd", up: T0 + 20 });
    expect(s.playlists.map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("playlists: cleaning, merging, order", () => {
  it("broken playlists and duplicate videos are dropped", () => {
    const out = normPlaylists([
      { id: "a", name: " Mix ", ids: ["x1", "x1", "", 5, "x2"] },
      { id: "", name: "no id" },
      { id: "b", name: "  " },
      "junk",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Mix", ids: ["x1", "x2"] });
  });

  it("merging keeps what is here, adds new playlists and videos added elsewhere", () => {
    applyOp(s, { t: "plAdd", id: "p1", v: "cccccc", up: T0 + 1 });
    mergePlaylists(s.playlists, [pl({ ids: ["aaaaaa", "bbbbbb", "dddddd"] }), pl({ id: "p9", name: "New one", ids: ["q1"] })]);
    expect(s.playlists.find((p) => p.id === "p1")!.ids.sort()).toEqual(["aaaaaa", "bbbbbb", "cccccc", "dddddd"]);
    expect(s.playlists.map((p) => p.id).sort()).toEqual(["p1", "p9"]);
  });

  it("moved() puts an item at another position and leaves the original alone", () => {
    const a = ["a", "b", "c", "d"];
    expect(moved(a, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moved(a, 0, 1)).toEqual(["b", "a", "c", "d"]);
    expect(moved(a, 0, 9)).toEqual(a);
    expect(a).toEqual(["a", "b", "c", "d"]);
  });

  it("shuffling keeps every video exactly once; not shuffling keeps the order", () => {
    const a = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const sh = playOrder(a, true);
    expect([...sh].sort()).toEqual([...a].sort());
    expect(playOrder(a, false)).toBe(a);
  });
});

describe("playlists: saved with your data, and the playback choices", () => {
  it("go to the file (version 8) and back; an older file without playlists still loads", () => {
    const file = toFile(s);
    expect(file.v).toBe(8);
    const back = fromFile(JSON.parse(JSON.stringify(file)));
    expect(back.playlists[0].ids).toEqual(["aaaaaa", "bbbbbb"]);
    expect(fromFile({ v: 7, saved: ["x"] } as never).playlists).toEqual([]);
  });

  it("a first sync folds this device's playlists into the cloud copy", () => {
    const base = emptyShared();
    applyOp(base, { t: "plNew", p: pl({ id: "cloud", name: "In the cloud" }) });
    mergeInto(base, s);
    expect(base.playlists.map((p) => p.id).sort()).toEqual(["cloud", "p1"]);
  });

  it("the end-of-video choice defaults to repeat (as before) and a bad saved value falls back to it", () => {
    expect(migrateLocal({}).endMode).toBe("loop");
    expect(migrateLocal({ endMode: "next" } as never).endMode).toBe("next");
    expect(migrateLocal({ endMode: "weird" } as never).endMode).toBe("loop");
    expect(migrateLocal({}).listRepeat).toBe(false);
    expect(migrateLocal({}).shuffle).toBe(false);
  });
});
