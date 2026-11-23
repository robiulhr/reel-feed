/**
 * Syncs your saves, hidden channels, history and learning across devices.
 *
 * The app talks to a small Cloudflare Worker (see /worker), which holds the GitHub token
 * and stores everything in user-state.json in a PRIVATE GitHub repo. Every sync is a commit,
 * so GitHub keeps the full history as a backup. Devices only keep a login session, never the token.
 */
import { addLocalLog } from "./locallog";
import {
  applyOp,
  fromFile,
  isImportantOp,
  mergeInto,
  onChange,
  onImportant,
  pending,
  persist,
  setShared,
  sharedOf,
  state,
  toFile,
} from "./store";

/** Worker address, set at build time (VITE_SYNC_URL). Not a secret. */
export const SYNC_URL = (import.meta.env.VITE_SYNC_URL as string | undefined)?.replace(/\/$/, "") ?? "";

const CFG_KEY = "ecomgy-reel-feed.sync";
const PUSH_DELAY_MS = 60_000; // batch changes for up to a minute
const PULL_EVERY_MS = 5 * 60_000; // pick up other devices' changes
const URGENT_DELAY_MS = 800; // your own changes (adding a video, a note, a delete…) go out almost at once
const RETRY_MS = [3000, 10_000, 30_000, 60_000, 120_000]; // when the cloud can't be reached: try again, less and less often

interface Cfg {
  session: string;
  merged: boolean;
}

function loadCfg(): Cfg | null {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY) || "null");
  } catch {
    return null;
  }
}
function saveCfg(c: Cfg | null) {
  try {
    if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CFG_KEY);
  } catch {
    /* ignore */
  }
}

let cfg = loadCfg();
let busy = false;
let lastSync = 0;
let lastError = "";
let pushTimer: number | undefined;
let onUpdated: () => void = () => {};
let failures = 0;
let retryTimer: number | undefined;
let lastSha: string | null = null;
let lastWarn = 0;
let unprotectedHook: (() => void) | undefined;
const statusListeners: (() => void)[] = [];

export const isAvailable = () => !!SYNC_URL;
export const isConnected = () => !!cfg && !!SYNC_URL;
/** Changes of yours waiting to reach the cloud (background bookkeeping like "seen" marks isn't counted). */
export const unsaved = () => pending.filter(isImportantOp).length;
export const status = () => ({ lastSync, lastError, pending: pending.length, unsaved: unsaved(), busy, connected: isConnected() });
/** Called whenever the sync state changes (saving, saved, failed, a change waiting) — for the status display. */
export function onStatus(fn: () => void): () => void {
  statusListeners.push(fn);
  return () => {
    const i = statusListeners.indexOf(fn);
    if (i >= 0) statusListeners.splice(i, 1);
  };
}
const emit = () => {
  for (const fn of statusListeners) fn();
};
/** Called (at most every 5 minutes) when you change something while sync isn't connected: it exists only in this browser. */
export function onUnprotected(fn: () => void) {
  unprotectedHook = fn;
}

class AuthError extends Error {}

/** Authenticated call to the sync server (used by the Channels panel too). Throws on network errors. */
export async function call<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isConnected()) throw new Error("Log in first (Menu → Sync)");
  const r = await api(path, init);
  if (!r.ok) throw new Error(await errorOf(r));
  return r.json() as Promise<T>;
}

const TIMEOUT_MS = 15_000;
const SLOW_PATHS = ["/lookup", "/search-shorts", "/channel-shorts", "/channels"]; // YouTube/GitHub round-trips
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One request to the sync server, made robust:
 *  - time limit (no endless "Loading…"),
 *  - automatic retries on network errors / server hiccups (GETs up to 2×, changes 1×),
 *  - a request ID that stays the same across retries, so the server can recognise a repeat
 *    and never apply the same change twice (double taps, flaky networks).
 */
async function api(path: string, init: RequestInit = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const isChange = method !== "GET";
  const rid = isChange ? (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`) : "";
  const timeout = SLOW_PATHS.some((p) => path.startsWith(p)) ? 25_000 : TIMEOUT_MS;
  const tries = isChange ? 2 : 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const r = await fetch(`${SYNC_URL}${path}`, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
        headers: {
          ...(cfg ? { Authorization: `Bearer ${cfg.session}` } : {}),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(rid ? { "X-Request-Id": rid } : {}),
        },
      });
      if (r.status === 401 && path !== "/login") {
        cfg = null;
        saveCfg(null);
        if (guarded()) void lockApp(); // the password changed or the session ended: show the login page
        throw new AuthError("You were logged out (password changed or session expired). Log in again.");
      }
      if ([502, 503, 504].includes(r.status) && attempt < tries - 1) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      return r;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      lastErr = e;
      if (attempt < tries - 1) await sleep(800 * (attempt + 1));
    }
  }
  const name = (lastErr as Error)?.name;
  throw new Error(
    name === "TimeoutError" || name === "AbortError"
      ? "The connection is too slow — the server didn't answer in time"
      : navigator.onLine
        ? "Couldn't reach the sync server"
        : "You're offline",
  );
}

async function errorOf(r: Response) {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error ?? `Sync server error ${r.status}`;
}

// ---------- the data file, passed through the server untouched ----------
// The sync server (Cloudflare's free plan) may use only ~10 ms of processor time per request. Decoding,
// parsing and re-encoding the whole data file there took 50-100 ms once it held a few hundred videos, and
// the request was cut off with a bare "500". So the browser does that work (no such limit) and the server
// only passes the text through. An older server without these endpoints (404) is still understood.
let raw = true;
const toB64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (b64: string) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

/** An older server doesn't know these addresses: it answers 404 "Not found" (a real "no such version" says more). */
const unknownRoute = async (r: Response) =>
  r.status === 404 &&
  (
    (await r
      .clone()
      .json()
      .catch(() => ({}))) as { error?: string }
  ).error === "Not found";

/** The latest data file and its version (sha). */
async function readRemote(): Promise<{ data: any; sha: string | null }> {
  if (raw) {
    const g = await api("/state2");
    if (!(await unknownRoute(g))) {
      if (!g.ok) throw new Error(await errorOf(g));
      const j = (await g.json()) as { content: string | null; sha: string | null };
      return { data: j.content ? JSON.parse(fromB64(j.content)) : null, sha: j.sha };
    }
    raw = false; // an older server: use the old way from now on
  }
  const g = await api("/state");
  if (!g.ok) throw new Error(await errorOf(g));
  return (await g.json()) as { data: any; sha: string | null };
}

/** Saves the data file. Returns the server's answer (409 = someone else saved first). */
async function writeRemote(data: unknown, sha: string | null, message: string): Promise<Response> {
  if (raw) {
    const p = await api("/state2", { method: "PUT", body: JSON.stringify({ content: toB64(JSON.stringify(data)), sha, message }) });
    if (!(await unknownRoute(p))) return p;
    raw = false;
  }
  return api("/state", { method: "PUT", body: JSON.stringify({ data, sha, message }) });
}

/** An earlier version of the data file (for Menu → Backups → Show versions). */
export async function readVersion(sha: string): Promise<any> {
  if (raw) {
    const g = await api(`/state/at2?sha=${encodeURIComponent(sha)}`);
    if (!(await unknownRoute(g))) {
      if (!g.ok) throw new Error(await errorOf(g));
      return JSON.parse(fromB64(((await g.json()) as { content: string }).content));
    }
    raw = false;
  }
  return (await call<{ data: any }>(`/state/at?sha=${encodeURIComponent(sha)}`)).data;
}

const device = () => (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? "phone" : "computer");

/** Pull the latest file, replay this device's pending changes on top, push back. Retries on conflicts. */
export async function syncNow(): Promise<void> {
  if (!isConnected() || busy) return;
  busy = true;
  onUpdated();
  emit();
  let done = false;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await readRemote();

      const base = fromFile(remote.data);
      const needMerge = !cfg!.merged;
      if (needMerge) mergeInto(base, sharedOf(state));
      const ops = pending.slice();
      for (const op of ops) applyOp(base, op);

      if (remote.sha && !ops.length && !needMerge) {
        if (lastSha && remote.sha !== lastSha) addLocalLog("sync", true, "Received changes from another device or tab");
        lastSha = remote.sha;
        setShared(base); // nothing to upload — just take the latest
        done = true;
        break;
      }

      const p = await writeRemote(toFile(base), remote.sha, `Sync from ${device()} (${ops.length} change${ops.length === 1 ? "" : "s"})`);
      if (p.status === 409) continue; // another device saved first — merge again
      if (!p.ok) throw new Error(await errorOf(p));

      pending.splice(0, ops.length);
      for (const op of pending) applyOp(base, op); // changes made while uploading
      cfg!.merged = true;
      saveCfg(cfg);
      setShared(base);
      const mine = ops.filter(isImportantOp).length;
      addLocalLog(
        "sync",
        true,
        mine ? `Saved ${mine} change${mine === 1 ? "" : "s"} to the cloud` : "Saved background changes to the cloud",
      );
      done = true;
      break;
    }
    // Four conflicts in a row used to end quietly as if all was well. Say so and try again.
    if (!done) throw new Error("Another device or tab saved at the same moment — trying again shortly");
    failures = 0;
    clearTimeout(retryTimer);
    lastSync = Date.now();
    lastError = "";
  } catch (e) {
    failures++;
    lastError = e instanceof Error ? e.message : "Couldn't reach the sync server";
    addLocalLog("sync", false, `Couldn't save to the cloud: ${lastError}`);
    // keep trying while something of yours is waiting (not after a log-out: it needs you to log in again)
    if (isConnected() && pending.length) {
      clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void syncNow(), RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]);
    }
  } finally {
    busy = false;
    persist();
    onUpdated();
    emit();
    if (!lastError && unsaved() > 0) pushSoon(); // changes made while this one was uploading
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

/** On the live site the password also guards the app itself (a cookie, see worker/src/gate.ts). */
const guarded = () => SYNC_URL === "/api";

/** Back to the login page: forgets the cookie and the app copy saved for offline use, then reloads. */
async function lockApp() {
  try {
    await fetch("/gate/logout", { method: "POST" });
    for (const k of await caches.keys()) await caches.delete(k);
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch {
    /* offline: the cookie stays until the next try */
  }
  location.reload();
}

/** Log this device out. Data stays in GitHub and in this browser. */
export function disconnect() {
  cfg = null;
  saveCfg(null);
  onUpdated();
  if (guarded()) void lockApp();
}

function schedulePush() {
  if (!isConnected() || pushTimer) return;
  pushTimer = window.setTimeout(() => {
    pushTimer = undefined;
    syncNow();
  }, PUSH_DELAY_MS);
}

/** Sends your changes to the cloud in a moment (changes made together are sent together). */
function pushSoon() {
  if (!isConnected()) return;
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = undefined;
    void syncNow();
  }, URGENT_DELAY_MS);
}

function warnUnprotected() {
  if (!isAvailable() || Date.now() - lastWarn < 5 * 60_000) return;
  lastWarn = Date.now();
  unprotectedHook?.();
}

/** Start background syncing. `refresh` is called when data from another device arrives. */
export function startSync(refresh: () => void) {
  onUpdated = refresh;
  onChange(() => {
    schedulePush();
    emit();
  });
  onImportant(() => {
    if (isConnected()) pushSoon();
    else warnUnprotected();
  });
  syncNow(); // no-op until this device is logged in
  setInterval(() => {
    if (!pending.length) syncNow();
  }, PULL_EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    // upload right away when you leave the page; pull when you come back
    if (document.visibilityState === "hidden" ? pending.length : true) syncNow();
  });
  if (pending.length) schedulePush();
}
