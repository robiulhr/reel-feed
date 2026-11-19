/**
 * Syncs your saves, hidden channels, history and learning across devices.
 *
 * The app talks to a small Cloudflare Worker (see /worker), which holds the GitHub token
 * and stores everything in user-state.json in a PRIVATE GitHub repo. Every sync is a commit,
 * so GitHub keeps the full history as a backup. Devices only keep a login session, never the token.
 */
import { applyOp, fromFile, mergeInto, onChange, pending, persist, setShared, sharedOf, state, toFile } from "./store";

/** Worker address, set at build time (VITE_SYNC_URL). Not a secret. */
export const SYNC_URL = (import.meta.env.VITE_SYNC_URL as string | undefined)?.replace(/\/$/, "") ?? "";

const CFG_KEY = "ecomgy-reel-feed.sync";
const PUSH_DELAY_MS = 60_000; // batch changes for up to a minute
const PULL_EVERY_MS = 5 * 60_000; // pick up other devices' changes

interface Cfg { session: string; merged: boolean }

function loadCfg(): Cfg | null {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch { return null; }
}
function saveCfg(c: Cfg | null) {
  try {
    if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CFG_KEY);
  } catch { /* ignore */ }
}

let cfg = loadCfg();
let busy = false;
let lastSync = 0;
let lastError = "";
let pushTimer: number | undefined;
let onUpdated: () => void = () => {};

export const isAvailable = () => !!SYNC_URL;
export const isConnected = () => !!cfg && !!SYNC_URL;
export const status = () => ({ lastSync, lastError, pending: pending.length, busy });

class AuthError extends Error {}

/** Authenticated call to the sync server (used by the Channels panel too). Throws on network errors. */
export async function call<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isConnected()) throw new Error("Log in first (Menu → Sync)");
  const r = await api(path, init);
  if (!r.ok) throw new Error(await errorOf(r));
  return r.json() as Promise<T>;
}

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SYNC_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(cfg ? { Authorization: `Bearer ${cfg.session}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (r.status === 401 && path !== "/login") {
    cfg = null;
    saveCfg(null);
    throw new AuthError("You were logged out (password changed or session expired). Log in again.");
  }
  return r;
}

async function errorOf(r: Response) {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error ?? `Sync server error ${r.status}`;
}

const device = () => (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? "phone" : "computer");

/** Pull the latest file, replay this device's pending changes on top, push back. Retries on conflicts. */
export async function syncNow(): Promise<void> {
  if (!isConnected() || busy) return;
  busy = true;
  onUpdated();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const g = await api("/state");
      if (!g.ok) throw new Error(await errorOf(g));
      const remote = (await g.json()) as { data: any; sha: string | null };

      const base = fromFile(remote.data);
      const needMerge = !cfg!.merged;
      if (needMerge) mergeInto(base, sharedOf(state));
      const ops = pending.slice();
      for (const op of ops) applyOp(base, op);

      if (remote.sha && !ops.length && !needMerge) {
        setShared(base); // nothing to upload — just take the latest
        break;
      }

      const p = await api("/state", {
        method: "PUT",
        body: JSON.stringify({
          data: toFile(base),
          sha: remote.sha,
          message: `Sync from ${device()} (${ops.length} change${ops.length === 1 ? "" : "s"})`,
        }),
      });
      if (p.status === 409) continue; // another device saved first — merge again
      if (!p.ok) throw new Error(await errorOf(p));

      pending.splice(0, ops.length);
      for (const op of pending) applyOp(base, op); // changes made while uploading
      cfg!.merged = true;
      saveCfg(cfg);
      setShared(base);
      break;
    }
    lastSync = Date.now();
    lastError = "";
  } catch (e) {
    lastError = e instanceof Error ? e.message : "Couldn't reach the sync server";
  } finally {
    busy = false;
    persist();
    onUpdated();
  }
}

/** Log this device in. Returns an error message, or null on success. */
export async function connect(password: string): Promise<string | null> {
  if (!SYNC_URL) return "Sync server isn't set up yet.";
  if (!password) return "Enter your password.";
  try {
    const r = await api("/login", { method: "POST", body: JSON.stringify({ password }) });
    if (!r.ok) return await errorOf(r);
    const { session } = (await r.json()) as { session: string };
    cfg = { session, merged: false };
    saveCfg(cfg);
  } catch {
    return "Couldn't reach the sync server.";
  }
  await syncNow();
  return lastError || null;
}

/** Log this device out. Data stays in GitHub and in this browser. */
export function disconnect() {
  cfg = null;
  saveCfg(null);
  onUpdated();
}

function schedulePush() {
  if (!isConnected() || pushTimer) return;
  pushTimer = window.setTimeout(() => { pushTimer = undefined; syncNow(); }, PUSH_DELAY_MS);
}

/** Start background syncing. `refresh` is called when data from another device arrives. */
export function startSync(refresh: () => void) {
  onUpdated = refresh;
  onChange(schedulePush);
  syncNow(); // no-op until this device is logged in
  setInterval(() => { if (!pending.length) syncNow(); }, PULL_EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    // upload right away when you leave the page; pull when you come back
    if (document.visibilityState === "hidden" ? pending.length : true) syncNow();
  });
  if (pending.length) schedulePush();
}
