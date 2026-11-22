/** Channel lists (Competitors, Inspiration…): the synced changes, merging, and each list's own feed. */
import { beforeEach, describe, expect, it } from "vitest";
import { buildQueue, feedFilter } from "../../src/rank";
import { applyOp, applyRestore, emptyShared, fromFile, mergeInto, migrateLocal, type State, toFile } from "../../src/store";
import type { Dataset } from "../../src/types";
import { makeDataset, NOW } from "../fixtures/data";

let ds: Dataset;
let st: State;
beforeEach(() => {
  ds = makeDataset();
  st = migrateLocal({ ...emptyShared(), tipsSeen: true, dataSaver: "off", autoFull: false });
});

describe("channel lists", () => {
  it("everyone starts with Competitors, Inspiration, Ads updates and AI updates (empty)", () => {
    expect(st.lists.map((l) => l.name)).toEqual(["Competitors", "Inspiration", "Ads updates", "AI updates"]);
    expect(st.lists.every((l) => !l.ch.length)).toBe(true);
    expect(st.list).toBe("");
  });

  it("add / remove channels (any case of the handle), make, rename and delete lists", () => {
    applyOp(st, { t: "listAdd", id: "comp", h: "@Alpha" });
    applyOp(st, { t: "listAdd", id: "comp", h: "@alpha" }); // same channel
    applyOp(st, { t: "listAdd", id: "insp", h: "@alpha" }); // a channel can be in several lists
    expect(st.lists.find((l) => l.id === "comp")!.ch).toEqual(["@Alpha"]);
    applyOp(st, { t: "listRemove", id: "comp", h: "@ALPHA" });
    expect(st.lists.find((l) => l.id === "comp")!.ch).toEqual([]);
    expect(st.lists.find((l) => l.id === "insp")!.ch).toEqual(["@alpha"]);

    applyOp(st, { t: "listNew", id: "x1", name: "Shopify experts", icon: "⭐" });
    applyOp(st, { t: "listEdit", id: "x1", name: "Shopify pros", icon: "🔥" });
    expect(st.lists.at(-1)).toMatchObject({ id: "x1", name: "Shopify pros", icon: "🔥", ch: [] });
    applyOp(st, { t: "listDrop", id: "x1" });
    applyOp(st, { t: "listAdd", id: "x1", h: "@alpha" }); // a list deleted on another device: ignored
    expect(st.lists.some((l) => l.id === "x1")).toBe(false);
  });

  it("goes to GitHub and back; an older file (no lists) gets the starting lists; deleted lists stay deleted", () => {
    applyOp(st, { t: "listAdd", id: "comp", h: "@alpha" });
    applyOp(st, { t: "listDrop", id: "aiup" });
    const back = fromFile(JSON.parse(JSON.stringify(toFile(st))));
    expect(back.lists.find((l) => l.id === "comp")!.ch).toEqual(["@alpha"]);
    expect(back.lists.some((l) => l.id === "aiup")).toBe(false);
    expect(fromFile({ v: 2, saved: [] } as never).lists.map((l) => l.id)).toEqual(["comp", "insp", "adsup", "aiup"]);
  });

  it("merging a device or a backup adds missing channels and lists, keeps what's there", () => {
    const base = emptyShared();
    applyOp(base, { t: "listAdd", id: "comp", h: "@ads" });
    const local = emptyShared();
    applyOp(local, { t: "listAdd", id: "comp", h: "@alpha" });
    applyOp(local, { t: "listNew", id: "x1", name: "Mine", icon: "📋" });
    applyOp(local, { t: "listAdd", id: "x1", h: "@bangla" });
    mergeInto(base, local);
    expect(base.lists.find((l) => l.id === "comp")!.ch).toEqual(["@ads", "@alpha"]);
    expect(base.lists.find((l) => l.id === "x1")!.ch).toEqual(["@bangla"]);

    const s = emptyShared();
    applyRestore(s, { lists: base.lists }, "replace");
    expect(s.lists).toEqual(base.lists);
  });

  it("a list's feed: only its channels' Shorts; the other feeds still have them", () => {
    applyOp(st, { t: "listAdd", id: "comp", h: "@alpha" });
    applyOp(st, { t: "listAdd", id: "comp", h: "@ads" });
    st.list = "comp";
    const allowed = new Set(["@alpha", "@ads"]);
    const { items } = buildQueue(ds, st, { prevVisit: NOW - 86400, exclude: new Set() }, 10);
    expect(items.length).toBeGreaterThan(0);
    for (const s of items) expect(allowed.has(ds.channels[s.ch].h)).toBe(true);

    st.list = "";
    const all = ds.videos.filter(feedFilter(ds, st));
    expect(all.some((s) => !allowed.has(ds.channels[s.ch].h))).toBe(true);
    expect(all.some((s) => allowed.has(ds.channels[s.ch].h))).toBe(true);
  });

  it("a list feed picked on a device whose list was deleted falls back to all channels", () => {
    expect(migrateLocal({ ...emptyShared(), list: "gone" } as never).list).toBe("");
    expect(migrateLocal({ ...emptyShared(), list: "comp" } as never).list).toBe("comp");
  });
});
