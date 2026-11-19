/**
 * Reel Feed sync server (Cloudflare Worker).
 *
 * - Login with APP_PASSWORD → signed 180-day session. Devices never see any token.
 * - /state           read/write user-state.json in the private data repo (saves, history, learning)
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
}

type Cors = Record<string, string>;
const STATE_FILE = "user-state.json";
const CHANNELS_FILE = "channels.json";
const SESSION_DAYS = 180;
const CATS = ["bangla", "ads", "stories", "founders", "books", "ai"] as const;
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
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
      switch (route) {
        case "GET /state": return json(await readJsonFile(env, env.DATA_REPO, STATE_FILE), 200, cors);
        case "PUT /state": return await putState(req, env, cors);
        case "GET /channels": return json(await readJsonFile(env, env.CODE_REPO, CHANNELS_FILE), 200, cors);
        case "POST /channels": return await editChannels(req, env, cors);
        case "POST /lookup": return json(await lookup(req, env), 200, cors);
        case "POST /refresh": return json(await refresh(env), 200, cors);
        case "GET /status": return json(await runStatus(env), 200, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      return json({ error: e instanceof Error ? e.message : "Server error" }, 500, cors);
    }
  },
};

// ---------- CORS ----------
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/;

function corsHeaders(origin: string, env: Env): Cors | null {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !(allowed.includes(origin) || DEV_ORIGIN.test(origin))) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status = 200, headers: Cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
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
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(env: Env, data: string) {
  // Key includes the password, so changing the password invalidates every session.
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(`${env.SESSION_SECRET}:${env.APP_PASSWORD}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function login(req: Request, env: Env, cors: Cors) {
  const body = (await req.json().catch(() => ({}))) as { password?: string };
  const ok = sameBytes(await sha256(String(body.password ?? "")), await sha256(env.APP_PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800)); // slows down guessing
    return json({ error: "Wrong password" }, 401, cors);
  }
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
function gh(env: Env, path: string, init: RequestInit = {}) {
  return fetch(`${env.GITHUB_API ?? "https://api.github.com"}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "reel-feed-sync",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

function b64encode(text: string) {
  const bytes = enc.encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64decode = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function githubError(r: Response, what: string) {
  if (r.status === 401) return "GitHub token is invalid or expired (update GITHUB_TOKEN)";
  if (r.status === 403) return `GitHub token lacks permission for ${what}`;
  if (r.status === 404) return `${what} not found, or the token can't access it`;
  const j = (await r.json().catch(() => ({}))) as { message?: string };
  return `GitHub error ${r.status}: ${j.message ?? "unknown"}`;
}

/** Reads a JSON file from a repo. Returns { data: null, sha: null } if it doesn't exist yet. */
async function readJsonFile(env: Env, repo: string, path: string): Promise<{ data: any; sha: string | null }> {
  const r = await gh(env, `/repos/${repo}/contents/${path}`);
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

/** Writes a file. Returns the new sha, or null if someone else changed it first (conflict). */
async function writeFile(env: Env, repo: string, path: string, text: string, sha: string | null, message: string) {
  const r = await gh(env, `/repos/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message: message.slice(0, 200), content: b64encode(text), ...(sha ? { sha } : {}) }),
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

// ---------- /channels ----------
interface ChannelEntry {
  name: string; handle: string; cat: string; id?: string;
  status?: "removed"; addedAt?: string; removedAt?: string;
}
type ChannelOp =
  | { t: "add"; channel: { name: string; handle: string; id?: string; cat: string } }
  | { t: "remove"; h: string }
  | { t: "restore"; h: string }
  | { t: "delete"; h: string }
  | { t: "cat"; h: string; cat: string };

const sameHandle = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function applyChannelOp(list: ChannelEntry[], op: ChannelOp): string {
  const find = (h: string) => {
    const c = list.find((x) => sameHandle(x.handle, h));
    if (!c) throw new HttpError(404, `${h} is not in the channel list`);
    return c;
  };
  const checkCat = (cat: string) => {
    if (!(CATS as readonly string[]).includes(cat)) throw new HttpError(400, `Unknown category "${cat}"`);
  };
  const now = new Date().toISOString();
  switch (op.t) {
    case "add": {
      const { name, handle, id, cat } = op.channel ?? ({} as any);
      if (!/^(@[\w.\-·]{2,100}|UC[\w-]{22})$/.test(String(handle))) throw new HttpError(400, "Invalid channel handle");
      if (!name || String(name).length > 120) throw new HttpError(400, "Invalid channel name");
      if (id && !/^UC[\w-]{22}$/.test(id)) throw new HttpError(400, "Invalid channel ID");
      checkCat(cat);
      const existing = list.find((x) => sameHandle(x.handle, handle) || (id && x.id === id));
      if (existing && existing.status !== "removed") throw new HttpError(409, `${existing.name} is already in the list`);
      if (existing) {
        delete existing.status; delete existing.removedAt;
        existing.cat = cat;
        if (id) existing.id = id;
        return `restore ${existing.handle}`;
      }
      list.push({ name: String(name), handle, ...(id ? { id } : {}), cat, addedAt: now });
      return `add ${handle}`;
    }
    case "remove": {
      const c = find(op.h);
      c.status = "removed"; c.removedAt = now;
      return `remove ${c.handle}`;
    }
    case "restore": {
      const c = find(op.h);
      delete c.status; delete c.removedAt;
      return `restore ${c.handle}`;
    }
    case "delete": {
      const c = find(op.h);
      if (c.status !== "removed") throw new HttpError(400, "Remove the channel first; delete is only for removed channels");
      list.splice(list.indexOf(c), 1);
      return `delete ${c.handle}`;
    }
    case "cat": {
      checkCat(op.cat);
      const c = find(op.h);
      c.cat = op.cat;
      return `category ${c.handle} → ${op.cat}`;
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
    const sha = await writeFile(env, env.CODE_REPO, CHANNELS_FILE, formatChannels(list), file.sha,
      `Channels (from app): ${notes.join("; ")}`);
    if (sha) return json({ data: list, sha }, 200, cors);
  }
  return json({ error: "The channel list kept changing — try again" }, 409, cors);
}

// ---------- /lookup (YouTube) ----------
interface ChannelInfo {
  id: string; name: string; handle: string; thumb: string; subs: number; videos: number;
  desc: string; shorts: number; latestShort: number; suggestedCat: string;
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
    } catch { /* fall through */ }
  }
  if (q.startsWith("@")) return { kind: "handle", v: q };
  if (/^UC[\w-]{22}$/.test(q)) return { kind: "id", v: q };
  if (/^[\w.-]{3,100}$/.test(q)) return { kind: "handle", v: `@${q}` }; // single word → try as a handle
  return { kind: "text", v: q };
}

const BENGALI = /[ঀ-৿]/;
function suggestCat(text: string) {
  const t = text.toLowerCase();
  if (BENGALI.test(text) || /bangla|bangladesh|বাংলা/.test(t)) return "bangla";
  if (/meta ads|facebook ads|google ads|media buy|ecom|e-commerce|shopify|dtc|dropship|performance market|paid ads/.test(t)) return "ads";
  if (/podcast|founder|ceo|entrepreneur|mindset|motivation/.test(t)) return "founders";
  if (/book|summar|invest|stock|finance|money|wealth/.test(t)) return "books";
  if (/\bai\b|artificial intelligence|design|brand|graphic|creative|productivity/.test(t)) return "ai";
  return "stories";
}

async function channelInfo(env: Env, ids: string[], used: { units: number }): Promise<ChannelInfo[]> {
  if (!ids.length) return [];
  const j = await yt(env, "channels", { part: "snippet,statistics", id: ids.join(","), maxResults: 50 }, used);
  const items: any[] = j?.items ?? [];
  return Promise.all(items.map(async (it) => {
    // Shorts-only playlist: total count + newest Short (1 unit)
    const p = await yt(env, "playlistItems", { part: "contentDetails", playlistId: "UUSH" + it.id.slice(2), maxResults: 1 }, used);
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
        ? Math.floor(Date.parse(p.items[0].contentDetails.videoPublishedAt) / 1000) : 0,
      suggestedCat: suggestCat(`${name} ${desc}`),
    };
  }));
}

async function lookup(req: Request, env: Env) {
  const body = (await req.json().catch(() => ({}))) as { q?: string; search?: boolean };
  const raw = String(body.q ?? "").slice(0, 300);
  if (!raw.trim()) throw new HttpError(400, "Type a handle, link or name");
  const used = { units: 0 };
  const q = parseQuery(raw);
  let ids: string[] = [];

  if (body.search) {
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
  } else {
    return { results: [], units: 0, needsSearch: true };
  }
  const results = await channelInfo(env, ids, used);
  return { results, units: used.units, needsSearch: false };
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
