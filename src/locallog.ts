/**
 * Things that happened on this device only (they are not synced): how syncing went, a browser that
 * wouldn't save, errors the app caught. The Activity tab shows them next to your own changes.
 * Kept in the browser, newest first, at most MAX lines.
 */
export type LocalKind = "sync" | "system" | "error";
export interface LocalEvent {
  at: number; // unix seconds
  k: LocalKind;
  ok: boolean; // false = a problem
  x: string;
}

const KEY = "ecomgy-reel-feed.locallog";
const MAX = 150;

function load(): LocalEvent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw)
      ? raw
          .filter((e) => e && typeof e.x === "string" && typeof e.at === "number" && ["sync", "system", "error"].includes(e.k))
          .slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

let events: LocalEvent[] = load();
const listeners: (() => void)[] = [];

export const localLog = (): readonly LocalEvent[] => events;
export function onLocalLog(fn: () => void) {
  listeners.push(fn);
}

/** Adds a line (an identical line within the last minute isn't repeated). */
export function addLocalLog(k: LocalKind, ok: boolean, x: string) {
  const at = Math.floor(Date.now() / 1000);
  const last = events[0];
  if (last && last.k === k && last.x === x && at - last.at < 60) return;
  events = [{ at, k, ok, x: x.slice(0, 300) }, ...events].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(events));
  } catch {
    /* storage full: the line stays in memory for this visit */
  }
  for (const fn of listeners) fn();
}
