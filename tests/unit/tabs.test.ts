import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualVideo } from "../../src/store";

/**
 * Several Reel Feed tabs open at once (the browser extension opens a new one for every batch of videos).
 * Each tab holds its own copy of your data and saves it to the same place on the device, so without care
 * the last tab to save wipes what the others added. Every `open()` below is one tab: a fresh copy of the
 * store that reads what's on the device when it starts, like a real tab does.
 */
const open = async () => {
  vi.resetModules();
  return await import("../../src/store");
};
const video = (id: string, at: number): ManualVideo => ({
  id,
  url: `https://www.facebook.com/reel/${id}/`,
  t: `Video ${id}`,
  note: "",
  by: "",
  cats: ["ads"],
  lists: [],
  lg: "en",
  at,
  v: 1,
  l: 1,
});
const ids = (s: { state: { manual: { id: string }[] } }) => s.state.manual.map((m) => m.id).sort();
const storageEvent = (key = "ecomgy-reel-feed.v1") => window.dispatchEvent(new StorageEvent("storage", { key }));

beforeEach(() => localStorage.clear());

describe("several tabs saving to the same device", () => {
  it("a tab that was open earlier doesn't wipe what another tab added", async () => {
    const a = await open();
    const b = await open(); // both opened with nothing saved
    a.act({ t: "manAdd", v: video("100000000001", 10) });
    a.flushPersist();
    b.act({ t: "manAdd", v: video("100000000002", 20) }); // b never heard about the first one
    b.flushPersist();
    const reloaded = await open();
    expect(ids(reloaded)).toEqual(["100000000001", "100000000002"]);
    expect(reloaded.pending.filter((o) => o.t === "manAdd").length).toBe(2); // and both are still waiting to sync
  });

  it("many tabs, many videos: nothing is lost (the 500-video case)", async () => {
    const tabs = [await open(), await open(), await open()];
    let n = 0;
    for (let round = 0; round < 6; round++) {
      for (const t of tabs) {
        for (let i = 0; i < 30; i++) t.act({ t: "manAdd", v: video(String(200000000000 + n++), n) });
        t.flushPersist();
      }
    }
    const reloaded = await open();
    expect(reloaded.state.manual.length).toBe(540);
    expect(new Set(reloaded.state.manual.map((m) => m.id)).size).toBe(540);
  });

  it("a delete in one tab isn't undone by another tab that still had the video", async () => {
    const a = await open();
    a.act({ t: "manAdd", v: video("100000000001", 10) });
    a.flushPersist();
    const b = await open(); // opens with the video
    b.act({ t: "manDel", id: "100000000001" });
    b.flushPersist();
    a.act({ t: "manAdd", v: video("100000000002", 20) }); // a still shows the old video
    a.flushPersist();
    const reloaded = await open();
    expect(ids(reloaded)).toEqual(["100000000002"]);
  });

  it("the other tab sees the change at once (the browser's storage event) and refreshes the screen", async () => {
    const a = await open();
    const seen = vi.fn();
    a.onOtherTab(seen);
    const b = await open();
    b.act({ t: "manAdd", v: video("100000000003", 30) });
    b.flushPersist();
    storageEvent(); // what the browser tells the other tabs
    await vi.waitFor(() => expect(ids(a)).toEqual(["100000000003"]));
    expect(seen).toHaveBeenCalled();
    // taking it in doesn't write anything back (no ping-pong between tabs)
    const before = localStorage.getItem("ecomgy-reel-feed.v1");
    storageEvent();
    await new Promise((r) => setTimeout(r, 50));
    expect(localStorage.getItem("ecomgy-reel-feed.v1")).toBe(before);
  });

  it("this tab's own unsaved change survives taking in another tab's", async () => {
    const a = await open();
    const b = await open();
    a.act({ t: "manAdd", v: video("100000000004", 40) }); // not saved yet (the 300 ms wait)
    b.act({ t: "manAdd", v: video("100000000005", 50) });
    b.flushPersist();
    storageEvent();
    await vi.waitFor(() => expect(ids(a)).toEqual(["100000000004", "100000000005"]));
    a.flushPersist();
    const reloaded = await open();
    expect(ids(reloaded)).toEqual(["100000000004", "100000000005"]);
  });
});

describe("when the device can't save", () => {
  it("says so (once) instead of failing silently", async () => {
    const s = await open();
    const warn = vi.fn();
    s.onSaveFailed(warn);
    const full = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      s.act({ t: "manAdd", v: video("100000000006", 60) });
      s.flushPersist();
      s.act({ t: "manAdd", v: video("100000000007", 70) });
      s.flushPersist();
    } finally {
      full.mockRestore();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    s.act({ t: "manAdd", v: video("100000000008", 80) });
    s.flushPersist(); // storage works again: everything since is saved
    const reloaded = await open();
    expect(ids(reloaded)).toEqual(["100000000006", "100000000007", "100000000008"]);
  });
});
