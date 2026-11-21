/**
 * Runs the real Worker code (worker/src/index.ts) in-process with:
 *  - an in-memory stand-in for Cloudflare KV,
 *  - fake GitHub (contents API with sha checks, workflow dispatch/runs),
 *  - fake YouTube Data API.
 * No network, no secrets.
 */
import { vi } from "vitest";
import worker, { type Env } from "../../worker/src/index";

export const ORIGIN = "https://app.test";

export function memKV() {
  const m = new Map<string, string>();
  return {
    map: m,
    async get(key: string, type?: string) {
      const v = m.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
  };
}

export interface Fake {
  env: Env;
  kv: ReturnType<typeof memKV>;
  files: Map<string, { content: string; sha: string }>;
  calls: string[];
  ghWrites: () => number;
  ytUnits: () => number;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
export const TOKEN_EXPIRY = "2027-11-20 00:00:00 UTC";
const json = (status: number, body?: unknown) =>
  new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
    status,
    // like GitHub: every response tells when the fine-grained token expires
    headers: { "Content-Type": "application/json", "github-authentication-token-expiration": TOKEN_EXPIRY },
  });

const CH = {
  UCpricing00000000000000a: { title: "Pricing Lab", customUrl: "@pricinglab", desc: "Pricing psychology and ecommerce offers" },
  UCbangla000000000000000a: { title: "দোকানের গল্প", customUrl: "@দোকানেরগল্প", desc: "বাংলা ব্যবসার গল্প" },
} as Record<string, { title: string; customUrl: string; desc: string }>;

export function setup(initialChannels: unknown[] = [{ name: "Hook", handle: "@hook", cat: "stories" }]): Fake {
  const kv = memKV();
  const files = new Map<string, { content: string; sha: string }>();
  files.set("me/code/channels.json", { content: b64(JSON.stringify(initialChannels)), sha: "sha0" });
  const calls: string[] = [];
  let shaN = 1;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.host}${url.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (url.host === "gh.test") {
      const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
      if (m) {
        const key = `${m[1]}/${m[2]}`;
        const f = files.get(key);
        if (method === "GET") return f ? json(200, f) : json(404, { message: "Not Found" });
        if (f && body.sha !== f.sha) return json(409, { message: "sha mismatch" });
        if (!f && body.sha) return json(422, { message: "sha for new file" });
        const nf = { content: body.content, sha: `sha${shaN++}` };
        files.set(key, nf);
        return json(200, { content: { sha: nf.sha } });
      }
      if (url.pathname.endsWith("/dispatches")) return json(204);
      if (url.pathname.endsWith("/runs"))
        return json(200, {
          workflow_runs: [
            { status: "completed", conclusion: "success", event: "push", created_at: new Date().toISOString(), html_url: "x" },
          ],
        });
      if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return json(200, { private: true });
      return json(404, {});
    }

    if (url.host === "yt.test") {
      const p = url.pathname;
      if (p.endsWith("/channels")) {
        if (url.searchParams.get("forHandle"))
          return json(
            200,
            url.searchParams.get("forHandle")!.toLowerCase() === "@pricinglab" ? { items: [{ id: "UCpricing00000000000000a" }] } : {},
          );
        const ids = (url.searchParams.get("id") ?? "").split(",").filter((i) => CH[i]);
        return json(200, {
          items: ids.map((id) => ({
            id,
            snippet: { title: CH[id].title, customUrl: CH[id].customUrl, description: CH[id].desc, thumbnails: { default: { url: "" } } },
            statistics: { subscriberCount: "1000", videoCount: "50" },
          })),
        });
      }
      if (p.endsWith("/playlistItems")) {
        if (url.searchParams.get("maxResults") === "1")
          return json(200, {
            pageInfo: { totalResults: 12 },
            items: [{ contentDetails: { videoId: "aaaaaaaaaaa", videoPublishedAt: new Date().toISOString() } }],
          });
        return json(200, {
          items: Array.from({ length: 12 }, (_, i) => ({ contentDetails: { videoId: `short${String(i).padStart(6, "0")}` } })),
        });
      }
      if (p.endsWith("/search"))
        return json(200, { items: ["s1", "s2", "longvideo"].map((v) => ({ id: { videoId: v.padEnd(11, "x") } })) });
      if (p.endsWith("/videos")) {
        const ids = (url.searchParams.get("id") ?? "").split(",");
        return json(200, {
          items: ids.map((id, k) => ({
            id,
            snippet: {
              title: `Video ${k}`,
              publishedAt: new Date().toISOString(),
              channelId: k % 2 ? "UCbangla000000000000000a" : "UCpricing00000000000000a",
            },
            statistics: { viewCount: "1000", likeCount: "10", commentCount: "1" },
            contentDetails: { duration: id.startsWith("long") ? "PT10M" : "PT40S" },
            status: { embeddable: true, privacyStatus: "public" },
          })),
        });
      }
      return json(404, {});
    }
    throw new Error(`Unexpected request in test: ${url.href}`);
  });

  const env = {
    GITHUB_TOKEN: "test",
    APP_PASSWORD: "correct horse",
    SESSION_SECRET: "secret",
    YOUTUBE_API_KEY: "key",
    DATA_REPO: "me/data",
    CODE_REPO: "me/code",
    WORKFLOW_FILE: "deploy.yml",
    ALLOWED_ORIGINS: ORIGIN,
    GITHUB_API: "http://gh.test",
    YOUTUBE_API: "http://yt.test",
    QUOTA: kv as unknown as KVNamespace,
  } as Env;

  return {
    env,
    kv,
    files,
    calls,
    ghWrites: () => calls.filter((c) => c.startsWith("PUT gh.test")).length,
    ytUnits: () => calls.filter((c) => c.includes("yt.test")).reduce((s, c) => s + (c.endsWith("/search") ? 100 : 1), 0),
  };
}

export async function call(
  f: Fake,
  method: string,
  path: string,
  opts: { body?: unknown; session?: string; origin?: string; rid?: string; ip?: string } = {},
) {
  const headers: Record<string, string> = { Origin: opts.origin ?? ORIGIN, "CF-Connecting-IP": opts.ip ?? "1.2.3.4" };
  if (opts.session) headers.Authorization = `Bearer ${opts.session}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.rid) headers["X-Request-Id"] = opts.rid;
  const res = await worker.fetch(
    new Request(`https://w.test${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    f.env,
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

export async function login(f: Fake) {
  const r = await call(f, "POST", "/login", { body: { password: "correct horse" } });
  return r.body.session as string;
}

export function channelsOnGitHub(f: Fake): any[] {
  return JSON.parse(Buffer.from(f.files.get("me/code/channels.json")!.content, "base64").toString("utf8"));
}
