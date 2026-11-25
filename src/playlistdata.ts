/**
 * Playlists: videos in an order you decide, to play one after another (for example Quran tilawat for
 * sleep). The data and its rules — pure functions shared by the store, the page and the tests.
 * A change is a small operation, so two devices don't overwrite each other: adding a video never loses
 * another device's additions; the order and name follow whichever device changed them last.
 */

export interface Playlist {
  id: string;
  name: string;
  ids: string[]; // video feed ids, in play order
  at: number; // created (unix seconds)
  up: number; // last changed
}

export const MAX_PLAYLISTS = 100;
export const MAX_PLAYLIST_VIDEOS = 2000;

export type PlaylistOp =
  | { t: "plNew"; p: Playlist }
  | { t: "plSet"; id: string; name: string; ids: string[]; up: number } // rename and/or reorder (the newer one wins)
  | { t: "plAdd"; id: string; v: string; up: number } // put a video at the end (once)
  | { t: "plDrop"; id: string };

const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const cleanIds = (x: unknown): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of Array.isArray(x) ? x : []) {
    if (typeof v !== "string" || !v || v.length > 40 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.slice(0, MAX_PLAYLIST_VIDEOS);
};

export function normPlaylist(x: any): Playlist | null {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !x.id || x.id.length > 40) return null;
  const name = str(x.name, 100);
  if (!name) return null;
  return { id: x.id, name, ids: cleanIds(x.ids), at: num(x.at), up: num(x.up) || num(x.at) };
}

export function normPlaylists(x: unknown): Playlist[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  const out: Playlist[] = [];
  for (const p of x) {
    const n = normPlaylist(p);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  }
  return out.sort((a, b) => b.up - a.up).slice(0, MAX_PLAYLISTS);
}

export const playlistById = (lists: Playlist[], id: string) => lists.find((p) => p.id === id);

/** Applies one operation (in place). Unknown playlists and repeats are ignored. */
export function applyPlaylistOp(lists: Playlist[], op: PlaylistOp) {
  if (op.t === "plNew") {
    const p = normPlaylist(op.p);
    if (p && !playlistById(lists, p.id) && lists.length < MAX_PLAYLISTS) lists.unshift(p);
    return;
  }
  const i = lists.findIndex((p) => p.id === op.id);
  if (i < 0) return;
  const pl = lists[i];
  if (op.t === "plDrop") {
    lists.splice(i, 1);
    return;
  }
  if (op.t === "plAdd") {
    if (!pl.ids.includes(op.v) && pl.ids.length < MAX_PLAYLIST_VIDEOS) pl.ids.push(op.v);
    pl.up = Math.max(pl.up, op.up);
  } else {
    if (op.up < pl.up) return; // a newer change from another device stays
    const name = str(op.name, 100);
    if (name) pl.name = name;
    pl.ids = cleanIds(op.ids);
    pl.up = op.up;
  }
  lists.sort((a, b) => b.up - a.up);
}

/** Adds what `from` has and `into` lacks (a restore, or a first sync): new playlists, and videos added since. */
export function mergePlaylists(into: Playlist[], from: unknown) {
  for (const p of normPlaylists(from)) {
    const have = playlistById(into, p.id);
    if (!have) {
      applyPlaylistOp(into, { t: "plNew", p });
      continue;
    }
    if (p.up > have.up)
      applyPlaylistOp(into, {
        t: "plSet",
        id: p.id,
        name: p.name,
        ids: [...p.ids, ...have.ids.filter((v) => !p.ids.includes(v))],
        up: p.up,
      });
    else for (const v of p.ids) applyPlaylistOp(into, { t: "plAdd", id: p.id, v, up: have.up });
  }
}

/** The order to play in: as listed, or shuffled (a fresh shuffle each time). */
export function playOrder<T>(items: T[], shuffle: boolean): T[] {
  if (!shuffle) return items;
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Moves the item at `from` to position `to` (a new array). */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const a = [...items];
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}
