import type { CatId, Lang } from "./categories";

export type Tab = "foryou" | "trending" | "popular" | "top" | "newest";
export type Win = "all" | "30" | "7" | "1";

export interface Channel {
  h: string; // handle, e.g. "@TheAponAhsan"
  n: string; // display name
  cats: CatId[]; // categories you gave the channel (a starting guess for its videos)
  mix: [CatId, number][]; // what it really posts: category and % of its sorted Shorts, biggest first
  bn: boolean; // mostly Bengali titles
  subs: number;
  thumb: string;
  id: string; // YouTube channel ID ("UC…")
  st: "active" | "noShorts" | "notFound" | "removed" | "external" | "fb"; // external = seen via search/preview, not in your list; fb = a Facebook page (videos you added)
  cnt: number; // Shorts of this channel in the library
  last: number; // newest Short (unix seconds), 0 if none
}

export interface Short {
  id: string;
  ch: number; // index into Dataset.channels
  t: string; // title
  p: number; // published (unix seconds)
  v: number; // views
  l: number; // likes
  c: number; // comments
  o: number; // outlier percentile 0..1 (views vs the channel's usual)
  e: number; // engagement percentile 0..1
  tr: number; // trending-speed percentile 0..1
  r: number; // topic relevance 0..1
  k: CatId[]; // categories, main first (empty = couldn't tell)
  lg: Lang; // language
  g: boolean; // categories guessed from the channel (the video's own text said nothing)
  fb?: { url: string; note: string; lists: string[]; by: string }; // a Facebook video you added (id "fb…"; p = when added, v/l = views/reactions then)
}

/** One Shorts refresh and the YouTube API units it spent (written by scripts/fetch.ts). */
export interface UsageRun {
  at: number;
  where: "github" | "local";
  deep: boolean;
  units: number;
  by: { resolve: number; channelInfo: number; playlist: number; stats: number };
  rssOk: number;
  rssFailed: number;
  playlistChecks: number;
  statsRefreshed: number;
  newShorts: number;
  ok: boolean;
}

export interface Dataset {
  generatedAt: number;
  units: number; // YouTube API units used by the last refresh
  usage: UsageRun[]; // refresh history, newest first
  channels: Channel[];
  videos: Short[];
}
