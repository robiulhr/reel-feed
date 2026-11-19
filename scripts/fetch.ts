/**
 * Fetches Shorts from every active channel in channels.json, scores them and writes
 * public/data/shorts.json for the website.
 *
 *   npm run fetch          normal refresh
 *   npm run fetch:deep     also digs further back into each channel's history
 *
 * Quota-saving rules (YouTube Data API, 10,000 units/day):
 *  - New uploads are detected with each channel's public RSS feed (free). The Shorts playlist
 *    (1 unit/page) is only checked when RSS shows something new, RSS fails, or once a week.
 *  - View/like counts are refreshed by age: Shorts < 7 days old every run, < 60 days once a day,
 *    older ones once a week (1 unit per 50 Shorts).
 *  - Removed channels are not fetched at all. Permanently deleted channels are purged from the cache.
 *
 * The API key is read from .env (or the YOUTUBE_API_KEY env var) and is never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env");
const CHANNELS_FILE = join(ROOT, "channels.json");
const CACHE_DIR = join(ROOT, "data");
const CACHE_FILE = join(CACHE_DIR, "cache.json");
const OUT_DIR = join(ROOT, "public", "data");
const OUT_FILE = join(OUT_DIR, "shorts.json");

const DEEP = process.argv.includes("--deep");
const MAX_PAGES = DEEP ? 20 : 4; // 50 Shorts per page
const KEEP_PER_CHANNEL = 150; // best older Shorts kept per channel
const KEEP_RECENT_DAYS = 60; // every Short newer than this is kept
const CONCURRENCY = 8;
const DAY = 86400;
const FORCE_PLAYLIST_CHECK = 7 * DAY; // safety net in case RSS misses something

type Cat = "bangla" | "ads" | "stories" | "founders" | "books" | "ai" | "other";
const CAT_PRIOR: Record<Cat, number> = { ads: 1, stories: 1, bangla: 0.8, founders: 0.8, books: 0.5, ai: 0.5, other: 0.4 };

interface ChannelInput { name: string; handle: string; cat?: Cat; id?: string; status?: "removed" }
interface CachedChannel {
  id: string; title: string; thumb: string; subs: number; known: string[];
  noShorts?: boolean; rss?: string[]; checkedAt?: number;
}
interface CachedVideo { ch: string; t: string; p: number; v: number; l: number; c: number; kw: number; emb: boolean; bn: boolean; s?: number }
interface Cache { channels: Record<string, CachedChannel>; videos: Record<string, CachedVideo>; usage?: UsageRun[] }

/** What each API call was for — shown on the app's API usage page. */
type UsageTag = "resolve" | "channelInfo" | "playlist" | "stats";
interface UsageRun {
  at: number; // unix seconds
  where: "github" | "local";
  deep: boolean;
  units: number;
  by: Record<UsageTag, number>; // units per purpose
  rssOk: number;
  rssFailed: number;
  playlistChecks: number; // channels whose Shorts playlist was read
  statsRefreshed: number; // Shorts whose views/likes were refreshed
  newShorts: number;
  ok: boolean;
}
const USAGE_HISTORY = 300; // ~7 weeks of refreshes every 4 hours

const KEYWORDS = [
  "business", "brand", "marketing", "sales", "sell", "startup", "founder", "ceo", "company", "companies",
  "meta ads", "facebook", "instagram", "customer", "price", "pricing", "profit", "ecommerce", "e-commerce",
  "shopify", "amazon", "money", "revenue", "strategy", "entrepreneur", "billion", "million", "product",
  "growth", "offer", "funnel", "agency", "dropship", "negotiat", "invest", "mindset", "viral", "content",
  "creative", "advertis", "copywrit", "retention", "scale", "scaling",
  "ব্যবসা", "বিজনেস", "ব্র্যান্ড", "মার্কেটিং", "কাস্টমার", "অফার", "প্রোডাক্ট", "উদ্যোক্তা", "কোম্পানি",
  "টাকা", "বিক্রি", "ফেসবুক", "বিজ্ঞাপন", "সেল",
];
const BENGALI = /[ঀ-৿]/;

function readKey(): string | undefined {
  if (process.env.YOUTUBE_API_KEY) return process.env.YOUTUBE_API_KEY.trim();
  if (!existsSync(ENV_FILE)) return undefined;
  const m = readFileSync(ENV_FILE, "utf8").match(/^\s*YOUTUBE_API_KEY\s*=\s*["']?([^"'\s]+)/m);
  return m?.[1];
}
const KEY = readKey();
if (!KEY) {
  console.error("Missing YOUTUBE_API_KEY in .env");
  process.exit(1);
}

let units = 0;
const byTag: Record<UsageTag, number> = { resolve: 0, channelInfo: 0, playlist: 0, stats: 0 };
const counts = { rssOk: 0, rssFailed: 0, playlistChecks: 0, statsCalls: 0, statsRefreshed: 0, newShorts: 0 };
class QuotaError extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls the YouTube Data API. Returns null on 404. Never logs the URL (it contains the key). */
async function yt(endpoint: string, params: Record<string, string | number>, tag: UsageTag): Promise<any | null> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("key", KEY!);
  for (let attempt = 0; ; attempt++) {
    units++;
    byTag[tag]++;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      throw new Error(`Network error calling ${endpoint}`);
    }
    if (res.ok) return res.json();
    const body: any = await res.json().catch(() => ({}));
    const reason: string = body?.error?.errors?.[0]?.reason ?? "";
    if (res.status === 404) return null;
    if (res.status === 403 && /quota/i.test(reason)) {
      throw new QuotaError("Daily YouTube API quota is used up. It resets at midnight Pacific time.");
    }
    if (res.status >= 500 && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
    throw new Error(`${endpoint} failed: HTTP ${res.status} ${reason} ${body?.error?.message ?? ""}`.trim());
  }
}

/** Latest ~15 upload IDs from the channel's public RSS feed. Free (no API quota). Null if unavailable. */
async function rssIds(channelId: string): Promise<string[] | null> {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const xml = await r.text();
    return [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]);
  } catch {
    return null;
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

const chunk = <T,>(arr: T[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

function kwScore(text: string) {
  const s = text.toLowerCase();
  let hits = 0;
  for (const k of KEYWORDS) if (s.includes(k)) hits++;
  return Math.min(1, hits / 3);
}

function median(nums: number[]) {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Rank-based percentile (0..1) for each value. */
function percentiles(values: number[]) {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  const denom = Math.max(1, values.length - 1);
  order.forEach(([, i], rank) => (out[i] = rank / denom));
  return out;
}

/** How often a Short's stats are refreshed, by age. */
function statsInterval(ageSec: number) {
  if (ageSec < 7 * DAY) return 0; // every run
  if (ageSec < 60 * DAY) return 20 * 3600; // about daily
  return 7 * DAY; // weekly
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

let cacheRef: Cache | null = null;
let runStartedAt = 0;

function saveCache() {
  if (!cacheRef) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cacheRef));
}

/** Adds this run to the usage history (also for failed runs, so quota spent is never hidden). */
function recordUsage(ok: boolean): UsageRun[] {
  if (!cacheRef) return [];
  const run: UsageRun = {
    at: runStartedAt || Math.floor(Date.now() / 1000),
    where: process.env.GITHUB_ACTIONS ? "github" : "local",
    deep: DEEP,
    units,
    by: { ...byTag },
    rssOk: counts.rssOk,
    rssFailed: counts.rssFailed,
    playlistChecks: counts.playlistChecks,
    statsRefreshed: counts.statsRefreshed,
    newShorts: counts.newShorts,
    ok,
  };
  cacheRef.usage = [run, ...(cacheRef.usage ?? [])].slice(0, USAGE_HISTORY);
  saveCache();
  return cacheRef.usage;
}

async function main() {
  const t0 = Date.now();
  const now = Math.floor(t0 / 1000);
  const list: ChannelInput[] = JSON.parse(readFileSync(CHANNELS_FILE, "utf8"));
  const cache: Cache = existsSync(CACHE_FILE)
    ? JSON.parse(readFileSync(CACHE_FILE, "utf8"))
    : { channels: {}, videos: {} };
  cacheRef = cache;
  runStartedAt = now;

  // 0. Purge permanently deleted channels (no longer in the list at all)
  const listed = new Set(list.map((c) => c.handle));
  for (const [h, ch] of Object.entries(cache.channels)) {
    if (listed.has(h)) continue;
    for (const id of ch.known) delete cache.videos[id];
    delete cache.channels[h];
  }

  const activeIn = list.filter((c) => c.status !== "removed");
  const notFound: string[] = [];

  // 1. Resolve new channels to IDs (free if the app already stored the ID)
  const toResolve = activeIn.filter((c) => !cache.channels[c.handle]?.id);
  if (toResolve.length) console.log(`Resolving ${toResolve.length} new channel(s)...`);
  await pool(toResolve, CONCURRENCY, async (c) => {
    if (c.id) {
      cache.channels[c.handle] = { id: c.id, title: c.name, thumb: "", subs: 0, known: [] };
      return;
    }
    const j = await yt("channels", { part: "snippet,statistics", forHandle: c.handle }, "resolve");
    const item = j?.items?.[0];
    if (!item) { notFound.push(`${c.name} (${c.handle})`); return; }
    cache.channels[c.handle] = {
      id: item.id, title: item.snippet.title,
      thumb: item.snippet.thumbnails?.default?.url ?? "",
      subs: Number(item.statistics?.subscriberCount ?? 0), known: [],
    };
  });

  const active = activeIn
    .map((c) => [c, cache.channels[c.handle]] as const)
    .filter((x): x is readonly [ChannelInput, CachedChannel] => Boolean(x[1]?.id));

  // 2. Channel names, avatars, subscriber counts (1 unit per 50 channels)
  await pool(chunk(active, 50), CONCURRENCY, async (batch) => {
    const j = await yt("channels", { part: "snippet,statistics", id: batch.map(([, ch]) => ch.id).join(","), maxResults: 50 }, "channelInfo");
    const byId = new Map<string, any>((j?.items ?? []).map((it: any) => [it.id, it]));
    for (const [, ch] of batch) {
      const it = byId.get(ch.id);
      if (!it) continue;
      ch.title = it.snippet.title;
      ch.thumb = it.snippet.thumbnails?.default?.url ?? ch.thumb;
      ch.subs = Number(it.statistics?.subscriberCount ?? ch.subs);
    }
  });

  // 3. New Shorts: RSS first (free), Shorts playlist only when needed
  console.log(`Checking ${active.length} channels for new uploads${DEEP ? " (deep)" : ""}...`);
  let newCount = 0;
  await pool(active, CONCURRENCY, async ([, ch]) => {
    let needPlaylist = DEEP || !ch.checkedAt || now - ch.checkedAt > FORCE_PLAYLIST_CHECK;
    const feed = await rssIds(ch.id);
    if (feed === null) { counts.rssFailed++; needPlaylist = true; }
    else {
      counts.rssOk++;
      const seen = new Set(ch.rss ?? []);
      if (feed.some((id) => !seen.has(id))) needPlaylist = true;
      ch.rss = feed;
    }
    if (!needPlaylist) return;

    counts.playlistChecks++;
    const known = new Set(ch.known);
    const fresh: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const j = await yt("playlistItems", {
        part: "contentDetails",
        playlistId: "UUSH" + ch.id.slice(2),
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      }, "playlist");
      if (!j) { ch.noShorts = known.size === 0; break; }
      ch.noShorts = false;
      let hitKnown = false;
      for (const it of j.items ?? []) {
        const id: string | undefined = it.contentDetails?.videoId;
        if (!id) continue;
        if (known.has(id)) { hitKnown = true; continue; }
        known.add(id);
        fresh.push(id);
      }
      pageToken = j.nextPageToken;
      pages++;
      if (hitKnown && !DEEP) break;
    } while (pageToken && pages < MAX_PAGES);
    ch.checkedAt = now;
    ch.known = DEEP ? [...ch.known, ...fresh.filter((id) => !ch.known.includes(id))] : [...fresh, ...ch.known];
    newCount += fresh.length;
  });

  // 4. Stats, refreshed by age (1 unit per 50 Shorts)
  const owner = new Map<string, string>();
  for (const [c, ch] of active) for (const id of ch.known) owner.set(id, c.handle);
  const due = [...owner.keys()].filter((id) => {
    const v = cache.videos[id];
    return !v || now - (v.s ?? 0) >= statsInterval(now - v.p);
  });
  console.log(`Updating stats for ${due.length} of ${owner.size} Shorts (${newCount} new)...`);
  counts.statsRefreshed = due.length;
  counts.newShorts = newCount;
  const missing = new Set(due);
  await pool(chunk(due, 50), CONCURRENCY, async (batch) => {
    counts.statsCalls++;
    const j = await yt("videos", { part: "snippet,statistics,status", id: batch.join(","), maxResults: 50 }, "stats");
    for (const it of j?.items ?? []) {
      missing.delete(it.id);
      const title: string = it.snippet?.title ?? "";
      const desc: string = it.snippet?.description ?? "";
      cache.videos[it.id] = {
        ch: owner.get(it.id)!,
        t: title,
        p: Math.floor(Date.parse(it.snippet?.publishedAt) / 1000) || 0,
        v: Number(it.statistics?.viewCount ?? 0),
        l: Number(it.statistics?.likeCount ?? 0),
        c: Number(it.statistics?.commentCount ?? 0),
        kw: kwScore(`${title} ${desc.slice(0, 500)}`),
        emb: it.status?.embeddable !== false && it.status?.privacyStatus !== "private",
        bn: BENGALI.test(title),
        s: now,
      };
    }
  });
  // Deleted / private Shorts: forget them
  for (const id of missing) delete cache.videos[id];
  for (const [, ch] of active) ch.known = ch.known.filter((id) => !missing.has(id));
  saveCache();

  // 5. Score and write the website data. Every listed channel is included (for the Channels panel);
  //    only active ones contribute Shorts.
  type OutChannel = {
    h: string; n: string; cat: Cat; bn: boolean; subs: number; thumb: string;
    id: string; st: "active" | "noShorts" | "notFound" | "removed"; cnt: number; last: number;
  };
  const outChannels: OutChannel[] = [];
  const rows: { id: string; ch: number; v: CachedVideo; o: number; e: number; tr: number; r: number }[] = [];
  const noShorts: string[] = [];

  for (const c of list) {
    const ch = cache.channels[c.handle];
    const cat: Cat = c.cat ?? "other";
    const base: OutChannel = {
      h: c.handle, n: ch?.title || c.name, cat, bn: cat === "bangla", subs: ch?.subs ?? 0,
      thumb: ch?.thumb ?? "", id: ch?.id ?? c.id ?? "", st: "notFound", cnt: 0, last: 0,
    };
    if (c.status === "removed") { outChannels.push({ ...base, st: "removed" }); continue; }
    if (!ch?.id) { outChannels.push(base); continue; }

    const vids = ch.known
      .map((id) => [id, cache.videos[id]] as const)
      .filter((x): x is readonly [string, CachedVideo] => Boolean(x[1]?.emb));
    if (!vids.length) {
      noShorts.push(`${c.name} (${c.handle})`);
      outChannels.push({ ...base, st: "noShorts" });
      continue;
    }

    const med = median(vids.map(([, v]) => v.v));
    const scored = vids.map(([id, v]) => {
      const ageDays = Math.max((now - v.p) / DAY, 0.25);
      return {
        id, v, ageDays,
        o: Math.log((v.v + 1) / (med + 1)),
        tr: Math.log1p(v.v / ageDays),
        e: (v.l + 3 * v.c + 1) / (v.v + 100),
      };
    });
    const best = new Set(
      [...scored].sort((a, b) => b.o + b.tr - (a.o + a.tr)).slice(0, KEEP_PER_CHANNEL).map((s) => s.id),
    );
    const kept = scored.filter((s) => best.has(s.id) || s.ageDays <= KEEP_RECENT_DAYS);

    const idx = outChannels.length;
    const bnShare = vids.filter(([, v]) => v.bn).length / vids.length;
    outChannels.push({
      ...base, bn: bnShare >= 0.3, st: "active", cnt: kept.length,
      last: Math.max(...vids.map(([, v]) => v.p)),
    });
    for (const s of kept) rows.push({ id: s.id, ch: idx, v: s.v, o: s.o, e: s.e, tr: s.tr, r: 0.5 * s.v.kw + 0.5 * CAT_PRIOR[cat] });
  }

  const oP = percentiles(rows.map((r) => r.o));
  const eP = percentiles(rows.map((r) => r.e));
  const tP = percentiles(rows.map((r) => r.tr));
  const videos = rows.map((r, i) => [r.id, r.ch, r.v.t, r.v.p, r.v.v, r.v.l, r.v.c, r3(oP[i]), r3(eP[i]), r3(tP[i]), r3(r.r)]);

  mkdirSync(OUT_DIR, { recursive: true });
  const usage = recordUsage(true);
  writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: now, units, usage, channels: outChannels, videos }));

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const activeCount = outChannels.filter((c) => c.st === "active").length;
  console.log(`\nDone in ${secs}s — ${videos.length} Shorts from ${activeCount} channels written to public/data/shorts.json`);
  console.log(`API units used this run: ~${units} (free limit: 10,000/day)`);
  console.log(
    `RSS checks: ${counts.rssOk} ok, ${counts.rssFailed} failed · playlist checks: ${counts.playlistChecks} · stats calls: ${counts.statsCalls}`,
  );
  if (noShorts.length) console.log(`\nNo playable Shorts (${noShorts.length}): ${noShorts.join(", ")}`);
  if (notFound.length) console.log(`\nHandle not found (${notFound.length}) — check these in channels.json: ${notFound.join(", ")}`);
}

main().catch((err) => {
  console.error(`\n${err instanceof QuotaError ? "" : "Error: "}${err.message}`);
  console.error(`API units used before stopping: ~${units}`);
  recordUsage(false);
  process.exit(1);
});
