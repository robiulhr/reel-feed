/**
 * The app's own Worker ("reel-feed", config in app.wrangler.toml): serves the built app (dist/) and
 * passes /api/* to the sync Worker ("reel-feed-sync") over a service binding — same address for the
 * app and its sync, so no cross-site requests.
 *
 * The whole site is private (worker/src/gate.ts): every request runs this code first and, without the
 * password's cookie, gets only a login page. Unknown paths get index.html (single-page app) once signed in.
 *
 * Link previews: when WhatsApp, Facebook, Telegram, … fetch a shared /v/VIDEO_ID link, the page they
 * get carries that Short's title, channel and thumbnail (from YouTube's free oEmbed — no key, no
 * quota). Signed-in people opening the link get the app; anyone else is sent to the Short on YouTube.
 *
 * /api/fb/* is answered here (worker/src/fb.ts): looking up Facebook videos you add by link.
 */
import { handleFb } from "./fb";
import { gateLogin, gateLogout, isSignedIn, loginPage, wantsPage } from "./gate";

export interface AppEnv {
  ASSETS: Fetcher;
  SYNC: Fetcher;
}

const VIDEO_PATH = /^\/v\/([\w-]{6,20})\/?$/;
/** Files a browser fetches without the cookie, or that hold nothing private (install icon and manifest). */
const OPEN_FILES = new Set(["/manifest.webmanifest", "/icon.svg"]);

export default {
  async fetch(req: Request, env: AppEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/gate/login" && req.method === "POST") return gateLogin(req, url, env);
    if (url.pathname === "/gate/logout" && req.method === "POST") return gateLogout();
    const video = VIDEO_PATH.exec(url.pathname)?.[1];
    if (!(await isSignedIn(req, url, env))) {
      if (video && req.method === "GET") {
        // a shared Short: preview cards for chat apps; people without the password go to YouTube
        if (isPreviewBot(req.headers.get("User-Agent") ?? "")) return preview(video, url, env);
        // a Facebook video you added (fb + its number) goes to Facebook, a Short to YouTube
        const fb = /^fb(\d{6,25})$/.exec(video)?.[1];
        return Response.redirect(fb ? `https://www.facebook.com/reel/${fb}/` : `https://www.youtube.com/shorts/${video}`, 302);
      }
      if (OPEN_FILES.has(url.pathname)) return env.ASSETS.fetch(req);
      if (wantsPage(req, url)) return loginPage();
      return Response.json({ error: "Please sign in" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname.startsWith("/api/fb/")) return handleFb(req, url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return toSync(req, url, env);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<AppEnv>;

function toSync(req: Request, url: URL, env: AppEnv) {
  const target = new URL(url.pathname.slice(4) || "/", "https://sync.internal");
  target.search = url.search;
  const headers = new Headers(req.headers);
  // Browsers leave out Origin on same-site GETs; the sync Worker only answers known sites, so say
  // where the request comes from. A request from another site keeps its own Origin (and is refused).
  if (!headers.has("Origin")) headers.set("Origin", url.origin);
  return env.SYNC.fetch(new Request(target, { method: req.method, headers, body: req.body, redirect: "manual" }));
}

// ---------- link previews ----------
/** Apps that fetch a link to draw its preview card (they don't run the app's JavaScript). */
const BOTS =
  /facebookexternalhit|facebot|meta-externalagent|whatsapp|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|viber|pinterest|redditbot|embedly|iframely|vkshare|snapchat|bingpreview|googlebot|applebot|line\/|kakaotalk|mastodon|cardyb/i;
export const isPreviewBot = (ua: string) => BOTS.test(ua);

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The <head> tags a preview card is drawn from. */
export function previewTags(v: VideoInfo, pageUrl: string): string {
  const title = v.title || "A Short on Ecomgy Reel Feed";
  const desc = v.channel ? `${v.channel} · Ecomgy Reel Feed` : "Ecomgy Reel Feed — Shorts from business channels";
  const img = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`; // 480×360, always exists
  const m = (attr: "property" | "name", key: string, value: string) => `<meta ${attr}="${key}" content="${esc(value)}" />`;
  return [
    m("property", "og:type", "video.other"),
    m("property", "og:site_name", "Ecomgy Reel Feed"),
    m("property", "og:title", title),
    m("property", "og:description", desc),
    m("property", "og:url", pageUrl),
    m("property", "og:image", img),
    m("property", "og:image:width", "480"),
    m("property", "og:image:height", "360"),
    m("property", "og:image:alt", title),
    m("name", "twitter:card", "summary_large_image"),
    m("name", "twitter:title", title),
    m("name", "twitter:description", desc),
    m("name", "twitter:image", img),
    m("name", "description", desc),
  ].join("\n    ");
}

/** The app's page with this Short's preview tags (replacing the general ones). */
export function withPreview(html: string, v: VideoInfo, pageUrl: string): string {
  const cleaned = html
    .replace(/\s*<meta\s+(?:property="og:[^"]*"|name="(?:twitter:[^"]*|description)")[^>]*>/g, "")
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(v.title || "Ecomgy Reel Feed")}</title>`);
  return cleaned.replace("</head>", `    ${previewTags(v, pageUrl)}\n  </head>`);
}

/** Title + channel from YouTube oEmbed. Empty if the Short is gone or YouTube is slow. */
export async function videoInfo(id: string): Promise<VideoInfo> {
  try {
    const u = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/shorts/${id}`)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { id, title: "", channel: "" };
    const j = (await r.json()) as { title?: string; author_name?: string };
    return { id, title: (j.title ?? "").slice(0, 200), channel: (j.author_name ?? "").slice(0, 100) };
  } catch {
    return { id, title: "", channel: "" };
  }
}

async function preview(id: string, url: URL, env: AppEnv): Promise<Response> {
  const [page, info] = await Promise.all([env.ASSETS.fetch(new Request(new URL("/", url))), videoInfo(id)]);
  if (!page.ok) return page;
  const html = withPreview(await page.text(), info, `${url.origin}/v/${id}`);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
