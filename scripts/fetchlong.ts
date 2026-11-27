/**
 * Fetches the LONG videos (not Shorts) of every active channel in channels.json and writes
 * public/data/long.json — the same layout as shorts.json, with one extra number per video: its length in seconds.
 *
 *   npm run fetch:long
 *
 * Runs after scripts/fetch.ts (it reuses the channel IDs that run found, in data/cache.json) and keeps its own
 * cache in data/long-cache.json. It is separate on purpose: the Shorts refresh is never touched by it.
 *
 * Quota rules (YouTube Data API, 10,000 units/day shared with the Shorts refresh):
 *  - A channel's long-video playlist ("UULF…", 1 unit per page) is read once a day per channel, newest 50 only.
 *  - View/like counts: videos under a week old about daily, older ones weekly (1 unit per 50 videos).
 *  - A run stops by itself at MAX_UNITS, so the Shorts refresh always has room. What isn't reached waits for the next run.
 *  - Per channel the website file keeps the best KEEP_PER_CHANNEL videos plus everything from the last KEEP_RECENT_DAYS days.
 *
 * The API key is read from .env (or the YOUTUBE_API_KEY env var) and is never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAT_IDS, type CatId, detectLang, LANG_CODES, normCats } from "../src/categories";
import { channelNoise, channelPrior, ownBrand, pickCats, type Prior, type Scores, textScores } from "../src/classify";
import { isoSeconds } from "./duration";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env");
const CHANNELS_FILE = join(ROOT, "channels.json");
const CACHE_DIR = join(ROOT, "data");
const SHORTS_CACHE_FILE = join(CACHE_DIR, "cache.json"); // written by scripts/fetch.ts: handle → channel id, name, picture
const CACHE_FILE = join(CACHE_DIR, "long-cache.json");
const OUT_DIR = join(ROOT, "public", "data");
const OUT_FILE = join(OUT_DIR, "long.json");

const DAY = 86400;
/** `npm run fetch:long -- --limit=3` tries only the first 3 channels (a cheap test run; its file is only for looking at). */
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8)) || 0;
const MAX_UNITS = 3000; // this run's share of the daily quota
const CHECK_EVERY = 20 * 3600; // each channel's playlist about once a day
const NO_LONG_RECHECK = 7 * DAY; // a channel with no long videos is looked at again weekly
const KEEP_PER_CHANNEL = 50;
const BACKFILL_PAGES = 4; // once per channel: read back through its last 200 long videos (1 unit per page), not only the newest 50
const KEEP_RECENT_DAYS = 60;
const CONCURRENCY = 8;
const MIN_SECONDS = 61; // YouTube Shorts can be up to 3 minutes; the long-video playlist has none, this is only a safety net
const BENGALI = /[ঀ-৿]/;

interface ChannelInput {
  name: string;
  handle: string;
  cats?: string[];
  cat?: string;
  id?: string;
  status?: "removed";
}
interface LongChannel {
  checkedAt?: number;
  noLong?: boolean;
  deep?: boolean; // the one-time look further back has been done
  known: string[]; // newest first
}
interface LongVideo {
  ch: string; // handle
  t: string;
  p: number;
  v: number;
  l: number;
  c: number;
  dur: number;
  emb: boolean;
  s: number; // stats refreshed at
  d?: string;
  tg?: string[];
  tp?: string[];
  yc?: number;
}
interface LongCache {
  channels: Record<string, LongChannel>;
  videos: Record<string, LongVideo>;
}

function readKey(): string | undefined {
  if (process.env.YOUTUBE_API_KEY) return process.env.YOUTUBE_API_KEY.trim();
  if (!existsSync(ENV_FILE)) return undefined;
  return readFileSync(ENV_FILE, "utf8").match(/^\s*YOUTUBE_API_KEY\s*=\s*["']?([^"'\s]+)/m)?.[1];
}
const KEY = readKey();
if (!KEY) {
  console.error("Missing YOUTUBE_API_KEY in .env");
  process.exit(1);
}

let units = 0;
class QuotaError extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const overBudget = () => units >= MAX_UNITS;

/** Calls the YouTube Data API. Returns null on 404. Never logs the URL (it contains the key). */
async function yt(endpoint: string, params: Record<string, string | number>): Promise<any | null> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("key", KEY!);
  for (let attempt = 0; ; attempt++) {
    units++;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(`Network error calling ${endpoint}`);
    }
    if (res.ok) return res.json();
    const body: any = await res.json().catch(() => ({}));
    const reason: string = body?.error?.errors?.[0]?.reason ?? "";
    if (res.status === 404) return null;
    if (res.status === 403 && /quota/i.test(reason)) throw new QuotaError("Daily YouTube API quota is used up.");
    if (res.status >= 500 && attempt < 2) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`${endpoint} failed: HTTP ${res.status} ${reason} ${body?.error?.message ?? ""}`.trim());
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}
const chunk = <T>(arr: T[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

function cleanDesc(desc: string) {
  return desc
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, 700);
}
const median = (nums: number[]) => {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function percentiles(values: number[]) {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  const denom = Math.max(1, values.length - 1);
  for (const [rank, [, i]] of order.entries()) out[i] = rank / denom;
  return out;
}
/** How often a video's numbers are refreshed, by age. */
const statsInterval = (ageSec: number) => (ageSec < 7 * DAY ? 20 * 3600 : ageSec < 60 * DAY ? 3 * DAY : 14 * DAY);
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const t0 = Date.now();
  const now = Math.floor(t0 / 1000);
  const list: ChannelInput[] = JSON.parse(readFileSync(CHANNELS_FILE, "utf8"));
  const shortsCache: { channels?: Record<string, { id: string; title: string; thumb: string; subs: number }> } = existsSync(
    SHORTS_CACHE_FILE,
  )
    ? JSON.parse(readFileSync(SHORTS_CACHE_FILE, "utf8"))
    : {};
  const cache: LongCache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : { channels: {}, videos: {} };
  const save = () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  };

  const active = list
    .filter((c) => c.status !== "removed")
    .map((c) => ({ c, info: shortsCache.channels?.[c.handle], id: shortsCache.channels?.[c.handle]?.id ?? c.id }))
    .filter((x): x is typeof x & { id: string } => Boolean(x.id))
    .slice(0, LIMIT || undefined);
  const listed = new Set(list.map((c) => c.handle));
  for (const [h, ch] of Object.entries(cache.channels)) {
    if (listed.has(h)) continue;
    for (const id of ch.known) delete cache.videos[id];
    delete cache.channels[h];
  }

  // 1. New long videos: each channel's long-video playlist, newest 50, about once a day
  const due = active.filter(({ c }) => {
    const ch = cache.channels[c.handle];
    return !ch?.checkedAt || !ch.deep || now - ch.checkedAt >= (ch.noLong ? NO_LONG_RECHECK : CHECK_EVERY);
  });
  console.log(`Long videos: checking ${due.length} of ${active.length} channels...`);
  let newCount = 0;
  let stopped = false;
  try {
    await pool(due, CONCURRENCY, async ({ c, id }) => {
      if (overBudget()) {
        stopped = true;
        return;
      }
      const ch = cache.channels[c.handle] ?? { known: [] };
      cache.channels[c.handle] = ch;
      const have = new Set(ch.known);
      const fresh: string[] = [];
      const pages = ch.deep ? 1 : BACKFILL_PAGES;
      let token: string | undefined;
      let any = false;
      for (let n = 0; n < pages; n++) {
        if (n && overBudget()) break;
        const j = await yt("playlistItems", {
          part: "contentDetails",
          playlistId: `UULF${id.slice(2)}`,
          maxResults: 50,
          ...(token ? { pageToken: token } : {}),
        });
        if (!j) break;
        any = true;
        for (const it of j.items ?? []) {
          const vid: string | undefined = it.contentDetails?.videoId;
          if (vid && !have.has(vid)) {
            have.add(vid);
            fresh.push(vid);
          }
        }
        token = j.nextPageToken;
        if (!token) break;
      }
      ch.checkedAt = now;
      if (!any) {
        ch.noLong = ch.known.length === 0;
        return;
      }
      ch.noLong = false;
      ch.deep = true; // the one-time look further back is done
      ch.known = [...fresh, ...ch.known];
      newCount += fresh.length;
    });

    // 2. Numbers and details, by age (1 unit per 50 videos)
    const owner = new Map<string, string>();
    for (const { c } of active) for (const id of cache.channels[c.handle]?.known ?? []) owner.set(id, c.handle);
    const needStats = [...owner.keys()].filter((id) => {
      const v = cache.videos[id];
      return !v || now - v.s >= statsInterval(now - v.p);
    });
    console.log(`Long videos: updating ${needStats.length} of ${owner.size} (${newCount} new)...`);
    const missing = new Set(needStats);
    await pool(chunk(needStats, 50), CONCURRENCY, async (batch) => {
      if (overBudget()) {
        stopped = true;
        for (const id of batch) missing.delete(id); // not looked at yet: keep what we have
        return;
      }
      const j = await yt("videos", {
        part: "snippet,statistics,status,contentDetails,topicDetails",
        id: batch.join(","),
        maxResults: 50,
      });
      for (const it of j?.items ?? []) {
        missing.delete(it.id);
        const title: string = it.snippet?.title ?? "";
        cache.videos[it.id] = {
          ch: owner.get(it.id)!,
          t: title,
          p: Math.floor(Date.parse(it.snippet?.publishedAt) / 1000) || 0,
          v: Number(it.statistics?.viewCount ?? 0),
          l: Number(it.statistics?.likeCount ?? 0),
          c: Number(it.statistics?.commentCount ?? 0),
          dur: isoSeconds(it.contentDetails?.duration),
          emb: it.status?.embeddable !== false && it.status?.privacyStatus !== "private",
          s: now,
          d: cleanDesc(it.snippet?.description ?? ""),
          tg: ((it.snippet?.tags ?? []) as string[]).slice(0, 25).map((x) => x.slice(0, 60)),
          tp: ((it.topicDetails?.topicCategories ?? []) as string[]).map((u) => decodeURIComponent(u.split("/wiki/")[1] ?? u)),
          yc: Number(it.snippet?.categoryId) || undefined,
        };
      }
    });
    // deleted / private videos: forget them
    for (const id of missing) delete cache.videos[id];
    for (const ch of Object.values(cache.channels)) ch.known = ch.known.filter((id) => !missing.has(id));
  } finally {
    save(); // keep progress even if the quota ran out half way
  }
  if (stopped) console.log("Long videos: stopped at this run's budget; the rest follows in the next run.");

  // 3. Score, sort into categories and write the website file
  const outChannels: Record<string, unknown>[] = [];
  const rows: { id: string; ch: number; v: LongVideo; o: number; e: number; tr: number; k: number[]; lg: number; g: boolean }[] = [];
  let guessed = 0;

  for (const { c, info, id } of active) {
    const state = cache.channels[c.handle];
    const vids = (state?.known ?? [])
      .map((vid) => [vid, cache.videos[vid]] as const)
      .filter((x): x is readonly [string, LongVideo] => Boolean(x[1]?.emb) && x[1].dur >= MIN_SECONDS);
    if (!vids.length) continue;
    const userCats = normCats(c.cats, c.cat);
    const med = median(vids.map(([, v]) => v.v));
    const scored = vids.map(([vid, v]) => {
      const ageDays = Math.max((now - v.p) / DAY, 0.25);
      return {
        id: vid,
        v,
        ageDays,
        o: Math.log((v.v + 1) / (med + 1)),
        tr: Math.log1p(v.v / ageDays),
        e: (v.l + 3 * v.c + 1) / (v.v + 100),
      };
    });
    const best = new Set(
      [...scored]
        .sort((a, b) => b.o + b.tr - (a.o + a.tr))
        .slice(0, KEEP_PER_CHANNEL)
        .map((s) => s.id),
    );
    const kept = scored.filter((s) => best.has(s.id) || s.ageDays <= KEEP_RECENT_DAYS);

    const texts = vids.map(([, v]) => ({ title: v.t, desc: v.d, tags: v.tg, topics: v.tp, ytCat: v.yc }));
    const noise = channelNoise(texts);
    const scores = new Map<string, Scores>(vids.map(([vid], i) => [vid, textScores(texts[i], noise)]));
    const counted: Prior = {};
    let confident = 0;
    for (const sc of scores.values()) {
      const r = pickCats(sc, {});
      if (r.guessed || !r.cats[0]) continue;
      counted[r.cats[0]] = (counted[r.cats[0]] ?? 0) + 1;
      confident++;
    }
    const mix: Prior = {};
    for (const [k, n] of Object.entries(counted)) mix[k as CatId] = (n ?? 0) / confident;
    const prior = channelPrior(confident >= 5 ? mix : {}, userCats);
    const bnText = vids.filter(([, v]) => BENGALI.test(`${v.t} ${v.d ?? ""}`)).length;
    const langs = new Map(vids.map(([vid, v]) => [vid, detectLang(v.t, v.d ?? "", bnText >= vids.length * 0.3)]));

    const idx = outChannels.length;
    outChannels.push({
      h: c.handle,
      n: info?.title || c.name,
      cats: userCats,
      mix: (Object.entries(mix) as [CatId, number][])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => [CAT_IDS.indexOf(k), Math.round(v * 100)]),
      bn: [...langs.values()].filter((l) => l === "bn").length / vids.length >= 0.3,
      subs: info?.subs ?? 0,
      thumb: info?.thumb ?? "",
      id,
      st: "active",
      cnt: kept.length,
      last: Math.max(...vids.map(([, v]) => v.p)),
    });
    for (const s of kept) {
      const sorted = ownBrand(pickCats(scores.get(s.id) ?? {}, prior), userCats);
      if (sorted.guessed) guessed++;
      rows.push({
        id: s.id,
        ch: idx,
        v: s.v,
        o: s.o,
        e: s.e,
        tr: s.tr,
        k: sorted.cats.map((k) => CAT_IDS.indexOf(k)),
        lg: LANG_CODES.indexOf(langs.get(s.id) ?? "en"),
        g: sorted.guessed,
      });
    }
  }

  const oP = percentiles(rows.map((r) => r.o));
  const eP = percentiles(rows.map((r) => r.e));
  const tP = percentiles(rows.map((r) => r.tr));
  // [id, channel, title, published, views, likes, comments, outlier, engagement, trending, relevance,
  //  categories, language, guessed, length in seconds]
  const videos = rows.map((r, i) => [
    r.id,
    r.ch,
    r.v.t,
    r.v.p,
    r.v.v,
    r.v.l,
    r.v.c,
    r2(oP[i]),
    r2(eP[i]),
    r2(tP[i]),
    0.5,
    r.k,
    r.lg,
    r.g ? 1 : 0,
    r.v.dur,
  ]);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: now, units, cats: CAT_IDS, langs: LANG_CODES, channels: outChannels, videos }));
  console.log(
    `\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${videos.length} long videos from ${outChannels.length} channels written to public/data/long.json (${guessed} categories guessed from the channel)`,
  );
  console.log(`API units used this run: ~${units} (this run's limit: ${MAX_UNITS})`);
}

main().catch((err) => {
  console.error(`\n${err instanceof QuotaError ? "" : "Error: "}${err.message}`);
  console.error(`API units used before stopping: ~${units}`);
  // a quota stop must not fail the whole deploy: the Shorts are already fetched
  process.exit(err instanceof QuotaError ? 0 : 1);
});
