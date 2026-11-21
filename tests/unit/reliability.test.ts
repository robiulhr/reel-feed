import { describe, expect, it } from "vitest";
import { capPending, FILE_VERSION, fromFile, LOCAL_VERSION, migrateLocal, NewerDataError, type Op } from "../../src/store";
import { daysLeft } from "../../src/health";

describe("saved-data versioning", () => {
  it("upgrades data saved before versioning existed (and repairs broken fields)", () => {
    const old = { saved: ["a"], hidden: "oops", seen: null, muted: false } as any;
    const s = migrateLocal(old);
    expect(s.sv).toBe(LOCAL_VERSION);
    expect(s.saved).toEqual(["a"]);
    expect(s.hidden).toEqual([]);
    expect(s.seen).toEqual({});
    expect(s.muted).toBe(false); // your settings are kept
    expect(s.volume).toBe(100); // new settings get their defaults
  });

  it("refuses data written by a NEWER version of the app (so an old phone can't overwrite it)", () => {
    expect(() => fromFile({ v: FILE_VERSION + 1 } as any)).toThrow(NewerDataError);
    expect(() => fromFile({ v: FILE_VERSION, saved: ["x"] } as any)).not.toThrow();
  });
});

describe("upload queue size limit", () => {
  it("drops the least important changes first (seen → learn → api), keeps saves", () => {
    const ops: Op[] = [];
    for (let i = 0; i < 30; i++) ops.push({ t: "seen", id: `s${i}`, at: i });
    ops.push({ t: "save", id: "keep-me" });
    for (let i = 0; i < 10; i++) ops.push({ t: "learn", h: "@x", cat: "ads", d: 1 });
    capPending(ops, 15);
    expect(ops.length).toBe(15);
    expect(ops.some((o) => o.t === "save")).toBe(true);
    expect(ops.filter((o) => o.t === "seen").length).toBe(4); // 30 seen trimmed down first
  });

  it("does nothing when under the limit", () => {
    const ops: Op[] = [{ t: "save", id: "a" }];
    capPending(ops, 10);
    expect(ops).toEqual([{ t: "save", id: "a" }]);
  });
});

describe("token expiry", () => {
  it("reads GitHub's date format", () => {
    const in40 = new Date(Date.now() + 40.5 * 86400_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    expect(daysLeft(in40)).toBe(40);
    expect(daysLeft(null)).toBeNull();
    expect(daysLeft("garbage")).toBeNull();
  });
});
