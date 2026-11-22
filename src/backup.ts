/**
 * Safety net for anything that erases your data.
 *  - Every erase shows an Undo button (and the big ones ask first).
 *  - Backups: a copy of your synced data kept in this browser (IndexedDB) — one a day, and one right
 *    before every big erase or restore. Kept 30 days (at most 20, the newest 3 always).
 *    Menu → About → Backups lists them; Restore puts everything back as it was then (on all devices).
 *  - The synced copy on GitHub also keeps every version in its commit history.
 */
import { confirmDialog, toast } from "./ui";
import { act, type Op, type Snap, type SNAP_KEYS, snap, state } from "./store";

export interface Backup {
  id?: number;
  at: number; // unix ms
  why: string;
  data: Snap;
}

const DB_NAME = "ecomgy-reel-feed-backups";
const STORE = "backups";
const KEEP_DAYS = 30;
const MAX = 20;
const ALWAYS_KEEP = 3;
const DAILY_GAP = 20 * 3600 * 1000;

let dbP: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbP ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null); // private mode / storage blocked — backups just aren't available
    }
  });
  return dbP;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise((resolve) => {
        if (!d) return resolve(null);
        try {
          const req = fn(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export const backupsAvailable = async () => !!(await db());

/** Newest first. */
export async function listBackups(): Promise<Backup[]> {
  const all = (await run("readonly", (s) => s.getAll())) as Backup[] | null;
  return (all ?? []).sort((a, b) => b.at - a.at);
}

/** Which backups to delete: older than 30 days or beyond 20 — but never the newest 3. */
export function toPrune(list: Backup[], now = Date.now()): Backup[] {
  const sorted = [...list].sort((a, b) => b.at - a.at);
  return sorted.filter((b, i) => i >= ALWAYS_KEEP && (i >= MAX || now - b.at > KEEP_DAYS * 86400_000));
}

/** Saves a backup of everything now. */
export async function backupNow(why: string): Promise<boolean> {
  const ok = await run("readwrite", (s) => s.add({ at: Date.now(), why, data: snap(state) } satisfies Backup));
  if (ok === null) return false;
  for (const b of toPrune(await listBackups())) if (b.id !== undefined) await run("readwrite", (s) => s.delete(b.id as number));
  return true;
}

/** One backup a day (called at start-up). */
export async function dailyBackup() {
  const last = (await listBackups()).find((b) => b.why === "Daily");
  if (!last || Date.now() - last.at > DAILY_GAP) await backupNow("Daily");
}

/** Puts everything back as it was in this backup — on every device. Backs up the current state first. */
export async function restoreBackup(b: Backup) {
  await restoreSnap(b.data, "Before restoring a backup");
}

/** Puts this copy of your data back (on every device), backing up the current state first. */
export async function restoreSnap(data: Snap, why: string) {
  await backupNow(why);
  act({ t: "restore", data, mode: "replace" });
}

/** "12 saved · 340 watched · 5,200 seen · learned 40 channels" */
export function describe(d: Snap): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return [
    `${n(d.saved?.length ?? 0)} saved`,
    `${n(d.hist?.length ?? 0)} in history`,
    `${n(d.seen?.length ?? 0)} seen`,
    `learned ${n(Object.keys(d.affCh ?? {}).length)} channels`,
    `${n(d.hidden?.length ?? 0)} hidden`,
  ].join(" · ");
}

/**
 * Erase something with a safety net: ask first (when `ask` is given), back up, do it, then offer Undo.
 * `keys` = the parts the erase touches; Undo puts them back (merge = re-add what was removed, keeping
 * anything new; replace = exactly as before).
 */
export async function eraseWithUndo(o: {
  ask?: { title: string; body: string; confirm: string };
  op: Op;
  keys: (typeof SNAP_KEYS)[number][];
  undo: "merge" | "replace";
  done: string;
  after: () => void;
  backup?: string; // also save a backup first (for the big erases)
}) {
  if (o.ask && !(await confirmDialog({ ...o.ask, danger: true }))) return;
  const before = snap(state, o.keys);
  if (o.backup) await backupNow(o.backup);
  act(o.op);
  o.after();
  toast(
    o.done,
    {
      label: "Undo",
      run: () => {
        act({ t: "restore", data: before, mode: o.undo });
        o.after();
        toast("Undone — it's back");
      },
    },
    10000,
  );
}

/** A small erase (one item) — no question, just an Undo button. */
export function undoable(done: string, undo: () => void) {
  toast(
    done,
    {
      label: "Undo",
      run: () => {
        undo();
        toast("Undone");
      },
    },
    8000,
  );
}
