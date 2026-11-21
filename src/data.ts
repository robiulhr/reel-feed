/**
 * Loading the Shorts library fast, even on weak networks:
 *  1. Saved copy on this device (IndexedDB) → the feed starts instantly, even offline.
 *  2. First visit: a small starter file (~top 400 Shorts) → first video in about a second;
 *     the full library downloads in the background and is saved for next time.
 *  3. Update check: a tiny meta.json tells whether newer data was published. New data is
 *     downloaded in the background and offered with a "New Shorts available" banner.
 */
import type { Dataset } from "./types";

const DB = "ecomgy-reel-feed";
const STORE = "kv";
const KEY = "dataset";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}
async function idbSet(key: string, value: unknown) {
  try {
    const db = await idb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* storage unavailable — fine, we just download again next time */
  }
}

export interface RawData {
  generatedAt: number;
  units?: number;
  usage?: any[];
  channels: any[];
  videos: any[][];
}

export function parse(raw: RawData): Dataset {
  return {
    generatedAt: raw.generatedAt,
    units: raw.units ?? 0,
    usage: raw.usage ?? [],
    channels: raw.channels,
    videos: raw.videos.map((a) => ({
      id: a[0],
      ch: a[1],
      t: a[2],
      p: a[3],
      v: a[4],
      l: a[5],
      c: a[6],
      o: a[7],
      e: a[8],
      tr: a[9],
      r: a[10],
    })),
  };
}

/** fetch with a timeout, so a dead connection fails fast instead of hanging. */
async function get<T>(path: string, timeoutMs: number): Promise<T> {
  const r = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

async function getRetry<T>(path: string, timeoutMs: number, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await get<T>(path, timeoutMs * (i + 1));
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

export type Source = "saved" | "starter" | "full";

/**
 * Returns the quickest usable library. `onFull` is called later if a bigger/newer
 * full library becomes available in the background.
 */
export async function loadInitial(
  onFull: (ds: Dataset, sameVersion: boolean) => void,
  onStatus: (msg: string) => void,
): Promise<{ ds: Dataset; source: Source } | null> {
  const saved = await idbGet<RawData>(KEY);
  if (saved?.videos?.length) return { ds: parse(saved), source: "saved" };

  // First visit (or storage cleared): starter first, full in the background.
  try {
    const starter = await getRetry<RawData>("data/starter.json", 6000);
    fetchFull(starter.generatedAt, onFull, onStatus);
    return { ds: parse(starter), source: "starter" };
  } catch {
    // no starter (old build) — fall back to the full file
    try {
      const full = await getRetry<RawData>("data/shorts.json", 15000);
      idbSet(KEY, full);
      return { ds: parse(full), source: "full" };
    } catch {
      return null;
    }
  }
}

let fetching = false;
async function fetchFull(baseVersion: number, onFull: (ds: Dataset, sameVersion: boolean) => void, onStatus: (msg: string) => void) {
  if (fetching) return;
  fetching = true;
  try {
    const full = await getRetry<RawData>("data/shorts.json", 20000, 4);
    await idbSet(KEY, full);
    onFull(parse(full), full.generatedAt === baseVersion);
  } catch {
    onStatus("Weak connection — showing the most popular Shorts for now");
  } finally {
    fetching = false;
  }
}

/**
 * Checks whether newer data was published. Downloads it in the background and calls onNew.
 * Returns: "new" | "same" | "offline".
 */
export async function checkForUpdate(current: number, onNew: (ds: Dataset) => void): Promise<"new" | "same" | "offline"> {
  try {
    const meta = await get<{ generatedAt: number }>("data/meta.json", 6000);
    if (meta.generatedAt <= current) return "same";
    const full = await getRetry<RawData>("data/shorts.json", 20000, 3);
    await idbSet(KEY, full);
    onNew(parse(full));
    return "new";
  } catch {
    return navigator.onLine ? "same" : "offline";
  }
}

/** Slow connection? (Network Information API where available, e.g. Chrome on Android.) */
export function isSlowNetwork() {
  const c = (navigator as any).connection;
  if (!c) return false;
  return !!c.saveData || ["slow-2g", "2g", "3g"].includes(c.effectiveType) || (c.downlink && c.downlink < 1.2);
}
export function onNetworkChange(fn: () => void) {
  (navigator as any).connection?.addEventListener?.("change", fn);
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
}
