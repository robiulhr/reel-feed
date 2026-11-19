/**
 * Reel Feed sync server (Cloudflare Worker).
 *
 * Holds the GitHub token as a secret and reads/writes user-state.json in the private data repo.
 * Devices log in once with APP_PASSWORD and get a signed session; they never see the GitHub token.
 *
 * Secrets (set with `npx wrangler secret put NAME`):
 *   GITHUB_TOKEN    fine-grained token: Contents read/write on the data repo only
 *   APP_PASSWORD    the password you type on each device
 *   SESSION_SECRET  random string used to sign sessions
 * Changing APP_PASSWORD or SESSION_SECRET logs out every device.
 */

export interface Env {
  GITHUB_TOKEN: string;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  DATA_REPO: string; // "owner/repo"
  ALLOWED_ORIGINS: string; // comma-separated, e.g. "https://ecomgy.github.io"
  GITHUB_API?: string; // only for local testing; defaults to https://api.github.com
}

const FILE_PATH = "user-state.json";
const SESSION_DAYS = 180;
const enc = new TextEncoder();

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req.headers.get("Origin") ?? "", env);
    if (!cors) return json({ error: "Origin not allowed" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    try {
      if (url.pathname === "/login" && req.method === "POST") return await login(req, env, cors);

      if (!(await verifySession(req.headers.get("Authorization"), env))) {
        return json({ error: "Please log in again" }, 401, cors);
      }
      if (url.pathname === "/state" && req.method === "GET") return await getState(env, cors);
      if (url.pathname === "/state" && req.method === "PUT") return await putState(req, env, cors);
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Server error" }, 500, cors);
    }
  },
};

// ---------- CORS ----------
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/;

function corsHeaders(origin: string, env: Env): Record<string, string> | null {
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

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
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

async function login(req: Request, env: Env, cors: Record<string, string>) {
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

async function githubError(r: Response) {
  if (r.status === 401) return "GitHub token is invalid or expired (update GITHUB_TOKEN)";
  if (r.status === 403) return "GitHub token lacks permission (needs Contents: Read and write)";
  if (r.status === 404) return "Data repo not found, or the token can't access it";
  const j = (await r.json().catch(() => ({}))) as { message?: string };
  return `GitHub error ${r.status}: ${j.message ?? "unknown"}`;
}

async function getState(env: Env, cors: Record<string, string>) {
  const r = await gh(env, `/repos/${env.DATA_REPO}/contents/${FILE_PATH}`);
  if (r.status === 404) {
    // Distinguish "file not created yet" from "repo not reachable"
    const repo = await gh(env, `/repos/${env.DATA_REPO}`);
    if (!repo.ok) return json({ error: await githubError(repo) }, 502, cors);
    return json({ data: null, sha: null }, 200, cors);
  }
  if (!r.ok) return json({ error: await githubError(r) }, 502, cors);
  const j = (await r.json()) as { content?: string; sha: string };
  let content = j.content;
  if (!content) {
    // files over 1 MB come back without content — read the blob instead
    const b = await gh(env, `/repos/${env.DATA_REPO}/git/blobs/${j.sha}`);
    if (!b.ok) return json({ error: await githubError(b) }, 502, cors);
    content = ((await b.json()) as { content: string }).content;
  }
  return json({ data: JSON.parse(b64decode(content)), sha: j.sha }, 200, cors);
}

async function putState(req: Request, env: Env, cors: Record<string, string>) {
  const body = (await req.json()) as { data?: unknown; sha?: string | null; message?: string };
  if (!body.data || typeof body.data !== "object") return json({ error: "Missing data" }, 400, cors);
  const text = JSON.stringify(body.data);
  if (text.length > 5_000_000) return json({ error: "Data too large" }, 413, cors);

  const r = await gh(env, `/repos/${env.DATA_REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: String(body.message ?? "Sync").slice(0, 200),
      content: b64encode(text),
      ...(body.sha ? { sha: body.sha } : {}),
    }),
  });
  // 409 / 422 = another device saved first; the app re-reads and merges
  if (r.status === 409 || r.status === 422) return json({ error: "conflict" }, 409, cors);
  if (!r.ok) return json({ error: await githubError(r) }, 502, cors);
  const j = (await r.json()) as { content: { sha: string } };
  return json({ sha: j.content.sha }, 200, cors);
}
