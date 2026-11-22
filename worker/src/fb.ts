/**
 * Facebook video lookups for videos you add by link (the app's "Add a Facebook video").
 *
 *   GET /api/fb/meta?url=LINK   → { id, url, title, caption, views, reactions, page: { name, path }, embeddable }
 *   GET /api/fb/thumb/VIDEO_ID  → a redirect to the video's current thumbnail (Facebook's image links
 *                                  expire after a few weeks, so the app never stores them)
 *   GET /api/fb/page?url=LINK   → { name, path, followers, about } of a Facebook page or profile
 *   GET /api/fb/pagepic?path=/x → a redirect to that page's current profile picture
 *
 * Everything comes from Facebook's public pages — no key, no login: the link's redirect gives the
 * video, the video's page gives caption + thumbnail (its preview tags), the public embed page gives
 * the page name, and Facebook's oEmbed says whether it can be embedded. Requests say who we are
 * (no pretending to be a browser or another crawler). Only Facebook addresses are ever fetched.
 * Each part may fail on its own; whatever is missing the person types in.
 */

import { pickCats, textScores } from "../../src/classify";

const UA = "Mozilla/5.0 (compatible; ReelFeed/1.0; link preview)";
const FB_HOSTS = /^(?:(?:www|m|web|mbasic|business)\.)?(?:facebook\.com|fb\.com|fb\.watch)$/i;

export const isFbHost = (host: string) => FB_HOSTS.test(host);

/** The numeric video id in a Facebook video address, if it has one. */
export function videoIdOf(u: URL): string | null {
  const p = u.pathname;
  const id =
    /\/reels?\/(\d{6,25})/.exec(p)?.[1] ??
    /\/videos\/(?:[^/]+\/)*?(\d{6,25})(?:\/|$)/.exec(p)?.[1] ??
    (/^\/watch\/?$/.test(p) ? u.searchParams.get("v") : null);
  return id && /^\d{6,25}$/.test(id) ? id : null;
}

/** A clean address for the video (no tracking parameters). */
export function canonical(u: URL, id: string): string {
  if (/\/reels?\//.test(u.pathname)) return `https://www.facebook.com/reel/${id}/`;
  const page = /^\/([^/]+)\/videos\//.exec(u.pathname)?.[1];
  if (page && page !== "watch") return `https://www.facebook.com/${page}/videos/${id}/`;
  return `https://www.facebook.com/watch/?v=${id}`;
}

export function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const meta = (html: string, key: string) => {
  const m = new RegExp(`<meta\\s+(?:property|name)="${key}"\\s+content="([^"]*)"`, "i").exec(html);
  return m ? decode(m[1]) : "";
};

/** "21K" → 21000 */
export function count(s: string): number {
  const m = /^([\d.,]+)\s*([KMB]?)$/i.exec(s.trim());
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ""));
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] ?? 1));
}

export interface FbMeta {
  id: string;
  url: string;
  title: string;
  caption: string;
  views: number;
  reactions: number;
  page: { name: string; path: string } | null;
  embeddable: boolean;
  cats: string[]; // categories guessed from the title and caption (hashtags count), main first
}

/** The app's own category guess (the same words list the Shorts are sorted with). */
export const guessCats = (title: string, caption: string) => pickCats(textScores({ title, desc: caption }), {}).cats;

/** Reads what the video's own page says (its link preview tags). */
export function readVideoPage(html: string) {
  const ogTitle = meta(html, "og:title");
  const caption = meta(html, "og:description");
  // "21K views · 249 reactions | …" or "2.2K reactions · 112 shares | …"
  const stats = /^(?:[\d.,]+[KMB]? [a-z]+(?: · | \| ))+/i.exec(ogTitle);
  const stat = (word: RegExp) => count(new RegExp(`([\\d.,]+[KMB]?) ${word.source}`, "i").exec(stats?.[0] ?? "")?.[1] ?? "");
  let rest = stats ? ogTitle.slice(stats[0].length) : ogTitle;
  // short captions come back as "caption | Page name"
  const tail = caption && rest.startsWith(caption.trim()) ? rest.slice(caption.trim().length) : "";
  const pageFromTitle = /^\s*\| (.{1,80})$/.exec(tail)?.[1] ?? "";
  if (!caption) rest = rest.replace(/ \| [^|]{1,80}$/, "");
  return {
    caption: caption || rest,
    image: meta(html, "og:image"),
    url: meta(html, "og:url"),
    views: stat(/views?\b/),
    reactions: stat(/reactions?\b/),
    pageFromTitle,
  };
}

/** The page name + its address from Facebook's embed page ("MD Zahid Hasan", "/md.zahid.hasan.390411"). */
export function readEmbedPage(html: string): { name: string; path: string } | null {
  const m =
    /<a title="([^"]{1,120})" target="_blank" href="(?:https:\/\/(?:www|web)\.facebook\.com)?\/(?:watch\/)?([^/"?]+)\/?\?ref=embed_video"/.exec(
      html,
    );
  return m ? { name: decode(m[1]).trim(), path: `/${decode(m[2])}` } : null;
}

/** The page's address from the video's own address ("/omarfarukOfficial54/videos/…"). */
export function pagePathOf(videoUrl: string): string {
  try {
    const p = /^\/([^/]+)\/videos\//.exec(new URL(videoUrl).pathname)?.[1];
    return p && !["watch", "reel", "people", "profile.php"].includes(p) ? `/${decodeURIComponent(p)}` : "";
  } catch {
    return "";
  }
}

export interface FbPageMeta {
  name: string;
  path: string; // "/omarfarukOfficial54", "/people/Boost-Marketing/61595841376442"
  followers: number;
  about: string;
}

/** What a page's own address says: "Omar Faruk  | Dhaka", "… 18,022 followers · …", its picture. */
export function readPagePage(html: string): FbPageMeta & { image: string } {
  const desc = meta(html, "og:description");
  let path = "";
  try {
    path = decodeURIComponent(new URL(meta(html, "og:url")).pathname).replace(/\/$/, "");
  } catch {}
  return {
    name: meta(html, "og:title")
      .replace(/\s*\|[^|]*$/, "")
      .trim(),
    path,
    followers: count(/([\d.,]+[KMB]?) followers/i.exec(desc)?.[1] ?? ""),
    about: desc.replace(/^.*?talking about this\.\s*/i, "").slice(0, 300),
    image: meta(html, "og:image"),
  };
}

/** A page's own Facebook address, with its redirects followed (facebook.com only). */
export async function readPage(link: string): Promise<(FbPageMeta & { image: string }) | { error: string }> {
  let u: URL;
  try {
    const l = link.trim();
    u = new URL(l.startsWith("/") ? `https://www.facebook.com${l}` : l);
  } catch {
    return { error: "That isn't a link" };
  }
  if (u.protocol === "http:") u.protocol = "https:";
  for (let i = 0; i < 5; i++) {
    if (u.protocol !== "https:" || !isFbHost(u.hostname)) return { error: "Only Facebook page links" };
    const r = await get(u.href).catch(() => null);
    if (!r) return { error: "Facebook didn't answer — try again" };
    const loc = r.headers.get("Location");
    if (r.status >= 300 && r.status < 400 && loc) {
      u = new URL(loc, u);
      continue;
    }
    if (!r.ok) return { error: "Couldn't open that page — is it public?" };
    const p = readPagePage(await r.text());
    if (!p.name || /^(Facebook|Log in|Log into Facebook)$/i.test(p.name)) return { error: "Couldn't read that page — is it public?" };
    return { ...p, path: p.path || u.pathname.replace(/\/$/, "") };
  }
  return { error: "Too many redirects" };
}

/** First line of the caption without hashtags, as a short title. */
export function titleOf(caption: string): string {
  const line =
    caption
      .split(/\n/)
      .map((l) => l.replace(/#[\p{L}\p{N}_]+/gu, "").trim())
      .find((l) => l.length > 2) ?? "";
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

async function get(url: string, ms = 6000) {
  return fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.8" },
    redirect: "manual",
    signal: AbortSignal.timeout(ms),
  });
}

/** Follows a share link (share/v/…, fb.watch/…) to the video, never leaving Facebook. */
export async function resolve(link: URL): Promise<URL | null> {
  let u = link;
  for (let i = 0; i < 5; i++) {
    if (u.protocol !== "https:" || !isFbHost(u.hostname)) return null;
    if (videoIdOf(u)) return u;
    const r = await get(u.href);
    const loc = r.headers.get("Location");
    if (r.status < 300 || r.status >= 400 || !loc) return null;
    u = new URL(loc, u);
  }
  return null;
}

export async function lookup(link: string): Promise<FbMeta | { error: string }> {
  let start: URL;
  try {
    start = new URL(link.trim());
  } catch {
    return { error: "That isn't a link" };
  }
  if (start.protocol === "http:") start.protocol = "https:";
  if (!isFbHost(start.hostname)) return { error: "Only Facebook video links can be added" };
  const u = await resolve(start).catch(() => null);
  const id = u && videoIdOf(u);
  if (!u || !id) return { error: "Couldn't find a video at that link — is it public?" };
  const url = canonical(u, id);

  const [page, embed, oembed] = await Promise.all([
    get(url)
      .then(async (r) => (r.ok ? readVideoPage(await r.text()) : null))
      .catch(() => null),
    get(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`)
      .then(async (r) => (r.ok ? readEmbedPage(await r.text()) : null))
      .catch(() => null),
    get(`https://graph.facebook.com/oembed_video?url=${encodeURIComponent(url)}`, 4000)
      .then((r) => r.ok)
      .catch(() => null),
  ]);
  const caption = page?.caption ?? "";
  const title = titleOf(caption);
  return {
    id,
    url,
    title,
    caption: caption.slice(0, 2000),
    views: page?.views ?? 0,
    reactions: page?.reactions ?? 0,
    page: embed ?? (page?.pageFromTitle ? { name: page.pageFromTitle, path: pagePathOf(page.url || url) } : null),
    embeddable: oembed !== false,
    cats: caption ? guessCats(title, caption) : [],
  };
}

const json = (data: unknown, status = 200, maxAge = 0) =>
  Response.json(data, { status, headers: { "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store" } });

/** Handles /api/fb/*. */
export async function handleFb(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return json({ error: "GET only" }, 405);
  if (url.pathname === "/api/fb/meta") {
    const link = url.searchParams.get("url") ?? "";
    if (!link || link.length > 600) return json({ error: "Paste a Facebook video link" }, 400);
    const r = await lookup(link);
    return "error" in r ? json(r, 422) : json(r, 200, 600);
  }
  if (url.pathname === "/api/fb/page") {
    const link = url.searchParams.get("url") ?? "";
    if (!link || link.length > 600) return json({ error: "Paste a Facebook page link" }, 400);
    const r = await readPage(link);
    if ("error" in r) return json(r, 422);
    const { image: _image, ...out } = r;
    return json(out, 200, 3600);
  }
  if (url.pathname === "/api/fb/pagepic") {
    const path = url.searchParams.get("path") ?? "";
    const okPath = /^\/[\w.%-]+(?:\/[\w.%-]+){0,2}$/.test(path) || /^\/profile\.php\?id=\d{5,25}$/.test(path);
    const r = okPath ? await readPage(path) : null;
    const img = r && !("error" in r) ? r.image : "";
    if (!img || !/^https:\/\/[\w.-]+\.fbcdn\.net\//.test(img))
      return new Response("No picture", { status: 404, headers: { "Cache-Control": "public, max-age=3600" } });
    return new Response(null, { status: 302, headers: { Location: img, "Cache-Control": "public, max-age=21600" } });
  }
  const thumb = /^\/api\/fb\/thumb\/(\d{6,25})$/.exec(url.pathname)?.[1];
  if (thumb) {
    const r = await fetch(`https://www.facebook.com/reel/${thumb}/`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(6000),
    }).catch(() => null);
    const img = r?.ok && new URL(r.url).hostname.endsWith("facebook.com") ? readVideoPage(await r.text()).image : "";
    if (!img || !/^https:\/\/[\w.-]+\.fbcdn\.net\//.test(img))
      return new Response("No thumbnail", { status: 404, headers: { "Cache-Control": "public, max-age=600" } });
    return new Response(null, { status: 302, headers: { Location: img, "Cache-Control": "public, max-age=21600" } });
  }
  return json({ error: "Not found" }, 404);
}
