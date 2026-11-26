/**
 * Freed sync server (Cloudflare Worker).
 *
 * - Login with APP_PASSWORD → signed 180-day session. Devices never see any token.
 * - /state           read/write user-state.json in the private data repo (saves, history, learning)
 * - /state/versions  earlier versions of it (one per day, from the repo's history) — for "restore from the cloud"
 * - /state/at        one earlier version
 * - /channels        read/edit channels.json in the code repo (commit triggers a refresh)
 * - /lookup          look a channel up on YouTube before adding it
 * - /refresh,/status start the "Fetch Shorts & deploy" workflow / see the latest run
 *
 * Secrets (`npx wrangler secret put NAME`):
 *   GITHUB_TOKEN     fine-grained: reel-feed-data (Contents RW) + reel-feed (Contents RW, Actions RW)
 *   APP_PASSWORD     the password you type on each device
 *   SESSION_SECRET   random string used to sign sessions
 *   YOUTUBE_API_KEY  for channel lookups
 * Changing APP_PASSWORD or SESSION_SECRET logs out every device.
 */
// Categories and their keyword rules are shared with the app and the fetch script (bundled in by wrangler)
import { type CatId, isCat, LEGACY, normCats } from "../../src/categories";
import { pickCats, textScores } from "../../src/classify";

const suggested = (cats: CatId[]) => ({ suggestedCats: cats, suggestedCat: cats[0] ?? "" });

export interface Env {
  GITHUB_TOKEN: string;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  YOUTUBE_API_KEY?: string;
  DATA_REPO: string; // "owner/repo" (private) holding user-state.json
  CODE_REPO: string; // "owner/repo" holding channels.json + the workflow
  WORKFLOW_FILE: string; // e.g. "deploy.yml"
  ALLOWED_ORIGINS: string; // comma-separated
  GITHUB_API?: string; // only for local testing
  YOUTUBE_API?: string; // only for local testing
  QUOTA?: KVNamespace; // daily quota counter, budget setting, cached previews/searches
}

type Cors = Record<string, string>;
const STATE_FILE = "user-state.json";
const CHANNELS_FILE = "channels.json";
const SESSION_DAYS = 180;
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req.headers.get("Origin") ?? "", env);
    if (!cors) return json({ error: "Origin not allowed" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "POST /login") return await login(req, env, cors);

      if (!(await verifySession(req.headers.get("Authorization"), env))) {
        return json({ error: "Please log in again" }, 401, cors);
      }
      return await withRequestId(req, env, cors, () => handle(route, req, env, cors));
    } catch (e) {
      // Visible in `npx wrangler tail` and the Cloudflare dashboard logs
      console.error(`${route} failed:`, e instanceof Error ? e.message : e);
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      // Unexpected (e.g. GitHub/YouTube briefly unreachable): plain-language message, details in the log.
      return json({ error: "Couldn't reach GitHub or YouTube just now — nothing was changed. Try again in a moment." }, 503, cors);
    }
  },
};

/**
 * Duplicate protection: the app sends an X-Request-Id with every change and reuses it when it
 * retries. If we've already handled that ID (double tap, retry after a timeout), we return the
 * saved answer instead of doing the work again — so a change can never be applied twice.
 */
async function withRequestId(req: Request, env: Env, cors: Cors, run: () => Promise<Response>): Promise<Response> {
  const rid = req.headers.get("X-Request-Id") ?? "";
  if (req.method === "GET" || !env.QUOTA || !/^[\w-]{8,80}$/.test(rid)) return run();
  const key = `rid:${rid}`;
  let seen = (await env.QUOTA.get(key, "json")) as { status: number; body: string } | null;
  // The first copy is still running: wait for its answer (up to ~10 s) instead of running it again.
  for (let i = 0; seen?.status === 0 && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    seen = (await env.QUOTA.get(key, "json")) as typeof seen;
  }
  if (seen) {
    if (seen.status === 0) return json({ error: "Still working on this request — check again in a moment" }, 409, cors);
    return new Response(seen.body, { status: seen.status, headers: { "Content-Type": "application/json", "X-Repeat": "1", ...cors } });
  }
  await env.QUOTA.put(key, JSON.stringify({ status: 0, body: "" }), { expirationTtl: 600 }); // in progress
  let res: Response;
  try {
    res = await run();
  } catch (e) {
    await env.QUOTA.delete(key); // failed — allow a real retry
    throw e;
  }
  if (res.status >= 500) {
    await env.QUOTA.delete(key);
    return res;
  }
  const body = await res.clone().text();
  if (body.length < 100_000) await env.QUOTA.put(key, JSON.stringify({ status: res.status, body }), { expirationTtl: 600 });
  return res;
}

async function handle(route: string, req: Request, env: Env, cors: Cors): Promise<Response> {
  switch (route) {
    // "Is this session still good?" The app's Worker asks this before it serves the app to anyone.
    case "GET /session":
      return json({ ok: true }, 200, cors);
    case "GET /state":
      return json(await readJsonFile(env, env.DATA_REPO, STATE_FILE), 200, cors);
    case "PUT /state":
      return await putState(req, env, cors);
    // The same file, but passed through untouched (base64 as GitHub stores it). See readRawFile.
    case "GET /state2":
      return json(await readRawFile(env, env.DATA_REPO, STATE_FILE), 200, cors);
    case "PUT /state2":
      return await putStateRaw(req, env, cors);
    case "GET /state/at2":
      return json(await stateAtRaw(env, new URL(req.url)), 200, cors);
    case "GET /state/versions":
      return json(await stateVersions(env, new URL(req.url)), 200, cors);
    case "GET /state/at":
      return json(await stateAt(env, new URL(req.url)), 200, cors);
    case "GET /channels":
      return json(await readJsonFile(env, env.CODE_REPO, CHANNELS_FILE), 200, cors);
    case "POST /channels":
      return await editChannels(req, env, cors);
    case "POST /lookup":
      return json(await lookup(req, env), 200, cors);
    case "GET /video-info":
      return json(await videoInfo(env, new URL(req.url)), 200, cors);
    case "GET /video-comments":
      return json(await videoComments(env, new URL(req.url)), 200, cors);
    case "GET /quota":
      return json(await quotaStatus(env), 200, cors);
    case "POST /quota":
      return json(await setBudget(req, env), 200, cors);
    case "POST /channel-shorts":
      return json(await channelShorts(req, env), 200, cors);
    case "POST /search-shorts":
      return json(await searchShorts(req, env), 200, cors);
    case "POST /refresh":
      return json(await refresh(env), 200, cors);
    case "GET /status":
      return json(await runStatus(env), 200, cors);
    case "GET /health":
      return json(await health(env), 200, cors);
    case "POST /log":
      return json(await logError(req, env), 200, cors);
  }
  return json({ error: "Not found" }, 404, cors);
}

// ---------- CORS ----------
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/;

function corsHeaders(origin: string, env: Env): Cors | null {
  const allowed = env.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origin || !(allowed.includes(origin) || DEV_ORIGIN.test(origin))) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status = 200, headers: Cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      // security headers: never sniff types, never leak the URL, never allow framing
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      ...headers,
    },
  });
}

// ---------- login & sessions ----------
async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(env: Env, data: string) {
  // Key includes the password, so changing the password invalidates every session.
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(`${env.SESSION_SECRET}:${env.APP_PASSWORD}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_SECONDS = 15 * 60;

async function login(req: Request, env: Env, cors: Cors) {
  // Login attempt limit: after 5 wrong passwords from one connection, block it for 15 minutes.
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const failKey = `login-fail:${ip}`;
  const fails = Number((await env.QUOTA?.get(failKey)) ?? 0);
  if (fails >= MAX_FAILED_LOGINS) {
    return json({ error: "Too many wrong passwords. Wait 15 minutes, then try again." }, 429, cors);
  }
  const body = (await req.json().catch(() => ({}))) as { password?: string };
  const ok = sameBytes(await sha256(String(body.password ?? "")), await sha256(env.APP_PASSWORD));
  if (!ok) {
    await env.QUOTA?.put(failKey, String(fails + 1), { expirationTtl: LOCKOUT_SECONDS });
    console.warn(`Wrong password (${fails + 1}/${MAX_FAILED_LOGINS}) from ${ip}`);
    await new Promise((r) => setTimeout(r, 800)); // slows down guessing
    const left = MAX_FAILED_LOGINS - fails - 1;
    return json(
      {
        error:
          left > 0
            ? `Wrong password (${left} tr${left === 1 ? "y" : "ies"} left before a 15-minute pause)`
            : "Wrong password. Too many tries — wait 15 minutes.",
      },
      401,
      cors,
    );
  }
  if (fails) await env.QUOTA?.delete(failKey);
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400_000 })));
  const sig = b64url(await hmac(env, payload));
  return json({ session: `${payload}.${sig}` }, 200, cors);
}

async function verifySession(header: string | null, env: Env) {
  const token = header?.replace(/^Bearer\s+/i, "") ?? "";
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  try {
    if (!sameBytes(fromB64url(sig), await hmac(env, payload))) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

// ---------- GitHub ----------
let knownTokenExpiry = "";
async function gh(env: Env, path: string, init: RequestInit = {}) {
  const r = await fetch(`${env.GITHUB_API ?? "https://api.github.com"}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "reel-feed-sync",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  // GitHub tells us when a fine-grained token expires — remember it so the app can warn in time.
  const exp = r.headers.get("github-authentication-token-expiration");
  if (exp && exp !== knownTokenExpiry) {
    knownTokenExpiry = exp;
    await env.QUOTA?.put("token-exp", exp);
  }
  return r;
}

// ---------- /health, /log ----------
async function health(env: Env) {
  let tokenExpires = (await env.QUOTA?.get("token-exp")) ?? null;
  if (!tokenExpires) {
    await gh(env, `/repos/${env.DATA_REPO}`); // any call returns the expiry header
    tokenExpires = (await env.QUOTA?.get("token-exp")) ?? null;
  }
  const errors = ((await env.QUOTA?.get("errlog", "json")) ?? []) as ErrorReport[];
  return { ok: true, tokenExpires, errorsLast7d: errors.filter((e) => Date.now() - e.at < 7 * 86400_000).length, now: Date.now() };
}

interface ErrorReport {
  at: number;
  msg: string;
  where: string;
  ver: string;
  ua: string;
  stack?: string;
}
const MAX_REPORTS_PER_MINUTE = 20;

/** The app reports crashes here; they're printed for `wrangler tail` and the last 50 are kept in KV. */
async function logError(req: Request, env: Env) {
  const minute = `lograte:${Math.floor(Date.now() / 60_000)}`;
  const n = Number((await env.QUOTA?.get(minute)) ?? 0);
  if (n >= MAX_REPORTS_PER_MINUTE) return { ok: false, reason: "rate limited" };
  await env.QUOTA?.put(minute, String(n + 1), { expirationTtl: 120 });
  const b = (await req.json().catch(() => ({}))) as Partial<ErrorReport>;
  const report: ErrorReport = {
    at: Date.now(),
    msg: String(b.msg ?? "").slice(0, 300),
    where: String(b.where ?? "").slice(0, 200),
    ver: String(b.ver ?? "").slice(0, 40),
    ua: String(req.headers.get("User-Agent") ?? "").slice(0, 160),
    stack: b.stack ? String(b.stack).slice(0, 1500) : undefined,
  };
  console.error("App error:", report.msg, "|", report.where, "|", report.ver);
  const log = ((await env.QUOTA?.get("errlog", "json")) ?? []) as ErrorReport[];
  await env.QUOTA?.put("errlog", JSON.stringify([report, ...log].slice(0, 50)));
  return { ok: true };
}

function b64encode(text: string) {
  const bytes = enc.encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function githubError(r: Response, what: string) {
  if (r.status === 401) return "GitHub token is invalid or expired (update GITHUB_TOKEN)";
  if (r.status === 403) return `GitHub token lacks permission for ${what}`;
  if (r.status === 404) return `${what} not found, or the token can't access it`;
  const j = (await r.json().catch(() => ({}))) as { message?: string };
  return `GitHub error ${r.status}: ${j.message ?? "unknown"}`;
}

/** Reads a JSON file from a repo (at a commit, if `ref` is given). Returns { data: null, sha: null } if it doesn't exist. */
async function readJsonFile(env: Env, repo: string, path: string, ref = ""): Promise<{ data: any; sha: string | null }> {
  const r = await gh(env, `/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ""}`);
  if (r.status === 404) {
    const repoCheck = await gh(env, `/repos/${repo}`);
    if (!repoCheck.ok) throw new HttpError(502, await githubError(repoCheck, `repo ${repo}`));
    return { data: null, sha: null };
  }
  if (!r.ok) throw new HttpError(502, await githubError(r, `${repo}/${path}`));
  const j = (await r.json()) as { content?: string; sha: string };
  let content = j.content;
  if (!content) {
    // files over 1 MB come back without content — read the blob instead
    const b = await gh(env, `/repos/${repo}/git/blobs/${j.sha}`);
    if (!b.ok) throw new HttpError(502, await githubError(b, `${repo}/${path}`));
    content = ((await b.json()) as { content: string }).content;
  }
  return { data: JSON.parse(b64decode(content)), sha: j.sha };
}

/**
 * Reads a file WITHOUT opening it: returns GitHub's own base64 text and the sha, as is.
 * Why: Cloudflare's free plan allows only ~10 ms of processor time per request. Decoding, parsing and
 * re-encoding a big data file (hundreds of videos, notes, history) takes 50-100 ms, so the request was
 * cut off with a bare "500". Passing the text through takes under a millisecond; the app (the browser,
 * which has no such limit) does the decoding and encoding.
 */
async function readRawFile(env: Env, repo: string, path: string, ref = ""): Promise<{ content: string | null; sha: string | null }> {
  const r = await gh(env, `/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ""}`);
  if (r.status === 404) {
    const repoCheck = await gh(env, `/repos/${repo}`);
    if (!repoCheck.ok) throw new HttpError(502, await githubError(repoCheck, `repo ${repo}`));
    return { content: null, sha: null };
  }
  if (!r.ok) throw new HttpError(502, await githubError(r, `${repo}/${path}`));
  const j = (await r.json()) as { content?: string; sha: string };
  let content = j.content;
  if (!content) {
    // files over 1 MB come back without content — read the blob instead
    const b = await gh(env, `/repos/${repo}/git/blobs/${j.sha}`);
    if (!b.ok) throw new HttpError(502, await githubError(b, `${repo}/${path}`));
    content = ((await b.json()) as { content: string }).content;
  }
  return { content: content.replace(/\s/g, ""), sha: j.sha };
}

/** Writes a file. Returns the new sha, or null if someone else changed it first (conflict). */
async function writeFile(env: Env, repo: string, path: string, text: string, sha: string | null, message: string) {
  return writeRaw(env, repo, path, b64encode(text), sha, message);
}
/** The same, with the content already base64-encoded. */
async function writeRaw(env: Env, repo: string, path: string, base64: string, sha: string | null, message: string) {
  const r = await gh(env, `/repos/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message: message.slice(0, 200), content: base64, ...(sha ? { sha } : {}) }),
  });
  if (r.status === 409 || r.status === 422) return null;
  if (!r.ok) throw new HttpError(502, await githubError(r, `${repo}/${path}`));
  return ((await r.json()) as { content: { sha: string } }).content.sha;
}

// ---------- /state ----------
async function putState(req: Request, env: Env, cors: Cors) {
  const body = (await req.json()) as { data?: unknown; sha?: string | null; message?: string };
  if (!body.data || typeof body.data !== "object") return json({ error: "Missing data" }, 400, cors);
  const text = JSON.stringify(body.data);
  if (text.length > 5_000_000) return json({ error: "Data too large" }, 413, cors);
  const sha = await writeFile(env, env.DATA_REPO, STATE_FILE, text, body.sha ?? null, String(body.message ?? "Sync"));
  // conflict = another device saved first; the app re-reads and merges
  if (!sha) return json({ error: "conflict" }, 409, cors);
  return json({ sha }, 200, cors);
}

/** Saves the data file passed through untouched: { content: base64, sha, message } (see readRawFile). */
async function putStateRaw(req: Request, env: Env, cors: Cors) {
  const body = (await req.json()) as { content?: unknown; sha?: string | null; message?: string };
  if (typeof body.content !== "string" || !body.content) return json({ error: "Missing data" }, 400, cors);
  if (body.content.length > 7_000_000) return json({ error: "Data too large" }, 413, cors); // ~5 MB of text
  const sha = await writeRaw(env, env.DATA_REPO, STATE_FILE, body.content, body.sha ?? null, String(body.message ?? "Sync"));
  if (!sha) return json({ error: "conflict" }, 409, cors);
  return json({ sha }, 200, cors);
}

/**
 * Earlier versions of user-state.json, newest first: the latest one of each of the last `days` days
 * (every sync is a commit, so there are many a day — one per day is what you'd pick from).
 * One GitHub call per day, in parallel; days without a sync repeat the day before and are skipped.
 */
const MAX_VERSION_DAYS = 30;
async function stateVersions(env: Env, url: URL) {
  const days = Math.min(MAX_VERSION_DAYS, Math.max(1, Number(url.searchParams.get("days")) || MAX_VERSION_DAYS));
  const endOfToday = new Date();
  endOfToday.setUTCHours(23, 59, 59, 999);
  const found = await Promise.all(
    Array.from({ length: days }, async (_, i) => {
      const until = new Date(endOfToday.getTime() - i * 86400_000).toISOString();
      const r = await gh(env, `/repos/${env.DATA_REPO}/commits?path=${STATE_FILE}&per_page=1&until=${until}`);
      if (!r.ok) throw new HttpError(502, await githubError(r, `history of ${env.DATA_REPO}/${STATE_FILE}`));
      const [c] = (await r.json()) as {
        sha: string;
        commit: { message: string; committer?: { date?: string }; author?: { date?: string } };
      }[];
      return c
        ? { sha: c.sha, at: Date.parse(c.commit.committer?.date ?? c.commit.author?.date ?? "") || 0, msg: c.commit.message.slice(0, 120) }
        : null;
    }),
  );
  const seen = new Set<string>();
  const versions = found.filter((v): v is NonNullable<typeof v> => !!v && !seen.has(v.sha) && !!seen.add(v.sha));
  return { versions };
}

/** One earlier version of user-state.json (`sha` = a commit from /state/versions). */
async function stateAtRaw(env: Env, url: URL) {
  const sha = url.searchParams.get("sha") ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(400, "Unknown version");
  const { content } = await readRawFile(env, env.DATA_REPO, STATE_FILE, sha);
  if (!content) throw new HttpError(404, "That version has no saved data");
  return { content };
}
async function stateAt(env: Env, url: URL) {
  const sha = url.searchParams.get("sha") ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(400, "Unknown version");
  const { data } = await readJsonFile(env, env.DATA_REPO, STATE_FILE, sha);
  if (!data) throw new HttpError(404, "That version has no saved data");
  return { data };
}

// ---------- /channels ----------
interface ChannelEntry {
  name: string;
  handle: string;
  cats?: CatId[];
  cat?: string; // old single category — replaced by `cats` the next time the channel is edited
  id?: string;
  status?: "removed";
  addedAt?: string;
  removedAt?: string;
}
type ChannelOp =
  | { t: "add"; channel: { name: string; handle: string; id?: string; cats?: string[]; cat?: string } }
  | { t: "remove"; h: string }
  | { t: "restore"; h: string }
  | { t: "delete"; h: string }
  | { t: "cats"; h: string; cats: string[] }
  | { t: "cat"; h: string; cat: string }; // from an older version of the app

const sameHandle = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function applyChannelOp(list: ChannelEntry[], op: ChannelOp): string {
  const find = (h: string) => {
    const c = list.find((x) => sameHandle(x.handle, h));
    if (!c) throw new HttpError(404, `${h} is not in the channel list`);
    return c;
  };
  /** 1–3 known categories (an older app sends one old-style `cat`, which is translated). */
  const checkCats = (cats: unknown, legacy?: unknown): CatId[] => {
    if (Array.isArray(cats)) {
      const bad = cats.find((c) => !isCat(c));
      if (bad !== undefined) throw new HttpError(400, `Unknown category "${String(bad).slice(0, 40)}"`);
    } else if (legacy !== undefined && !(typeof legacy === "string" && (legacy in LEGACY || isCat(legacy)))) {
      throw new HttpError(400, `Unknown category "${String(legacy).slice(0, 40)}"`);
    }
    const out = normCats(cats, legacy);
    if (!out.length && legacy !== "bangla" && legacy !== "other") throw new HttpError(400, "Pick at least one category");
    return out;
  };
  const now = new Date().toISOString();
  switch (op.t) {
    case "add": {
      const { name, handle, id, cats: rawCats, cat } = op.channel ?? ({} as any);
      // YouTube handles may use any script (e.g. Bangla) and sometimes come URL-encoded
      if (!/^(@[\p{L}\p{M}\p{N}._\-·%]{2,150}|UC[\w-]{22})$/u.test(String(handle))) {
        throw new HttpError(400, `Can't add: unexpected channel handle "${String(handle).slice(0, 60)}"`);
      }
      if (!name || String(name).length > 200) throw new HttpError(400, "Can't add: missing or too long channel name");
      if (id && !/^UC[\w-]{22}$/.test(id)) throw new HttpError(400, "Invalid channel ID");
      const cats = checkCats(rawCats, cat);
      const existing = list.find((x) => sameHandle(x.handle, handle) || (id && x.id === id));
      if (existing && existing.status !== "removed") throw new HttpError(409, `${existing.name} is already in the list`);
      if (existing) {
        delete existing.status;
        delete existing.removedAt;
        delete existing.cat;
        existing.cats = cats;
        if (id) existing.id = id;
        return `restore ${existing.handle}`;
      }
      list.push({ name: String(name), handle, ...(id ? { id } : {}), cats, addedAt: now });
      return `add ${handle}`;
    }
    case "remove": {
      const c = find(op.h);
      c.status = "removed";
      c.removedAt = now;
      return `remove ${c.handle}`;
    }
    case "restore": {
      const c = find(op.h);
      delete c.status;
      delete c.removedAt;
      return `restore ${c.handle}`;
    }
    case "delete": {
      const c = find(op.h);
      if (c.status !== "removed") throw new HttpError(400, "Remove the channel first; delete is only for removed channels");
      list.splice(list.indexOf(c), 1);
      return `delete ${c.handle}`;
    }
    case "cats":
    case "cat": {
      const cats = op.t === "cats" ? checkCats(op.cats) : checkCats(undefined, op.cat);
      const c = find(op.h);
      delete c.cat;
      c.cats = cats;
      return `categories ${c.handle} → ${cats.join(", ") || "none"}`;
    }
    default:
      throw new HttpError(400, "Unknown change");
  }
}

const formatChannels = (list: ChannelEntry[]) => `[\n${list.map((c) => `  ${JSON.stringify(c)}`).join(",\n")}\n]\n`;

async function editChannels(req: Request, env: Env, cors: Cors) {
  const body = (await req.json().catch(() => ({}))) as { ops?: ChannelOp[] };
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, 50) : [];
  if (!ops.length) return json({ error: "No changes" }, 400, cors);

  for (let attempt = 0; attempt < 4; attempt++) {
    const file = await readJsonFile(env, env.CODE_REPO, CHANNELS_FILE);
    const list: ChannelEntry[] = Array.isArray(file.data) ? file.data : [];
    const notes = ops.map((op) => applyChannelOp(list, op));
    const sha = await writeFile(
      env,
      env.CODE_REPO,
      CHANNELS_FILE,
      formatChannels(list),
      file.sha,
      `Channels (from app): ${notes.join("; ")}`,
    );
    if (sha) return json({ data: list, sha }, 200, cors);
  }
  return json({ error: "The channel list kept changing — try again" }, 409, cors);
}

// ---------- /lookup (YouTube) ----------
interface ChannelInfo {
  id: string;
  name: string;
  handle: string;
  thumb: string;
  subs: number;
  videos: number;
  desc: string;
  shorts: number;
  latestShort: number;
  suggestedCats: CatId[];
  suggestedCat: string; // first of suggestedCats, for older versions of the app
}

async function yt(env: Env, endpoint: string, params: Record<string, string | number>, used: { units: number }) {
  if (!env.YOUTUBE_API_KEY) throw new HttpError(500, "YOUTUBE_API_KEY is not set on the sync server");
  const url = new URL(`${env.YOUTUBE_API ?? "https://www.googleapis.com/youtube/v3"}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("key", env.YOUTUBE_API_KEY);
  used.units += endpoint === "search" ? 100 : 1;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as any;
    const reason = j?.error?.errors?.[0]?.reason ?? "";
    if (/quota/i.test(reason)) throw new HttpError(429, "YouTube API daily quota is used up — try again tomorrow");
    throw new HttpError(502, `YouTube error ${r.status}: ${j?.error?.message ?? reason}`);
  }
  return r.json() as Promise<any>;
}

type Query = { kind: "handle" | "id" | "video" | "username" | "text"; v: string };

function parseQuery(raw: string): Query {
  const q = raw.trim();
  if (/youtube\.com|youtu\.be/i.test(q)) {
    try {
      const u = new URL(/^https?:/i.test(q) ? q : `https://${q}`);
      const parts = u.pathname.split("/").filter(Boolean);
      if (u.hostname.includes("youtu.be") && parts[0]) return { kind: "video", v: parts[0] };
      if (parts[0]?.startsWith("@")) return { kind: "handle", v: decodeURIComponent(parts[0]) };
      if (parts[0] === "channel" && parts[1]) return { kind: "id", v: parts[1] };
      if ((parts[0] === "shorts" || parts[0] === "live") && parts[1]) return { kind: "video", v: parts[1] };
      if (u.searchParams.get("v")) return { kind: "video", v: u.searchParams.get("v")! };
      if (parts[0] === "user" && parts[1]) return { kind: "username", v: parts[1] };
      if (parts[0] === "c" && parts[1]) return { kind: "text", v: parts[1] };
    } catch {
      /* fall through */
    }
  }
  if (q.startsWith("@")) return { kind: "handle", v: q };
  if (/^UC[\w-]{22}$/.test(q)) return { kind: "id", v: q };
  if (/^[\w.-]{3,100}$/.test(q)) return { kind: "handle", v: `@${q}` }; // single word → try as a handle
  return { kind: "text", v: q };
}

/** Up to 2 categories for a channel, from its name and description (same rules as each Short's sorting). */
function suggestCats(name: string, desc: string): CatId[] {
  const picked = pickCats(textScores({ title: name, desc }), {});
  return picked.cats.length ? picked.cats.slice(0, 2) : ["marketing"];
}

async function channelInfo(env: Env, ids: string[], used: { units: number }): Promise<ChannelInfo[]> {
  if (!ids.length) return [];
  const j = await yt(env, "channels", { part: "snippet,statistics", id: ids.join(","), maxResults: 50 }, used);
  const items: any[] = j?.items ?? [];
  return Promise.all(
    items.map(async (it) => {
      // Shorts-only playlist: total count + newest Short (1 unit)
      const p = await yt(env, "playlistItems", { part: "contentDetails", playlistId: `UUSH${it.id.slice(2)}`, maxResults: 1 }, used);
      const desc: string = it.snippet?.description ?? "";
      const name: string = it.snippet?.title ?? "";
      return {
        id: it.id,
        name,
        handle: it.snippet?.customUrl ? (it.snippet.customUrl.startsWith("@") ? it.snippet.customUrl : `@${it.snippet.customUrl}`) : it.id,
        thumb: it.snippet?.thumbnails?.medium?.url ?? it.snippet?.thumbnails?.default?.url ?? "",
        subs: Number(it.statistics?.subscriberCount ?? 0),
        videos: Number(it.statistics?.videoCount ?? 0),
        desc: desc.slice(0, 400),
        shorts: Number(p?.pageInfo?.totalResults ?? 0),
        latestShort: p?.items?.[0]?.contentDetails?.videoPublishedAt
          ? Math.floor(Date.parse(p.items[0].contentDetails.videoPublishedAt) / 1000)
          : 0,
        ...suggested(suggestCats(name, desc)),
      };
    }),
  );
}

async function lookup(req: Request, env: Env) {
  const body = (await req.json().catch(() => ({}))) as { q?: string; search?: boolean };
  const raw = String(body.q ?? "").slice(0, 300);
  if (!raw.trim()) throw new HttpError(400, "Type a handle, link or name");
  const used = { units: 0 };
  const q = parseQuery(raw);
  let ids: string[] = [];
  if (q.kind === "text" && !body.search) return { results: [], units: 0, needsSearch: true };
  await guard(env, body.search ? 106 : 3);
  try {
    ids = await lookupIds(env, raw, q, !!body.search, used);
    const results = await channelInfo(env, ids, used);
    return { results, units: used.units, needsSearch: false, quota: await addUsed(env, used.units) };
  } catch (e) {
    await addUsed(env, used.units); // count units spent even if something failed
    throw e;
  }
}

/** What the player page shows about a video: description, numbers, channel (2 YouTube units; kept a day in the edge cache, so a repeat costs nothing and nothing is written to KV). */
const num = (x: unknown) => (x === undefined || x === null || x === "" ? null : Number(x));
async function cached<T>(name: string, id: string, make: () => Promise<T>): Promise<T> {
  const store = typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://${name}.invalid/${id}`);
  const hit = await store?.match(key);
  if (hit) return (await hit.json()) as T;
  const out = await make();
  await store?.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=86400" } }));
  return out;
}
async function videoInfo(env: Env, u: URL) {
  const id = u.searchParams.get("id") ?? "";
  if (!/^[\w-]{11}$/.test(id)) throw new HttpError(400, "That isn't a video id");
  return cached("video-info2", id, async () => {
    const used = { units: 0 };
    const v = (await yt(env, "videos", { part: "snippet,statistics", id }, used))?.items?.[0];
    const sn = v?.snippet ?? {};
    const st = v?.statistics ?? {};
    let ch: { id: string; n: string; img: string; subs: number | null } | null = null;
    if (sn.channelId) {
      const c = (await yt(env, "channels", { part: "snippet,statistics", id: sn.channelId }, used))?.items?.[0];
      ch = {
        id: String(sn.channelId),
        n: String(c?.snippet?.title ?? sn.channelTitle ?? ""),
        img: String(c?.snippet?.thumbnails?.default?.url ?? ""),
        subs: c?.statistics?.hiddenSubscriberCount ? null : num(c?.statistics?.subscriberCount),
      };
    }
    return {
      desc: String(sn.description ?? "").slice(0, 5000),
      ch,
      v: num(st.viewCount),
      l: num(st.likeCount),
      c: num(st.commentCount),
      p: String(sn.publishedAt ?? ""),
      tags: Array.isArray(sn.tags) ? sn.tags.slice(0, 8).map(String) : [],
    };
  });
}

/** The top comments of a video (1 unit, only when someone opens them; a day in the edge cache). */
async function videoComments(env: Env, u: URL) {
  const id = u.searchParams.get("id") ?? "";
  if (!/^[\w-]{11}$/.test(id)) throw new HttpError(400, "That isn't a video id");
  return cached("video-comments", id, async () => {
    try {
      const j = await yt(env, "commentThreads", { part: "snippet", videoId: id, order: "relevance", maxResults: 20, textFormat: "plainText" }, { units: 0 });
      const items = (j?.items ?? []).map((it: any) => {
        const c = it.snippet?.topLevelComment?.snippet ?? {};
        return {
          a: String(c.authorDisplayName ?? ""),
          img: String(c.authorProfileImageUrl ?? ""),
          t: String(c.textDisplay ?? "").slice(0, 1200),
          l: num(c.likeCount) ?? 0,
          p: String(c.publishedAt ?? ""),
          r: num(it.snippet?.totalReplyCount) ?? 0,
        };
      });
      return { items, off: false };
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) throw e;
      return { items: [], off: true }; // comments are switched off on that video
    }
  });
}

async function lookupIds(env: Env, raw: string, q: Query, search: boolean, used: { units: number }): Promise<string[]> {
  let ids: string[] = [];
  if (search) {
    // Name search — costs 100 units, only when explicitly asked for
    const s = await yt(env, "search", { part: "snippet", type: "channel", q: raw.trim(), maxResults: 5 }, used);
    ids = (s?.items ?? []).map((it: any) => it.snippet?.channelId ?? it.id?.channelId).filter(Boolean);
  } else if (q.kind === "handle") {
    const j = await yt(env, "channels", { part: "id", forHandle: q.v }, used);
    ids = (j?.items ?? []).map((it: any) => it.id);
  } else if (q.kind === "username") {
    const j = await yt(env, "channels", { part: "id", forUsername: q.v }, used);
    ids = (j?.items ?? []).map((it: any) => it.id);
  } else if (q.kind === "id") {
    ids = [q.v];
  } else if (q.kind === "video") {
    const j = await yt(env, "videos", { part: "snippet", id: q.v }, used);
    ids = (j?.items ?? []).map((it: any) => it.snippet?.channelId).filter(Boolean);
  }
  return ids;
}

// ---------- quota guard (KV) ----------
const DAILY_LIMIT = 10_000;
const DEFAULT_BUDGET = 3_000; // daily budget for paid actions from the app (lookups, previews, searches)
const DEFAULT_RESERVE = 1_500; // kept free for the automatic refreshes — the budget can never eat into it
const MIN_BUDGET = 100;

const pacificDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function settings(env: Env) {
  const s = ((await env.QUOTA?.get("settings", "json")) ?? {}) as { budget?: number; reserve?: number };
  const reserve = s.reserve ?? DEFAULT_RESERVE;
  const budget = Math.min(s.budget ?? DEFAULT_BUDGET, DAILY_LIMIT - reserve);
  return { budget, reserve };
}
async function counter(env: Env, kind: "used" | "saved", day = pacificDay()) {
  return Number((await env.QUOTA?.get(`${kind}:${day}`)) ?? 0);
}
async function bump(env: Env, kind: "used" | "saved", units: number) {
  if (!env.QUOTA || !units) return;
  const day = pacificDay();
  const now = await counter(env, kind, day);
  await env.QUOTA.put(`${kind}:${day}`, String(now + units), { expirationTtl: 10 * 86400 });
}

/** Refuses a paid action if it would go over today's budget. This is the hard lock — the app's warnings are the soft one. */
async function guard(env: Env, cost: number) {
  if (!env.QUOTA) return;
  const { budget } = await settings(env);
  const used = await counter(env, "used");
  if (used + cost > budget) {
    throw new HttpError(
      429,
      `Today's discovery budget is used up (${used.toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} units). ` +
        "It resets at midnight Pacific time, or raise the budget on the API usage page.",
    );
  }
}

/** Records units spent and returns the fresh numbers for the app's toast. */
async function addUsed(env: Env, units: number) {
  await bump(env, "used", units);
  const { budget } = await settings(env);
  return { used: await counter(env, "used"), budget };
}

async function quotaStatus(env: Env) {
  const { budget, reserve } = await settings(env);
  const days = Array.from({ length: 7 }, (_, i) => pacificDay(new Date(Date.now() - i * 86400_000)));
  const savedWeek = (await Promise.all(days.map((d) => counter(env, "saved", d)))).reduce((a, b) => a + b, 0);
  const usedWeek = (await Promise.all(days.map((d) => counter(env, "used", d)))).reduce((a, b) => a + b, 0);
  const recent = ((await env.QUOTA?.get("q:index", "json")) ?? []) as SearchIndexEntry[];
  return {
    enabled: !!env.QUOTA,
    day: days[0],
    used: await counter(env, "used"),
    budget,
    reserve,
    limit: DAILY_LIMIT,
    maxBudget: DAILY_LIMIT - reserve,
    savedWeek,
    usedWeek,
    recent,
  };
}

async function setBudget(req: Request, env: Env) {
  if (!env.QUOTA) throw new HttpError(500, "Quota storage isn't set up on the sync server");
  const body = (await req.json().catch(() => ({}))) as { budget?: number };
  const { reserve } = await settings(env);
  const budget = Math.round(Number(body.budget));
  if (!Number.isFinite(budget) || budget < MIN_BUDGET || budget > DAILY_LIMIT - reserve) {
    throw new HttpError(
      400,
      `Budget must be between ${MIN_BUDGET} and ${(DAILY_LIMIT - reserve).toLocaleString("en-US")} (the rest is reserved for automatic refreshes)`,
    );
  }
  await env.QUOTA.put("settings", JSON.stringify({ budget, reserve }));
  return quotaStatus(env);
}

// ---------- /channel-shorts: preview any channel ----------
interface MiniShort {
  id: string;
  t: string;
  p: number;
  v: number;
  l: number;
  c: number;
}
const PREVIEW_TTL = 24 * 3600;
const PREVIEW_PAGES = 4; // up to 200 newest Shorts
const PREVIEW_COST_ESTIMATE = 10;

function isoSeconds(d: string) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? "");
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

async function videoStats(env: Env, ids: string[], used: { units: number }) {
  const out: (MiniShort & { chId: string; dur: number })[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await yt(
      env,
      "videos",
      { part: "snippet,statistics,contentDetails,status", id: ids.slice(i, i + 50).join(","), maxResults: 50 },
      used,
    );
    for (const it of j?.items ?? []) {
      if (it.status?.embeddable === false || it.status?.privacyStatus === "private") continue;
      out.push({
        id: it.id,
        t: it.snippet?.title ?? "",
        p: Math.floor(Date.parse(it.snippet?.publishedAt) / 1000) || 0,
        v: Number(it.statistics?.viewCount ?? 0),
        l: Number(it.statistics?.likeCount ?? 0),
        c: Number(it.statistics?.commentCount ?? 0),
        chId: it.snippet?.channelId ?? "",
        dur: isoSeconds(it.contentDetails?.duration),
      });
    }
  }
  return out;
}

async function channelShorts(req: Request, env: Env) {
  const body = (await req.json().catch(() => ({}))) as { id?: string; force?: boolean };
  const id = String(body.id ?? "");
  if (!/^UC[\w-]{22}$/.test(id)) throw new HttpError(400, "Invalid channel ID");
  const key = `ch:${id}`;
  if (!body.force) {
    const hit = (await env.QUOTA?.get(key, "json")) as any;
    if (hit) {
      await bump(env, "saved", hit.units ?? PREVIEW_COST_ESTIMATE);
      return { ...hit, units: 0, cached: true };
    }
  }
  await guard(env, PREVIEW_COST_ESTIMATE);
  const used = { units: 0 };
  try {
    const [info] = await channelInfo(env, [id], used);
    if (!info) throw new HttpError(404, "Channel not found");
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < PREVIEW_PAGES; page++) {
      const p = await yt(
        env,
        "playlistItems",
        {
          part: "contentDetails",
          playlistId: `UUSH${id.slice(2)}`,
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        },
        used,
      );
      if (!p) break;
      for (const it of p.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
      pageToken = p.nextPageToken;
      if (!pageToken) break;
    }
    const shorts: MiniShort[] = (await videoStats(env, ids, used)).map(({ chId, dur, ...s }) => s);
    const result = { channel: info, shorts, units: used.units, fetchedAt: Math.floor(Date.now() / 1000) };
    await env.QUOTA?.put(key, JSON.stringify(result), { expirationTtl: PREVIEW_TTL });
    return { ...result, cached: false, quota: await addUsed(env, used.units) };
  } catch (e) {
    await addUsed(env, used.units);
    throw e;
  }
}

// ---------- /search-shorts: find similar Shorts on YouTube ----------
interface SearchIndexEntry {
  q: string;
  norm: string;
  at: number;
  n: number;
}
const SEARCH_TTL = 7 * 24 * 3600;
const SEARCH_COST_ESTIMATE = 103;
const MAX_SHORT_SECONDS = 180;

const normQuery = (q: string) =>
  [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{M}\p{N}#]+/u)
        .filter((w) => w.length > 1),
    ),
  ]
    .sort()
    .join(" ");

async function searchShorts(req: Request, env: Env) {
  const body = (await req.json().catch(() => ({}))) as { q?: string; force?: boolean };
  const q = String(body.q ?? "")
    .trim()
    .slice(0, 120);
  const norm = normQuery(q);
  if (!norm) throw new HttpError(400, "Type some search words");
  const key = `q:${norm}`;
  if (!body.force) {
    const hit = (await env.QUOTA?.get(key, "json")) as any;
    if (hit) {
      await bump(env, "saved", hit.units ?? SEARCH_COST_ESTIMATE);
      return { ...hit, units: 0, cached: true };
    }
  }
  await guard(env, SEARCH_COST_ESTIMATE);
  const used = { units: 0 };
  try {
    const s = await yt(
      env,
      "search",
      {
        part: "snippet",
        type: "video",
        videoDuration: "short",
        q,
        maxResults: 25,
        safeSearch: "moderate",
      },
      used,
    );
    const ids: string[] = (s?.items ?? []).map((it: any) => it.id?.videoId).filter(Boolean);
    const vids = (await videoStats(env, ids, used)).filter((v) => v.dur > 0 && v.dur <= MAX_SHORT_SECONDS);
    const chIds = [...new Set(vids.map((v) => v.chId))].slice(0, 50);
    const chs = new Map<string, any>();
    if (chIds.length) {
      const j = await yt(env, "channels", { part: "snippet,statistics", id: chIds.join(","), maxResults: 50 }, used);
      for (const it of j?.items ?? []) {
        const cu: string | undefined = it.snippet?.customUrl;
        chs.set(it.id, {
          id: it.id,
          name: it.snippet?.title ?? "",
          thumb: it.snippet?.thumbnails?.default?.url ?? "",
          handle: cu ? (cu.startsWith("@") ? cu : `@${cu}`) : it.id,
          subs: Number(it.statistics?.subscriberCount ?? 0),
          ...suggested(suggestCats(it.snippet?.title ?? "", it.snippet?.description ?? "")),
        });
      }
    }
    const results = vids.map(({ chId, dur, ...v }) => ({
      ...v,
      ch: chs.get(chId) ?? { id: chId, name: "", thumb: "", handle: chId, subs: 0, ...suggested(["marketing"]) },
    }));
    const result = { q, results, units: used.units, fetchedAt: Math.floor(Date.now() / 1000) };
    await env.QUOTA?.put(key, JSON.stringify(result), { expirationTtl: SEARCH_TTL });
    const index = ((await env.QUOTA?.get("q:index", "json")) ?? []) as SearchIndexEntry[];
    const entry = { q, norm, at: result.fetchedAt, n: results.length };
    await env.QUOTA?.put("q:index", JSON.stringify([entry, ...index.filter((x) => x.norm !== norm)].slice(0, 50)));
    return { ...result, cached: false, quota: await addUsed(env, used.units) };
  } catch (e) {
    await addUsed(env, used.units);
    throw e;
  }
}

// ---------- /refresh, /status (GitHub Actions) ----------
async function refresh(env: Env) {
  const r = await gh(env, `/repos/${env.CODE_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main" }),
  });
  if (!r.ok) throw new HttpError(502, await githubError(r, "starting the refresh workflow (needs Actions: Read and write)"));
  return { ok: true };
}

async function runStatus(env: Env) {
  const r = await gh(env, `/repos/${env.CODE_REPO}/actions/workflows/${env.WORKFLOW_FILE}/runs?per_page=1`);
  if (!r.ok) throw new HttpError(502, await githubError(r, "reading workflow runs (needs Actions: Read)"));
  const run = ((await r.json()) as any).workflow_runs?.[0];
  if (!run) return { run: null };
  return {
    run: {
      status: run.status, // queued | in_progress | completed
      conclusion: run.conclusion, // success | failure | cancelled | null
      event: run.event, // schedule | push | workflow_dispatch
      startedAt: Math.floor(Date.parse(run.run_started_at ?? run.created_at) / 1000),
      url: run.html_url,
    },
  };
}
