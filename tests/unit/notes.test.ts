/** Notes on videos: writing, deleting, merging between devices, the file, backups, and the old Facebook note. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptManualNotes,
  applyOp,
  applyRestore,
  emptyShared,
  fromFile,
  MAX_NOTE,
  type ManualVideo,
  mergeInto,
  migrateLocal,
  normNotes,
  type Shared,
  snap,
  toFile,
} from "../../src/store";

let s: Shared;
beforeEach(() => {
  s = emptyShared();
});

const fbVideo = (id: string, note: string): ManualVideo => ({
  id,
  url: `https://www.facebook.com/reel/${id}/`,
  t: "Price hook",
  note,
  by: "",
  cats: ["sales"],
  lists: [],
  lg: "en",
  at: 1000,
  v: 0,
  l: 0,
});

describe("notes", () => {
  it("writes a note on any video, changes it, and deletes it with empty text", () => {
    applyOp(s, { t: "note", id: "abc123XYZ_-", x: "Hook in 2 s", at: 100, ti: "A Short" });
    expect(s.notes["abc123XYZ_-"]).toEqual({ x: "Hook in 2 s", at: 100, ti: "A Short" });
    applyOp(s, { t: "note", id: "abc123XYZ_-", x: "Hook in 2 s — copy it", at: 200 });
    expect(s.notes["abc123XYZ_-"]).toEqual({ x: "Hook in 2 s — copy it", at: 200, ti: "A Short" }); // title kept
    applyOp(s, { t: "note", id: "abc123XYZ_-", x: "   ", at: 300 });
    expect(s.notes).toEqual({});
  });

  it("a Facebook video's note is a note like any other (its feed id)", () => {
    applyOp(s, { t: "note", id: "fb1141407915517139", x: "Price transparency", at: 5, ti: "Hide the price" });
    expect(Object.keys(s.notes)).toEqual(["fb1141407915517139"]);
  });

  it("the newer change wins when two devices wrote on the same video", () => {
    applyOp(s, { t: "note", id: "v1", x: "from the laptop", at: 200 });
    applyOp(s, { t: "note", id: "v1", x: "from the phone, older", at: 150 }); // arrives late: ignored
    expect(s.notes.v1.x).toBe("from the laptop");
    applyOp(s, { t: "note", id: "v1", x: "", at: 100 }); // an older delete can't remove a newer note
    expect(s.notes.v1.x).toBe("from the laptop");
    applyOp(s, { t: "note", id: "v1", x: "", at: 250 }); // a newer delete does
    expect(s.notes.v1).toBeUndefined();
  });

  it("keeps at most MAX_NOTE characters", () => {
    applyOp(s, { t: "note", id: "v1", x: "x".repeat(MAX_NOTE + 500), at: 1 });
    expect(s.notes.v1.x).toHaveLength(MAX_NOTE);
  });

  it("goes to the GitHub file (version 7) and back; broken entries are dropped", () => {
    applyOp(s, { t: "note", id: "v1", x: "keep", at: 10, ti: "T" });
    const file = JSON.parse(JSON.stringify(toFile(s)));
    expect(file.v).toBe(7);
    expect(fromFile(file).notes).toEqual({ v1: { x: "keep", at: 10, ti: "T" } });
    expect(normNotes({ ok: { x: "yes", at: 1 }, empty: { x: "  ", at: 2 }, bad: 5, "": { x: "no id", at: 1 } })).toEqual({
      ok: { x: "yes", at: 1, ti: "" },
    });
    expect(normNotes(null)).toEqual({});
    expect(normNotes([1, 2])).toEqual({});
  });

  it("merges a device's notes into the GitHub copy (the newer one per video wins)", () => {
    const base = emptyShared();
    applyOp(base, { t: "note", id: "v1", x: "github version", at: 300 });
    applyOp(base, { t: "note", id: "v2", x: "only on github", at: 10 });
    const local = emptyShared();
    applyOp(local, { t: "note", id: "v1", x: "older on device", at: 100 });
    applyOp(local, { t: "note", id: "v3", x: "only on device", at: 20 });
    mergeInto(base, local);
    expect(base.notes.v1.x).toBe("github version");
    expect(Object.keys(base.notes).sort()).toEqual(["v1", "v2", "v3"]);
  });

  it("is in backups: a replace puts them back, a merge adds back what is missing", () => {
    applyOp(s, { t: "note", id: "v1", x: "one", at: 10 });
    const backup = snap(s);
    applyOp(s, { t: "note", id: "v1", x: "", at: 20 }); // deleted since
    applyOp(s, { t: "note", id: "v2", x: "written since", at: 30 });
    const merged = structuredClone(s);
    applyRestore(merged, backup, "merge");
    expect(merged.notes.v1.x).toBe("one"); // deleted since, so the backup brings it back
    expect(merged.notes.v2.x).toBe("written since"); // and what was written since stays
    const replaced = structuredClone(s);
    applyRestore(replaced, backup, "replace");
    expect(Object.keys(replaced.notes)).toEqual(["v1"]); // exactly as it was
  });

  it("moves the old note field of an added Facebook video into the notes, once", () => {
    s.manual = [fbVideo("1111111111", "hook in 2 s"), fbVideo("2222222222", "")];
    adoptManualNotes(s);
    expect(s.notes.fb1111111111).toEqual({ x: "hook in 2 s", at: 1000, ti: "Price hook" });
    expect(s.manual[0].note).toBe("");
    expect(s.notes.fb2222222222).toBeUndefined();
    s.notes.fb1111111111.x = "edited since";
    s.manual[0].note = "stale copy";
    adoptManualNotes(s); // a note that already exists is not overwritten
    expect(s.notes.fb1111111111.x).toBe("edited since");
    expect(s.manual[0].note).toBe("");
  });

  it("older saved data (no notes yet) loads with an empty set of notes", () => {
    const st = migrateLocal({ ...emptyShared(), notes: undefined } as never);
    expect(st.notes).toEqual({});
    const fromOld = fromFile({ v: 4, manual: [fbVideo("3333333333", "from version 4")] } as never);
    expect(fromOld.notes.fb3333333333.x).toBe("from version 4");
  });
});
