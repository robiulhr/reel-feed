/**
 * Facebook videos you added by link, as Shorts: they join the library (and so every feed, list,
 * Saved, history…) with the id "fb" + Facebook's video number. Their page is either one of your
 * YouTube channels (when you linked it) or a channel of its own (st "fb", handle "fb:…").
 */
import { BASE } from "./router";
import { fbShortId, type FbPage, type ManualVideo, type Shared } from "./store";
import type { Channel, Dataset, Short } from "./types";

/** Thumbnail of an added Facebook video (fetched fresh by the app's server: Facebook's image links expire). */
export const fbThumbUrl = (shortId: string) => `${BASE}api/fb/thumb/${shortId.slice(2)}`;

/** A Facebook page's address (or a search for its name when it isn't known). */
export const pageHref = (p: Pick<FbPage, "url" | "name">) =>
  p.url || `https://www.facebook.com/search/pages/?q=${encodeURIComponent(p.name)}`;

/** "fb:md.zahid.hasan.390411" from a Facebook address or path; "fb:name" when there's only a name. */
export function pageKey(name: string, path = ""): string {
  const slug = path
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^profile\.php\?id=/, "")
    .split(/[/?#]/)[0];
  return `fb:${(slug || name.trim()).toLowerCase()}`;
}

export const fallbackTitle = (m: Pick<ManualVideo, "at">) =>
  `Facebook video · ${new Date(m.at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;

/** Index of the channel an added video belongs to (adds the Facebook page as a channel when needed). */
function channelFor(ds: Dataset, pages: FbPage[], key: string): number {
  const page = pages.find((p) => p.key === key);
  if (page?.ch) {
    const h = page.ch.toLowerCase();
    const i = ds.channels.findIndex((c) => c.st !== "fb" && c.st !== "external" && c.h.toLowerCase() === h);
    if (i >= 0) return i;
  }
  const h = key || "fb:";
  const n = page?.name || (key ? key.slice(3) : "Facebook");
  let i = ds.channels.findIndex((c) => c.st === "fb" && c.h === h);
  if (i < 0) {
    const ch: Channel = { h, n, cats: [], mix: [], bn: /[ঀ-৿]/.test(n), subs: 0, thumb: "", id: "", st: "fb", cnt: 0, last: 0 };
    i = ds.channels.push(ch) - 1;
  } else ds.channels[i].n = n;
  return i;
}

/** Puts your added Facebook videos into the library, replacing the copies from before. */
export function applyManual(ds: Dataset, st: Pick<Shared, "manual" | "fbPages">): Short[] {
  ds.videos = ds.videos.filter((v) => !v.fb);
  const shorts: Short[] = st.manual.map((m) => ({
    id: fbShortId(m.id),
    ch: channelFor(ds, st.fbPages, m.by),
    t: m.t || fallbackTitle(m),
    p: m.at,
    v: m.v,
    l: m.l,
    c: 0,
    o: 0.5,
    e: 0.5,
    tr: 0.5,
    r: 0.8,
    k: m.cats,
    lg: m.lg,
    g: false,
    fb: { url: m.url, note: m.note, lists: m.lists, by: m.by },
  }));
  ds.videos.push(...shorts);
  return shorts;
}

/** The Facebook page of a Short (its own page, or the page linked to its YouTube channel). */
export function fbPageOf(st: Pick<Shared, "fbPages">, s: Short, chHandle: string): FbPage | undefined {
  if (s.fb?.by) return st.fbPages.find((p) => p.key === s.fb!.by);
  const h = chHandle.toLowerCase();
  return st.fbPages.find((p) => p.ch && p.ch.toLowerCase() === h);
}

/** The video number in a Facebook link that already has one (reel, videos, watch) — no lookup needed. */
export function fbIdFromLink(link: string): string | null {
  try {
    const u = new URL(link.trim());
    if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(u.hostname)) return null;
    const id =
      /\/reels?\/(\d{6,25})/.exec(u.pathname)?.[1] ??
      /\/videos\/(?:[^/]+\/)*?(\d{6,25})(?:\/|$)/.exec(u.pathname)?.[1] ??
      (/^\/watch\/?$/.test(u.pathname) ? u.searchParams.get("v") : null);
    return id && /^\d{6,25}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
