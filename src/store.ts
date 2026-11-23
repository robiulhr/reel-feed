import { type CatId, LEGACY, type Lang, normCats } from "./categories";
import type { Tab, Win } from "./types";

/** The part of your data that syncs across devices (saved in the private GitHub repo). */
export interface Shared {
  saved: string[]; // shortIds, newest first
  hidden: string[]; // channel handles
  seen: Record<string, number>; // shortId -> order shown (bigger = later)
  bad: string[]; // shortIds that refused to play (embedding disabled)
  affCh: Record<string, number>; // learned liking per channel
  affCat: Record<string, number>; // learned liking per category
  apiLog: ApiUse[]; // YouTube API units spent by channel lookups (newest first)
  hist: HistItem[]; // watch history, newest first
  catFix: Record<string, CatId[]>; // your category fixes per Short (main first) — they always win
  lists: ChList[]; // your channel lists (Competitors, Inspiration…), each with its own feed and Saved view
  manual: ManualVideo[]; // Facebook videos you added by link, newest first (the Added page)
  fbPages: FbPage[]; // the Facebook pages those videos come from
  notes: Record<string, Note>; // your notes, one per video (any Short or Facebook video), by its feed id
}

/** Your note on one video. */
export interface Note {
  x: string; // the text
  at: number; // last changed (unix seconds); the newer one wins when two devices both changed it
  ti: string; // the video's title when you wrote it (so the Notes page works even if the video leaves the library)
}
export const MAX_NOTE = 5000; // characters in one note
const MAX_NOTES = 5000;
/** Cleans notes from any source (a file, a backup). Empty ones are dropped. */
export function normNotes(x: unknown): Record<string, Note> {
  const out: Record<string, Note> = {};
  if (!x || typeof x !== "object" || Array.isArray(x)) return out;
  const rows = Object.entries(x as Record<string, any>)
    .filter(([id, n]) => id.length > 0 && id.length <= 40 && n && typeof n.x === "string" && n.x.trim())
    .map(([id, n]) => [id, { x: n.x.slice(0, MAX_NOTE), at: Number(n.at) || 0, ti: String(n.ti ?? "").slice(0, 200) }] as [string, Note])
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_NOTES);
  for (const [id, n] of rows) out[id] = n;
  return out;
}
/** Moves the note field of added Facebook videos (the old place for notes) into the notes. Safe to repeat. */
export function adoptManualNotes(s: Pick<Shared, "manual" | "notes">) {
  for (const m of s.manual) {
    const text = (m.note ?? "").trim();
    if (!text) continue;
    const id = fbShortId(m.id);
    if (!s.notes[id]) s.notes[id] = { x: text.slice(0, MAX_NOTE), at: m.at, ti: m.t };
    m.note = "";
  }
}

/** A Facebook video you added by pasting its link. Plays in the feed like a Short (id "fb" + its number). */
export interface ManualVideo {
  id: string; // Facebook's video number
  url: string; // the video's Facebook address
  t: string; // title ("" = none)
  note: string; // (old place for the note — now in `notes`; kept empty)
  by: string; // who made it: a page key ("fb:…"), "" = not set
  cats: CatId[]; // main first
  lists: string[]; // channel lists this one video is in (its page's lists count too)
  lg: Lang;
  at: number; // added (unix seconds)
  v: number; // views when added
  l: number; // reactions when added
}
/** A Facebook page your added videos come from. Linked to one of your YouTube channels (`ch`) or on its own. */
export interface FbPage {
  key: string; // "fb:" + its Facebook address ("fb:mahedi.pro.bd") or name
  name: string;
  url: string; // its Facebook address, "" = unknown
  ch: string; // a YouTube channel's handle it belongs to, "" = none
}
const MAX_MANUAL = 3000;
/** The feed's id for an added Facebook video. */
export const fbShortId = (id: string) => `fb${id}`;
export const isFbId = (id: string) => /^fb\d{6,25}$/.test(id);
/** Cleans added videos from any source (a file, an old backup). */
export function normManual(x: unknown): ManualVideo[] {
  if (!Array.isArray(x)) return [];
  const out: ManualVideo[] = [];
  for (const m of x) {
    if (!m || typeof m.id !== "string" || !/^\d{6,25}$/.test(m.id) || typeof m.url !== "string" || out.some((o) => o.id === m.id)) continue;
    out.push({
      id: m.id,
      url: m.url,
      t: String(m.t ?? "").slice(0, 300),
      note: String(m.note ?? "").slice(0, 2000),
      by: String(m.by ?? ""),
      cats: normCats(m.cats),
      lists: Array.isArray(m.lists) ? m.lists.filter((l: unknown) => typeof l === "string") : [],
      lg: ["bn", "en", "hi"].includes(m.lg) ? m.lg : "en",
      at: Number(m.at) || 0,
      v: Number(m.v) || 0,
      l: Number(m.l) || 0,
    });
  }
  return out.slice(0, MAX_MANUAL);
}
export function normPages(x: unknown): FbPage[] {
  if (!Array.isArray(x)) return [];
  const out: FbPage[] = [];
  for (const p of x)
    if (p && typeof p.key === "string" && p.key.startsWith("fb:") && !out.some((o) => o.key === p.key))
      out.push({
        key: p.key,
        name: String(p.name ?? "").slice(0, 120) || p.key.slice(3),
        url: String(p.url ?? ""),
        ch: String(p.ch ?? ""),
      });
  return out;
}

/** A list of channels you keep an eye on together, e.g. direct competitors. Channels can be in several. */
export interface ChList {
  id: string;
  name: string;
  icon: string;
  ch: string[]; // channel handles ("@x"), in the order added
}
/** The lists everyone starts with (rename or delete them freely). */
export const defaultLists = (): ChList[] => [
  { id: "comp", name: "Competitors", icon: "🎯", ch: [] },
  { id: "insp", name: "Inspiration", icon: "✨", ch: [] },
  { id: "adsup", name: "Ads updates", icon: "📢", ch: [] },
  { id: "aiup", name: "AI updates", icon: "🤖", ch: [] },
];
const MAX_LISTS = 20;
const sameH = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Cleans lists from any source (a file, an old backup). */
export function normLists(x: unknown): ChList[] {
  if (!Array.isArray(x)) return defaultLists();
  const out: ChList[] = [];
  for (const l of x) {
    if (!l || typeof l.id !== "string" || !l.id || out.some((o) => o.id === l.id)) continue;
    const ch: string[] = [];
    for (const h of Array.isArray(l.ch) ? l.ch : []) if (typeof h === "string" && h && !ch.some((c) => sameH(c, h))) ch.push(h);
    out.push({ id: l.id, name: String(l.name ?? "").slice(0, 40) || "List", icon: String(l.icon ?? "📋").slice(0, 8) || "📋", ch });
  }
  return out.slice(0, MAX_LISTS);
}
/** Is this channel in the list? */
export const inChList = (l: ChList, h: string) => l.ch.some((c) => sameH(c, h));

/** One watched Short. `x` keeps title/channel for Shorts that aren't in your library (searches, previews). */
export interface HistItem {
  id: string;
  at: number;
  f: number;
  x?: { t: string; n: string; h: string; c: string };
}
const MAX_HIST = 600;

/** One YouTube API spend made from the app (Channels → Add lookups). */
export interface ApiUse {
  at: number;
  units: number;
  what: string;
}
const MAX_API_LOG = 300;

/** Settings that stay on each device. */
export interface DevicePrefs {
  muted: boolean;
  tab: Tab;
  win: Win;
  minV: number; // fewest views a Short must have (0 = any)
  cats: CatId[]; // categories picked in the top bar (none = All)
  list: string; // a channel list's feed (its id), "" = all channels
  lang: Lang | "all"; // language filter
  lastActive: number; // unix seconds
  prevVisit: number; // unix seconds — start of "NEW since last visit"
  histPaused: boolean; // don't record watch history on this device
  tipsSeen: boolean; // first-time tips shown
  dataSaver: "auto" | "on" | "off"; // auto = on when the connection is slow
  rate: number; // playback speed
  autoFull: boolean; // go full screen on the first tap (phones, in the browser)
  volume: number; // 0–100
  sv: number; // version of this saved data on the device (see migrateLocal)
}

export type State = Shared & DevicePrefs;

/** Every change is recorded as a small operation, so two devices can merge without overwriting each other. */
export type Op =
  | { t: "save"; id: string; i?: number } // i = position to put it back at (undo)
  | { t: "unsave"; id: string }
  | { t: "hide"; h: string }
  | { t: "unhide"; h: string }
  | { t: "seen"; id: string; at: number }
  | { t: "bad"; id: string }
  | { t: "learn"; h: string; cat: string; d: number }
  | { t: "resetLearn" }
  | { t: "clearSeen" }
  | { t: "api"; at: number; units: number; what: string }
  | { t: "watch"; item: HistItem }
  | { t: "histDel"; id: string }
  | { t: "histClear" }
  | { t: "catFix"; id: string; cats: CatId[] } // empty cats = back to automatic
  | { t: "listNew"; id: string; name: string; icon: string }
  | { t: "listEdit"; id: string; name: string; icon: string }
  | { t: "listDrop"; id: string } // delete the list (not its channels)
  | { t: "listAdd"; id: string; h: string } // put a channel in a list
  | { t: "listRemove"; id: string; h: string }
  | { t: "manAdd"; v: ManualVideo } // add a Facebook video (or put a deleted one back)
  | { t: "manEdit"; v: ManualVideo }
  | { t: "manDel"; id: string } // also takes it out of Saved
  | { t: "pageSet"; p: FbPage } // add or change a Facebook page
  | { t: "note"; id: string; x: string; at: number; ti?: string } // write a note on a video (empty text = delete it)
  | { t: "restore"; data: Snap; mode: "merge" | "replace" }; // undo an erase / restore a backup

const STORAGE_KEY = "ecomgy-reel-feed.v1";
const PENDING_KEY = "ecomgy-reel-feed.pending";
export const MAX_SEEN = 20000;
export const SHARED_KEYS = [
  "saved",
  "hidden",
  "seen",
  "bad",
  "affCh",
  "affCat",
  "apiLog",
  "hist",
  "catFix",
  "lists",
  "manual",
  "fbPages",
  "notes",
] as const;

export const emptyShared = (): Shared => ({
  saved: [],
  hidden: [],
  seen: {},
  bad: [],
  affCh: {},
  affCat: {},
  apiLog: [],
  hist: [],
  catFix: {},
  lists: defaultLists(),
  manual: [],
  fbPages: [],
  notes: {},
});

const defaults = (): State => ({
  ...emptyShared(),
  muted: true,
  tab: "foryou",
  win: "all",
  minV: 0,
  cats: [],
  list: "",
  lang: "all",
  lastActive: 0,
  prevVisit: 0,
  histPaused: false,
  tipsSeen: false,
  dataSaver: "auto",
  rate: 1,
  autoFull: true,
  volume: 100,
  sv: LOCAL_VERSION,
});

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* storage blocked or corrupt */
  }
  return fallback;
}

/**
 * Versions of the saved data. Bump a version and add a step to the migration when the shape changes,
 * so data saved by an older version of the app is upgraded instead of breaking.
 *   LOCAL_VERSION — this device (localStorage).  FILE_VERSION — the synced user-state.json.
 */
export const LOCAL_VERSION = 3;
/** Choices for the "fewest views" filter (0 = any). */
export const VIEW_MINS = [0, 1000, 10_000, 100_000, 1_000_000];
export const FILE_VERSION = 5; // 3: channel lists. 4: added Facebook videos. 5: notes (older apps must not write the file and drop them)

export function migrateLocal(raw: Partial<State> & Record<string, unknown>): State {
  const s = { ...defaults(), ...raw } as State;
  // v1 → v2: data written before versioning existed; make sure every list/map exists and has the right type
  if (!raw.sv || raw.sv < 2) {
    for (const k of ["saved", "hidden", "bad", "apiLog", "hist"] as const) if (!Array.isArray(s[k])) (s as any)[k] = [];
    for (const k of ["seen", "affCh", "affCat"] as const) if (!s[k] || typeof s[k] !== "object") (s as any)[k] = {};
  }
  // v2 → v3: one category (`cat`) → several (`cats`) + a language filter; old "bangla" was a language
  if (!raw.sv || raw.sv < 3) {
    const old = typeof raw.cat === "string" ? raw.cat : "all";
    s.cats = old === "all" ? [] : normCats(LEGACY[old] ?? [old]);
    if (old === "bangla") s.lang = "bn";
    delete (s as any).cat;
    if (!s.catFix || typeof s.catFix !== "object") s.catFix = {};
  }
  s.cats = normCats(s.cats);
  s.lists = normLists(raw.lists);
  s.manual = normManual(raw.manual);
  s.fbPages = normPages(raw.fbPages);
  s.notes = normNotes(raw.notes);
  adoptManualNotes(s);
  if (typeof s.list !== "string" || (s.list && !s.lists.some((l) => l.id === s.list))) s.list = "";
  if (!["all", "bn", "en", "hi"].includes(s.lang)) s.lang = "all";
  if (!VIEW_MINS.includes(s.minV)) s.minV = 0;
  if (!["all", "365", "90", "30", "7", "1"].includes(s.win)) s.win = "all";
  s.sv = LOCAL_VERSION;
  return s;
}

export const state: State = migrateLocal(read<Partial<State> & Record<string, unknown>>(STORAGE_KEY, {}));
/** Changes not yet uploaded to GitHub. Kept locally so nothing is lost offline. */
export const pending: Op[] = (() => {
  const p = read<unknown>(PENDING_KEY, []);
  return Array.isArray(p) ? (p as Op[]) : [];
})();
const MAX_PENDING = 5000;

/** Keeps the upload queue bounded after long offline periods: drops the least important changes first. */
export function capPending(list: Op[], max = MAX_PENDING) {
  if (list.length <= max) return;
  for (const kind of ["seen", "learn", "api"] as const) {
    for (let i = 0; i < list.length && list.length > max; ) {
      if (list[i].t === kind) list.splice(i, 1);
      else i++;
    }
  }
  if (list.length > max) list.splice(0, list.length - max);
}

let timer: number | undefined;
let dirty = false;

/** Write to the device now. */
export function flushPersist() {
  clearTimeout(timer);
  if (!dirty) return;
  dirty = false;
  try {
    trimSeen(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* storage full/blocked — nothing more we can do */
  }
}

/** Save soon (batched, so rapid changes cost one write). Flushed immediately when the app is closed or hidden. */
export function persist() {
  dirty = true;
  clearTimeout(timer);
  timer = window.setTimeout(flushPersist, 300);
}

// Never lose the last changes: write right away when the page is closed, reloaded or sent to the background.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
}

function trimSeen(s: Shared) {
  const ids = Object.keys(s.seen);
  if (ids.length <= MAX_SEEN) return;
  ids.sort((a, b) => s.seen[a] - s.seen[b]);
  for (const id of ids.slice(0, ids.length - MAX_SEEN)) delete s.seen[id];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Applies one change to a copy of the data. Used locally and when merging with GitHub. */
export function applyOp(s: Shared, op: Op) {
  switch (op.t) {
    case "save":
      if (!s.saved.includes(op.id)) s.saved.splice(clamp(op.i ?? 0, 0, s.saved.length), 0, op.id);
      break;
    case "unsave":
      s.saved = s.saved.filter((id) => id !== op.id);
      break;
    case "hide":
      if (!s.hidden.includes(op.h)) s.hidden.push(op.h);
      break;
    case "unhide":
      s.hidden = s.hidden.filter((h) => h !== op.h);
      break;
    case "seen":
      s.seen[op.id] = Math.max(s.seen[op.id] ?? 0, op.at);
      break;
    case "bad":
      if (!s.bad.includes(op.id)) s.bad.push(op.id);
      break;
    case "learn":
      s.affCh[op.h] = clamp((s.affCh[op.h] ?? 0) + op.d, -20, 20);
      s.affCat[op.cat] = clamp((s.affCat[op.cat] ?? 0) + op.d * 0.5, -20, 20);
      break;
    case "resetLearn":
      s.affCh = {};
      s.affCat = {};
      break;
    case "clearSeen":
      s.seen = {};
      break;
    case "watch": {
      const prev = s.hist.find((h) => h.id === op.item.id);
      const item = { ...op.item, f: Math.max(op.item.f, prev && op.item.at - prev.at < 3600 ? prev.f : 0) };
      s.hist = [item, ...s.hist.filter((h) => h.id !== op.item.id)].sort((a, b) => b.at - a.at).slice(0, MAX_HIST);
      break;
    }
    case "histDel":
      s.hist = s.hist.filter((h) => h.id !== op.id);
      break;
    case "histClear":
      s.hist = [];
      break;
    case "catFix": {
      const cats = normCats(op.cats);
      if (cats.length) s.catFix[op.id] = cats;
      else delete s.catFix[op.id];
      break;
    }
    case "listNew":
      if (!s.lists.some((l) => l.id === op.id) && s.lists.length < MAX_LISTS)
        s.lists.push({ id: op.id, name: op.name, icon: op.icon, ch: [] });
      break;
    case "listEdit": {
      const l = s.lists.find((x) => x.id === op.id);
      if (l) Object.assign(l, { name: op.name, icon: op.icon });
      break;
    }
    case "listDrop":
      s.lists = s.lists.filter((l) => l.id !== op.id);
      break;
    case "listAdd": {
      const l = s.lists.find((x) => x.id === op.id);
      if (l && !inChList(l, op.h)) l.ch.push(op.h);
      break;
    }
    case "listRemove": {
      const l = s.lists.find((x) => x.id === op.id);
      if (l) l.ch = l.ch.filter((c) => !sameH(c, op.h));
      break;
    }
    case "manAdd":
      if (!s.manual.some((m) => m.id === op.v.id) && s.manual.length < MAX_MANUAL)
        s.manual = [op.v, ...s.manual].sort((a, b) => b.at - a.at);
      break;
    case "manEdit":
      s.manual = s.manual.map((m) => (m.id === op.v.id ? op.v : m));
      break;
    case "manDel":
      s.manual = s.manual.filter((m) => m.id !== op.id);
      s.saved = s.saved.filter((id) => id !== fbShortId(op.id));
      break;
    case "pageSet": {
      const i = s.fbPages.findIndex((p) => p.key === op.p.key);
      if (i >= 0) s.fbPages[i] = op.p;
      else s.fbPages.push(op.p);
      break;
    }
    case "note": {
      const old = s.notes[op.id];
      if (old && old.at > op.at) break; // a newer note (from another device) stays
      const x = op.x.slice(0, MAX_NOTE);
      if (!x.trim()) delete s.notes[op.id];
      else if (old || Object.keys(s.notes).length < MAX_NOTES)
        s.notes[op.id] = { x, at: op.at, ti: (op.ti ?? old?.ti ?? "").slice(0, 200) };
      break;
    }
    case "restore":
      applyRestore(s, op.data, op.mode);
      break;
    case "api":
      if (!s.apiLog.some((x) => x.at === op.at && x.what === op.what)) {
        s.apiLog = [{ at: op.at, units: op.units, what: op.what }, ...s.apiLog].sort((a, b) => b.at - a.at).slice(0, MAX_API_LOG);
      }
      break;
  }
}

/**
 * A copy of some or all of your synced data (seen = ids oldest → newest). Used for Undo and backups.
 * Only the parts present are touched.
 */
export type Snap = Partial<Omit<Shared, "seen" | "apiLog"> & { seen: string[] }>;

/** Takes a copy of the given parts (all of them by default). */
export function snap(s: Shared, keys: readonly (keyof Snap)[] = SNAP_KEYS): Snap {
  const out: Snap = {};
  for (const k of keys) {
    if (k === "seen") out.seen = Object.keys(s.seen).sort((a, b) => s.seen[a] - s.seen[b]);
    else (out as any)[k] = structuredClone(s[k]);
  }
  return out;
}
export const SNAP_KEYS = [
  "saved",
  "hidden",
  "seen",
  "bad",
  "affCh",
  "affCat",
  "hist",
  "catFix",
  "lists",
  "manual",
  "fbPages",
  "notes",
] as const;

/**
 * replace = put those parts back exactly as they were (a backup restore, learning undo).
 * merge = add back what was removed, keeping anything added since (undo of a clear, from any device).
 */
export function applyRestore(s: Shared, d: Snap, mode: "merge" | "replace") {
  if (mode === "replace") {
    for (const k of SNAP_KEYS) {
      if (d[k] === undefined) continue;
      if (k === "seen") {
        s.seen = {};
        d.seen?.forEach((id, i) => {
          s.seen[id] = i + 1;
        });
      } else (s as any)[k] = structuredClone(d[k]);
    }
    return;
  }
  d.saved?.forEach((id, i) => {
    applyOp(s, { t: "save", id, i });
  });
  for (const h of d.hidden ?? []) applyOp(s, { t: "hide", h });
  for (const id of d.bad ?? []) applyOp(s, { t: "bad", id });
  d.seen?.forEach((id, i) => {
    if (!(id in s.seen)) s.seen[id] = i + 1;
  });
  for (const item of d.hist ?? []) if (!s.hist.some((h) => h.id === item.id)) applyOp(s, { t: "watch", item });
  for (const [k, v] of Object.entries(d.affCh ?? {})) if (!(k in s.affCh)) s.affCh[k] = v;
  for (const [k, v] of Object.entries(d.affCat ?? {})) if (!(k in s.affCat)) s.affCat[k] = v;
  for (const [id, cats] of Object.entries(d.catFix ?? {})) if (!(id in s.catFix)) s.catFix[id] = cats;
  if (d.lists) mergeLists(s, d.lists);
  mergeManual(s, d);
  for (const [id, n] of Object.entries(normNotes(d.notes))) applyOp(s, { t: "note", id, x: n.x, at: n.at, ti: n.ti });
}

/** Adds back Facebook videos and pages that are missing (keeps everything already there). */
function mergeManual(s: Shared, from: Partial<Pick<Shared, "manual" | "fbPages">>) {
  for (const p of normPages(from.fbPages)) if (!s.fbPages.some((x) => x.key === p.key)) applyOp(s, { t: "pageSet", p });
  for (const v of normManual(from.manual)) applyOp(s, { t: "manAdd", v });
}

/** Adds back lists and channels that are missing (keeps everything already there). */
function mergeLists(s: Shared, from: ChList[]) {
  for (const l of normLists(from)) {
    if (!s.lists.some((x) => x.id === l.id)) applyOp(s, { t: "listNew", id: l.id, name: l.name, icon: l.icon });
    for (const h of l.ch) applyOp(s, { t: "listAdd", id: l.id, h });
  }
}

type Listener = () => void;
const listeners: Listener[] = [];
/** Lets the sync module know something changed. */
export function onChange(fn: Listener) {
  listeners.push(fn);
}

/** Make a change: apply it now, remember it for the next sync. */
export function act(op: Op) {
  applyOp(state, op);
  pending.push(op);
  capPending(pending);
  persist();
  for (const fn of listeners) fn();
}

/** Works out where "NEW since your last visit" starts. A gap of 30+ minutes counts as a new visit. */
export function startVisit(now: number) {
  if (!state.lastActive)
    state.prevVisit = now - 2 * 86400; // first ever visit: last 48h counts as new
  else if (now - state.lastActive > 30 * 60) state.prevVisit = state.lastActive;
  state.lastActive = now;
  persist();
}

/** Nudges what the feed has learned about you. Positive = show more like this. `cat` = the Short's main category. */
export function learn(ch: { h: string }, cat: string | undefined, delta: number) {
  if (delta) act({ t: "learn", h: ch.h, cat: cat ?? "none", d: delta });
}

// ---------- file format for the GitHub copy ----------
export interface StateFile {
  v: number;
  updatedAt: string;
  saved: string[];
  hidden: string[];
  seen: string[]; // oldest -> newest
  bad: string[];
  affCh: Record<string, number>;
  affCat: Record<string, number>;
  apiLog?: ApiUse[];
  hist?: HistItem[];
  catFix?: Record<string, CatId[]>;
  lists?: ChList[];
  manual?: ManualVideo[];
  fbPages?: FbPage[];
  notes?: Record<string, Note>;
}

export function toFile(s: Shared): StateFile {
  trimSeen(s);
  const seen = Object.keys(s.seen).sort((a, b) => s.seen[a] - s.seen[b]);
  return {
    v: FILE_VERSION,
    updatedAt: new Date().toISOString(),
    saved: s.saved,
    hidden: s.hidden,
    seen,
    bad: s.bad,
    affCh: s.affCh,
    affCat: s.affCat,
    apiLog: s.apiLog,
    hist: s.hist,
    catFix: s.catFix,
    lists: s.lists,
    manual: s.manual,
    fbPages: s.fbPages,
    notes: s.notes,
  };
}

/** Thrown when the synced file was written by a newer version of the app than this one. */
export class NewerDataError extends Error {
  constructor() {
    super("Your data was saved by a newer version of the app. Close and reopen the app to update it, then sync continues.");
  }
}

export function fromFile(f: Partial<StateFile> | null): Shared {
  const s = emptyShared();
  if (!f) return s;
  // Never overwrite data this version doesn't understand (an old phone mustn't clobber newer data).
  if (typeof f.v === "number" && f.v > FILE_VERSION) throw new NewerDataError();
  s.saved = f.saved ?? [];
  s.hidden = f.hidden ?? [];
  s.bad = f.bad ?? [];
  s.affCh = f.affCh ?? {};
  s.affCat = f.affCat ?? {};
  s.apiLog = f.apiLog ?? [];
  s.hist = f.hist ?? [];
  for (const [id, cats] of Object.entries(f.catFix ?? {})) {
    const c = normCats(cats);
    if (c.length) s.catFix[id] = c;
  }
  s.lists = normLists(f.lists);
  s.manual = normManual(f.manual);
  s.fbPages = normPages(f.fbPages);
  s.notes = normNotes(f.notes);
  adoptManualNotes(s); // notes written in the old place (version 4 files)
  (f.seen ?? []).forEach((id, i) => {
    s.seen[id] = i + 1;
  }); // keeps order; real timestamps sort after these
  return s;
}

/** Folds this device's existing data into the GitHub copy (used once, when you first connect a device). */
export function mergeInto(base: Shared, local: Shared) {
  for (const id of [...local.saved].reverse()) if (!base.saved.includes(id)) base.saved.unshift(id);
  for (const h of local.hidden) if (!base.hidden.includes(h)) base.hidden.push(h);
  for (const id of local.bad) if (!base.bad.includes(id)) base.bad.push(id);
  for (const [id, at] of Object.entries(local.seen)) base.seen[id] = Math.max(base.seen[id] ?? 0, at);
  for (const [k, v] of Object.entries(local.affCh)) if (!(k in base.affCh)) base.affCh[k] = v;
  for (const u of local.apiLog ?? []) applyOp(base, { t: "api", ...u });
  for (const h of local.hist ?? []) applyOp(base, { t: "watch", item: h });
  for (const [k, v] of Object.entries(local.affCat)) if (!(k in base.affCat)) base.affCat[k] = v;
  for (const [id, cats] of Object.entries(local.catFix ?? {})) if (!(id in base.catFix)) base.catFix[id] = cats;
  mergeLists(base, local.lists ?? []);
  mergeManual(base, local);
  for (const [id, n] of Object.entries(local.notes ?? {})) applyOp(base, { t: "note", id, x: n.x, at: n.at, ti: n.ti });
}

export function sharedOf(s: State): Shared {
  return structuredClone({
    saved: s.saved,
    hidden: s.hidden,
    seen: s.seen,
    bad: s.bad,
    affCh: s.affCh,
    affCat: s.affCat,
    apiLog: s.apiLog ?? [],
    hist: s.hist ?? [],
    catFix: s.catFix ?? {},
    lists: s.lists ?? defaultLists(),
    manual: s.manual ?? [],
    fbPages: s.fbPages ?? [],
    notes: s.notes ?? {},
  });
}

export function setShared(s: Shared) {
  for (const k of SHARED_KEYS) (state as any)[k] = s[k];
  persist();
}

// ---------- notes ----------
/** Your note on a video (by its feed id), "" = none. */
export const noteOf = (id: string): string => state.notes[id]?.x ?? "";
/** Writes (or, with empty text, deletes) your note on a video. */
export function writeNote(id: string, x: string, title: string) {
  act({ t: "note", id, x, at: Math.floor(Date.now() / 1000), ti: title });
}
