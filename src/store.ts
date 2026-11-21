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
}

/** One watched Short. `x` keeps title/channel for Shorts that aren't in your library (searches, previews). */
export interface HistItem { id: string; at: number; f: number; x?: { t: string; n: string; h: string; c: string } }
const MAX_HIST = 600;

/** One YouTube API spend made from the app (Channels → Add lookups). */
export interface ApiUse { at: number; units: number; what: string }
const MAX_API_LOG = 300;

/** Settings that stay on each device. */
export interface DevicePrefs {
  muted: boolean;
  tab: Tab;
  win: Win;
  cat: string;
  lastActive: number; // unix seconds
  prevVisit: number; // unix seconds — start of "NEW since last visit"
  histPaused: boolean; // don't record watch history on this device
  tipsSeen: boolean; // first-time tips shown
  dataSaver: "auto" | "on" | "off"; // auto = on when the connection is slow
}

export type State = Shared & DevicePrefs;

/** Every change is recorded as a small operation, so two devices can merge without overwriting each other. */
export type Op =
  | { t: "save"; id: string }
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
  | { t: "histClear" };

const STORAGE_KEY = "ecomgy-reel-feed.v1";
const PENDING_KEY = "ecomgy-reel-feed.pending";
export const MAX_SEEN = 20000;
export const SHARED_KEYS = ["saved", "hidden", "seen", "bad", "affCh", "affCat", "apiLog", "hist"] as const;

export const emptyShared = (): Shared => ({ saved: [], hidden: [], seen: {}, bad: [], affCh: {}, affCat: {}, apiLog: [], hist: [] });

const defaults = (): State => ({
  ...emptyShared(),
  muted: true, tab: "foryou", win: "all", cat: "all",
  lastActive: 0, prevVisit: 0,
  histPaused: false, tipsSeen: false, dataSaver: "auto",
});

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch { /* storage blocked or corrupt */ }
  return fallback;
}

export const state: State = { ...defaults(), ...read<Partial<State>>(STORAGE_KEY, {}) };
/** Changes not yet uploaded to GitHub. Kept locally so nothing is lost offline. */
export const pending: Op[] = read<Op[]>(PENDING_KEY, []);

let timer: number | undefined;
export function persist() {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    try {
      trimSeen(state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch { /* ignore */ }
  }, 300);
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
      if (!s.saved.includes(op.id)) s.saved.unshift(op.id);
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
    case "api":
      if (!s.apiLog.some((x) => x.at === op.at && x.what === op.what)) {
        s.apiLog = [{ at: op.at, units: op.units, what: op.what }, ...s.apiLog]
          .sort((a, b) => b.at - a.at)
          .slice(0, MAX_API_LOG);
      }
      break;
  }
}

type Listener = () => void;
const listeners: Listener[] = [];
/** Lets the sync module know something changed. */
export function onChange(fn: Listener) { listeners.push(fn); }

/** Make a change: apply it now, remember it for the next sync. */
export function act(op: Op) {
  applyOp(state, op);
  pending.push(op);
  persist();
  for (const fn of listeners) fn();
}

/** Works out where "NEW since your last visit" starts. A gap of 30+ minutes counts as a new visit. */
export function startVisit(now: number) {
  if (!state.lastActive) state.prevVisit = now - 2 * 86400; // first ever visit: last 48h counts as new
  else if (now - state.lastActive > 30 * 60) state.prevVisit = state.lastActive;
  state.lastActive = now;
  persist();
}

/** Nudges what the feed has learned about you. Positive = show more like this. */
export function learn(ch: { h: string; cat: string }, delta: number) {
  if (delta) act({ t: "learn", h: ch.h, cat: ch.cat, d: delta });
}

// ---------- file format for the GitHub copy ----------
export interface StateFile {
  v: 1;
  updatedAt: string;
  saved: string[];
  hidden: string[];
  seen: string[]; // oldest -> newest
  bad: string[];
  affCh: Record<string, number>;
  affCat: Record<string, number>;
  apiLog?: ApiUse[];
  hist?: HistItem[];
}

export function toFile(s: Shared): StateFile {
  trimSeen(s);
  const seen = Object.keys(s.seen).sort((a, b) => s.seen[a] - s.seen[b]);
  return {
    v: 1, updatedAt: new Date().toISOString(),
    saved: s.saved, hidden: s.hidden, seen, bad: s.bad, affCh: s.affCh, affCat: s.affCat, apiLog: s.apiLog, hist: s.hist,
  };
}

export function fromFile(f: Partial<StateFile> | null): Shared {
  const s = emptyShared();
  if (!f) return s;
  s.saved = f.saved ?? [];
  s.hidden = f.hidden ?? [];
  s.bad = f.bad ?? [];
  s.affCh = f.affCh ?? {};
  s.affCat = f.affCat ?? {};
  s.apiLog = f.apiLog ?? [];
  s.hist = f.hist ?? [];
  (f.seen ?? []).forEach((id, i) => (s.seen[id] = i + 1)); // keeps order; real timestamps sort after these
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
}

export function sharedOf(s: State): Shared {
  return structuredClone({
    saved: s.saved, hidden: s.hidden, seen: s.seen, bad: s.bad, affCh: s.affCh, affCat: s.affCat,
    apiLog: s.apiLog ?? [],
    hist: s.hist ?? [],
  });
}

export function setShared(s: Shared) {
  for (const k of SHARED_KEYS) (state as any)[k] = s[k];
  persist();
}
