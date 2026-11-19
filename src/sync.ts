/**
 * Syncs your saves, hidden channels, history and learning to a PRIVATE GitHub repo
 * (one JSON file). Every sync is a commit, so GitHub keeps the full history as a backup.
 *
 * The access token is stored only in this browser (localStorage) and is sent only to api.github.com.
 */
import { applyOp, fromFile, mergeInto, onChange, pending, persist, setShared, sharedOf, state, toFile } from "./store";

const CFG_KEY = "ecomgy-reel-feed.sync";
const FILE_PATH = "user-state.json";
const PUSH_DELAY_MS = 60_000; // batch changes for up to a minute
const PULL_EVERY_MS = 5 * 60_000; // pick up other devices' changes

interface Cfg { repo: string; token: string; merged: boolean }

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

export const isConnected = () => !!cfg;
export const status = () => ({
  repo: cfg?.repo ?? "", lastSync, lastError, pending: pending.length, busy,
});

// ---------- GitHub API ----------
async function gh(path: string, init: RequestInit = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg!.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

function b64encode(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64: string) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function getRemote(): Promise<{ data: any; sha: string } | null> {
  const r = await gh(`/repos/${cfg!.repo}/contents/${FILE_PATH}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(await explain(r));
  const j = await r.json();
  let content: string = j.content;
  if (!content) {
    // files over 1 MB come back without content — fetch the blob instead
    const b = await gh(`/repos/${cfg!.repo}/git/blobs/${j.sha}`);
    if (!b.ok) throw new Error(await explain(b));
    content = (await b.json()).content;
  }
  return { data: JSON.parse(b64decode(content)), sha: j.sha };
}

async function explain(r: Response) {
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return "The token is invalid or expired.";
  if (r.status === 403) return "The token doesn't have permission (needs Contents: Read and write on this repo).";
  if (r.status === 404) return "Repo not found, or the token can't access it.";
  return `GitHub error ${r.status}: ${j?.message ?? "unknown"}`;
}

const device = () => (/Mobi|Android|iPhone/i.test(navigator.userAgent) ? "phone" : "computer");

// ---------- sync ----------
/** Pull the latest file, replay this device's pending changes on top, push back. Retries on conflicts. */
export async function syncNow(): Promise<void> {
  if (!cfg || busy) return;
  busy = true;
  onUpdated();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await getRemote();
      const base = fromFile(remote?.data ?? null);
      const needMerge = !cfg.merged;
      if (needMerge) mergeInto(base, sharedOf(state));
      const ops = pending.slice();
      for (const op of ops) applyOp(base, op);

      if (remote && !ops.length && !needMerge) {
        setShared(base); // nothing to upload — just take the latest
        break;
      }

      const r = await gh(`/repos/${cfg.repo}/contents/${FILE_PATH}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `Sync from ${device()} (${ops.length} change${ops.length === 1 ? "" : "s"})`,
          content: b64encode(JSON.stringify(toFile(base))),
          ...(remote ? { sha: remote.sha } : {}),
        }),
      });
      if (r.status === 409 || r.status === 422) continue; // another device saved first — merge again
      if (!r.ok) throw new Error(await explain(r));

      pending.splice(0, ops.length);
      for (const op of pending) applyOp(base, op); // changes made while uploading
      cfg.merged = true;
      saveCfg(cfg);
      setShared(base);
      break;
    }
    lastSync = Date.now();
    lastError = "";
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    persist();
    onUpdated();
  }
}

/** Connect this device. Returns an error message, or null on success. */
export async function connect(repo: string, token: string): Promise<string | null> {
  repo = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  token = token.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return "Repo should look like: your-username/reel-feed-data";
  if (!token) return "Paste your access token.";
  const prev = cfg;
  cfg = { repo, token, merged: false };
  const r = await gh(`/repos/${repo}`);
  if (!r.ok) { const msg = await explain(r); cfg = prev; return msg; }
  const info = await r.json();
  if (!info.private) {
    cfg = prev;
    return "That repo is public — anyone could read your data. Use a private repo.";
  }
  saveCfg(cfg);
  await syncNow();
  return lastError || null;
}

/** Forget the token on this device. Data stays in GitHub and in this browser. */
export function disconnect() {
  cfg = null;
  saveCfg(null);
  onUpdated();
}

function schedulePush() {
  if (!cfg || pushTimer) return;
  pushTimer = window.setTimeout(() => { pushTimer = undefined; syncNow(); }, PUSH_DELAY_MS);
}

/** Start background syncing. `refresh` is called when data from another device arrives. */
export function startSync(refresh: () => void) {
  onUpdated = refresh;
  onChange(schedulePush);
  syncNow(); // no-op until a device is connected
  setInterval(() => { if (!pending.length) syncNow(); }, PULL_EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    // upload right away when you leave the page; pull when you come back
    if (document.visibilityState === "hidden" ? pending.length : true) syncNow();
  });
  if (pending.length) schedulePush();
}
