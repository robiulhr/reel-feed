export type Cat = "bangla" | "ads" | "stories" | "founders" | "books" | "ai" | "other";
export type Tab = "foryou" | "trending" | "popular" | "newest";
export type Win = "all" | "30" | "7" | "1";

export interface Channel {
  h: string; // handle, e.g. "@TheAponAhsan"
  n: string; // display name
  cat: Cat;
  bn: boolean; // mostly Bengali titles
  subs: number;
  thumb: string;
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
}

export interface Dataset {
  generatedAt: number;
  channels: Channel[];
  videos: Short[];
}
