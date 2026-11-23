import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualVideo } from "../../src/store";

const open = async () => {
  vi.resetModules();
  return await import("../../src/store");
};
const video = (id: string, t = `Video ${id}`): ManualVideo => ({
  id,
  url: `https://www.facebook.com/reel/${id}/`,
  t,
  note: "",
  by: "",
  cats: ["ads"],
  lists: [],
  lg: "en",
  at: 100,
  v: 1,
  l: 1,
});

beforeEach(() => localStorage.clear());

describe("the activity log (what happened, in words)", () => {
  it("every real change writes one line, with the title, and it can be looked up later", async () => {
    const s = await open();
    s.act({ t: "manAdd", v: video("100000000001", "Hide the price, lose the sale") });
    s.act({ t: "note", id: "fb100000000001", x: "use as a hook", at: 5, ti: "Hide the price, lose the sale" });
    s.act({ t: "save", id: "fb100000000001" });
    s.act({ t: "hide", h: "@somechannel" });
    s.act({ t: "manDel", id: "100000000001" });
    const lines = s.state.activity.map((e) => e.x);
    expect(lines).toContain("Added a Facebook video “Hide the price, lose the sale”");
    expect(lines).toContain("Wrote a note on “Hide the price, lose the sale”");
    expect(lines).toContain("Saved a video");
    expect(lines).toContain("Hid the channel @somechannel");
    expect(lines).toContain("Deleted a Facebook video “Hide the price, lose the sale”"); // knew the title before deleting it
    expect(s.state.activity.length).toBe(5);
    expect(new Set(s.state.activity.map((e) => e.i)).size).toBe(5);
    expect(s.state.activity.every((e) => e.at > 0 && ["phone", "computer"].includes(e.d))).toBe(true);
  });

  it("background bookkeeping isn't logged (seen marks, learning, watch history, API use)", async () => {
    const s = await open();
    s.act({ t: "seen", id: "abc", at: 1 });
    s.act({ t: "learn", h: "@x", cat: "ads", d: 1 });
    s.act({ t: "api", at: 1, units: 5, what: "lookup" });
    expect(s.state.activity.length).toBe(0);
  });

  it("a batch is one line (quiet changes + one log line), and a duplicate add isn't logged twice", async () => {
    const s = await open();
    for (let i = 0; i < 60; i++) s.act({ t: "manAdd", v: video(String(300000000000 + i)) }, { quiet: true });
    s.logActivity("video", "Added 60 Facebook videos at once");
    expect(s.state.activity.map((e) => e.x)).toEqual(["Added 60 Facebook videos at once"]);
    s.act({ t: "manAdd", v: video("300000000000") }); // already there
    expect(s.state.activity.length).toBe(1);
  });

  it("goes to the cloud file (version 7) and back; broken lines are dropped; an older app can't overwrite it", async () => {
    const s = await open();
    s.act({ t: "manAdd", v: video("100000000002") });
    const file = s.toFile(s.sharedOf(s.state));
    expect(file.v).toBe(7);
    expect(file.activity?.length).toBe(1);
    const back = s.fromFile({
      ...file,
      activity: [...(file.activity ?? []), { i: "", x: "no id" }, { i: "z", x: "bad kind", k: "nope" }, null],
    } as never);
    expect(back.activity.length).toBe(1);
    expect(() => s.fromFile({ v: 8 } as never)).toThrow(s.NewerDataError);
  });

  it("two devices' logs merge without repeats, newest first", async () => {
    const s = await open();
    const e = (i: string, at: number, d: "phone" | "computer") => ({ i, at, d, k: "note" as const, x: `line ${i}` });
    const base = s.emptyShared();
    base.activity = [e("a", 30, "phone"), e("b", 10, "phone")];
    const local = s.emptyShared();
    local.activity = [e("b", 10, "phone"), e("c", 20, "computer")];
    s.mergeInto(base, local);
    expect(base.activity.map((x) => x.i)).toEqual(["a", "c", "b"]);
  });

  it("which changes go to the cloud at once", async () => {
    const s = await open();
    for (const t of ["manAdd", "manDel", "note", "save", "hide", "listAdd", "catFix"] as const)
      expect(s.isImportantOp({ t } as never)).toBe(true);
    for (const t of ["seen", "learn", "api", "watch", "activity", "histClear"] as const)
      expect(s.isImportantOp({ t } as never)).toBe(false);
  });
});

/** The sync module against a pretend cloud, with the clock under our control. */
describe("syncing your changes", () => {
  type Reply = { status?: number; json?: unknown };
  let puts: any[];
  /** What the pretend cloud answers. `old`: a server from before the pass-through addresses (they answer 404 "Not found"). */
  let script: { put: (n: number) => Reply; get: () => Reply; old: boolean };
  const text = (data: unknown) => Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const untext = (b64: string) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_SYNC_URL", "http://sync.test");
    puts = [];
    script = { put: () => ({ json: { sha: "s1" } }), get: () => ({ json: { data: null, sha: null } }), old: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = new URL(url).pathname;
        const method = init.method ?? "GET";
        const reply = (r: Reply) =>
          new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
        if (path === "/login") return reply({ json: { session: "x.y" } });
        // the newer addresses: the data file passed through as base64 text
        if (path === "/state2" || path === "/state/at2") {
          if (script.old) return reply({ status: 404, json: { error: "Not found" } });
          if (method === "GET") {
            const r = script.get();
            const j = r.json as { data?: unknown; sha?: string | null } | undefined;
            return reply({
              status: r.status,
              json: r.status && r.status >= 400 ? r.json : { content: j?.data ? text(j.data) : null, sha: j?.sha ?? null },
            });
          }
          const body = JSON.parse(String(init.body));
          expect(typeof body.content).toBe("string"); // no parsed data sent to the server: just the encoded text
          expect(body.data).toBeUndefined();
          puts.push({ data: untext(body.content), sha: body.sha, message: body.message });
          return reply(script.put(puts.length));
        }
        // the older addresses
        if (path === "/state" && method === "GET") return reply(script.get());
        if (path === "/state") {
          puts.push(JSON.parse(String(init.body)));
          return reply(script.put(puts.length));
        }
        return reply({ status: 404, json: { error: "Not found" } });
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const setup = async () => {
    vi.resetModules();
    const store = await import("../../src/store");
    const sync = await import("../../src/sync");
    sync.startSync(() => {});
    expect(await sync.connect("pw")).toBeNull();
    puts.length = 0;
    return { store, sync };
  };
  const video = (id: string): ManualVideo => ({
    id,
    url: `https://www.facebook.com/reel/${id}/`,
    t: "T",
    note: "",
    by: "",
    cats: ["ads"],
    lists: [],
    lg: "en",
    at: 1,
    v: 1,
    l: 1,
  });

  it("your own changes reach the cloud in about a second (not a minute), together", async () => {
    const { store, sync } = await setup();
    store.act({ t: "manAdd", v: video("100000000010") });
    store.act({ t: "manAdd", v: video("100000000011") });
    expect(sync.status().unsaved).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(puts.length).toBe(0); // not before the short wait
    await vi.advanceTimersByTimeAsync(600);
    expect(puts.length).toBe(1); // both went in one save
    expect(puts[0].data.manual.map((m: ManualVideo) => m.id).sort()).toEqual(["100000000010", "100000000011"]);
    expect(puts[0].data.activity.length).toBe(2); // and the log line for each
    expect(sync.status().unsaved).toBe(0);
    expect(sync.status().lastError).toBe("");
  });

  it("background bookkeeping waits for the normal minute", async () => {
    const { store } = await setup();
    store.act({ t: "seen", id: "abc", at: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts.length).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(puts.length).toBe(1);
  });

  it("when the cloud can't be reached it says so, keeps the change, and tries again until it works", async () => {
    const { store, sync } = await setup();
    script.put = (n) => (n < 3 ? { status: 500, json: { error: "server down" } } : { json: { sha: "s9" } });
    store.act({ t: "note", id: "abc", x: "hello", at: 5, ti: "T" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts.length).toBe(1);
    expect(sync.status().lastError).toContain("server down");
    expect(sync.status().unsaved).toBeGreaterThan(0); // still waiting: nothing lost
    await vi.advanceTimersByTimeAsync(3100); // first retry
    expect(puts.length).toBe(2);
    await vi.advanceTimersByTimeAsync(10_100); // second retry works
    expect(puts.length).toBe(3);
    expect(sync.status().lastError).toBe("");
    expect(sync.status().unsaved).toBe(0);
  });

  it("four conflicts in a row is a problem to retry, not a silent success", async () => {
    const { store, sync } = await setup();
    script.put = (n) => (n <= 4 ? { status: 409, json: { error: "conflict" } } : { json: { sha: "s5" } });
    store.act({ t: "hide", h: "@x" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync.status().lastError).toContain("saved at the same moment");
    expect(sync.status().unsaved).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(3100);
    expect(sync.status().lastError).toBe("");
    expect(sync.status().unsaved).toBe(0);
  });

  it("the log of what happened on this device records saves and failures", async () => {
    const { store } = await setup();
    const log = await import("../../src/locallog");
    store.act({ t: "hide", h: "@x" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(log.localLog().some((e) => e.k === "sync" && e.ok && /Saved 1 change/.test(e.x))).toBe(true);
    script.put = () => ({ status: 500, json: { error: "boom" } });
    store.act({ t: "hide", h: "@y" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(log.localLog().some((e) => e.k === "sync" && !e.ok && /boom/.test(e.x))).toBe(true);
  });

  it("not connected: changing something warns once (not for every change), and says so in the status", async () => {
    vi.resetModules();
    const store = await import("../../src/store");
    const sync = await import("../../src/sync");
    const cloud = await import("../../src/cloud");
    const warn = vi.fn();
    sync.onUnprotected(warn);
    sync.startSync(() => {});
    expect(cloud.cloudState().kind).toBe("off"); // nothing worth protecting yet
    store.act({ t: "manAdd", v: video("100000000020") });
    store.act({ t: "manAdd", v: video("100000000021") });
    store.act({ t: "seen", id: "x", at: 1 }); // background: no warning
    expect(warn).toHaveBeenCalledTimes(1);
    expect(cloud.cloudState().kind).toBe("local");
    expect(cloud.cloudState().text).toContain("Not backed up");
  });

  it("status wording when connected: saving, saved, can't reach", async () => {
    const { store } = await setup();
    const cloud = await import("../../src/cloud");
    expect(cloud.cloudState().kind).toBe("ok");
    expect(cloud.cloudState().text).toContain("All saved to the cloud");
    store.act({ t: "hide", h: "@x" });
    expect(cloud.cloudState().kind).toBe("saving");
    await vi.advanceTimersByTimeAsync(1000);
    expect(cloud.cloudState().kind).toBe("ok");
    script.put = () => ({ status: 500, json: { error: "down" } });
    store.act({ t: "hide", h: "@y" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(cloud.cloudState().kind).toBe("error");
    expect(cloud.cloudState().text).toContain("not saved yet");
  });

  it("the data file goes through the server as encoded text (the server never parses it)", async () => {
    const { store } = await setup();
    store.act({ t: "manAdd", v: { ...video("100000000030"), t: "দাম লুকালে সেল কমে" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts.length).toBe(1);
    expect(puts[0].data.manual[0].t).toBe("দাম লুকালে সেল কমে"); // non-English text survives the round trip
    expect(puts[0].message).toMatch(/^Sync from (phone|computer) \(\d+ changes?\)$/);
  });

  it("reads what's already in the cloud (decoded in the browser) and keeps it when saving", async () => {
    const existing = { v: 6, saved: ["fb100000000040"], manual: [{ ...video("100000000040"), t: "Already there" }], activity: [] };
    script.get = () => ({ json: { data: existing, sha: "s0" } });
    vi.resetModules();
    const store = await import("../../src/store");
    const sync = await import("../../src/sync");
    sync.startSync(() => {});
    await sync.connect("pw");
    expect(store.state.manual.map((m) => m.id)).toEqual(["100000000040"]);
    store.act({ t: "manAdd", v: video("100000000041") });
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts.at(-1).sha).toBe("s0");
    expect(
      puts
        .at(-1)
        .data.manual.map((m: ManualVideo) => m.id)
        .sort(),
    ).toEqual(["100000000040", "100000000041"]);
  });

  it("an older server (without the pass-through addresses) still works, the old way", async () => {
    script.old = true;
    const { store, sync } = await setup();
    store.act({ t: "hide", h: "@x" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts.length).toBe(1);
    expect(puts[0].data.hidden).toContain("@x"); // sent as parsed data, like before
    expect(sync.status().lastError).toBe("");
    expect(sync.status().unsaved).toBe(0);
  });

  it("restoring an earlier version reads it through the server too", async () => {
    const sync = await (async () => {
      vi.resetModules();
      const m = await import("../../src/sync");
      await import("../../src/store");
      await m.connect("pw");
      return m;
    })();
    script.get = () => ({ json: { data: { v: 6, saved: ["old"] }, sha: "x" } });
    expect((await sync.readVersion("a".repeat(40))).saved).toEqual(["old"]);
  });
});
