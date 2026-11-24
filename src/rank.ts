import { type CatId, groupOf, isPersonalGroup } from "./categories";
import type { Shared, State } from "./store";
import type { Dataset, Short } from "./types";

/** A Short's categories: your fix if you made one, otherwise the automatic ones. Main first. */
export const videoCats = (s: Short, st: Pick<Shared, "catFix">): CatId[] => st.catFix[s.id] ?? s.k;
/** Still guessed? (your fix makes it certain) */
export const isGuessed = (s: Short, st: Pick<Shared, "catFix">) => !st.catFix[s.id] && s.g;

const WIN_DAYS: Record<string, number> = { all: Infinity, "365": 365, "90": 90, "30": 30, "7": 7, "1": 1 };

type FilterState = Pick<State, "win" | "lang" | "cats" | "hidden" | "bad" | "catFix"> & Partial<Pick<State, "list" | "lists" | "minV">>;
/** Is this Short in a channel list? (its channel is, or — an added Facebook video — you put the video itself in it) */
export const shortInList = (l: { id: string; ch: string[] }, s: Short, chHandle: string) =>
  !!s.fb?.lists.includes(l.id) || l.ch.some((c) => c.toLowerCase() === chHandle.toLowerCase());

/** The feed's filters (channel list, time range, language, categories, hidden channels) as a test for one Short. */
export function feedFilter(ds: Dataset, st: FilterState): (s: Short) => boolean {
  const maxAge = (WIN_DAYS[st.win] ?? Infinity) * 86400;
  const minV = st.minV ?? 0;
  const now = Date.now() / 1000;
  const hidden = new Set(st.hidden);
  const bad = new Set(st.bad);
  const picked = new Set<string>(st.cats);
  const list = st.list ? st.lists?.find((l) => l.id === st.list) : undefined;
  const inList = list ? new Set(list.ch.map((h) => h.toLowerCase())) : undefined;
  return (s) => {
    const ch = ds.channels[s.ch];
    if (!ch || ch.st === "removed" || hidden.has(ch.h) || bad.has(s.id)) return false;
    if (inList && !inList.has(ch.h.toLowerCase()) && !s.fb?.lists.includes(st.list!)) return false;
    if (now - s.p > maxAge) return false;
    if (minV && s.v < minV) return false;
    if (st.lang !== "all" && s.lg !== st.lang) return false;
    const cats = videoCats(s, st);
    if (picked.size) return cats.some((c) => picked.has(c));
    return !(cats[0] && isPersonalGroup(groupOf(cats[0]))); // Islamic and Learn Shorts have their own chips
  };
}

/**
 * Picks the next batch of Shorts.
 * For You blends: outlier (views vs the channel's usual), engagement, trending speed,
 * freshness, topic relevance, what you've liked, plus a little randomness.
 */
export function buildQueue(
  ds: Dataset,
  st: State,
  opts: { prevVisit: number; exclude: Set<string>; lastCh?: number },
  n: number,
): { items: Short[]; recycled: boolean } {
  const now = Date.now() / 1000;
  const passes = feedFilter(ds, st);
  const allowed = (s: Short, ignoreSeen: boolean) => !opts.exclude.has(s.id) && passes(s) && (ignoreSeen || !st.seen[s.id]);
  const picked = new Set<string>(st.cats);
  /** In a category feed: Shorts mainly about it first, guessed ones last. */
  const fit = (s: Short) => {
    if (!picked.size) return 0;
    return (picked.has(videoCats(s, st)[0]) ? 0.2 : 0) - (isGuessed(s, st) ? 0.15 : 0);
  };

  let pool = ds.videos.filter((s) => allowed(s, false));
  let recycled = false;
  if (!pool.length) {
    pool = ds.videos.filter((s) => allowed(s, true));
    recycled = pool.length > 0;
  }

  const score = (s: Short): number => {
    const ageDays = Math.max(0, (now - s.p) / 86400);
    const fresh = Math.exp(-ageDays / 10);
    const views = Math.min(1, Math.log10(s.v + 1) / 7);
    switch (st.tab) {
      case "newest":
        return s.p;
      case "top": // Most viewed: plain view count (the time range picks the period)
        return s.v;
      case "trending":
        return 0.65 * s.tr + 0.2 * fresh + 0.15 * s.e + fit(s) + Math.random() * 0.05;
      case "popular": // Breakouts: views compared with what the channel usually gets
        return 0.6 * s.o + 0.25 * views + 0.15 * s.e + fit(s) + Math.random() * 0.05;
      default: {
        const ch = ds.channels[s.ch];
        const aff = 0.5 + 0.5 * Math.tanh((st.affCh[ch.h] ?? 0) / 4 + (st.affCat[videoCats(s, st)[0] ?? "none"] ?? 0) / 8);
        const isNew = s.p > opts.prevVisit ? 0.15 : 0;
        return 0.28 * s.o + 0.14 * s.e + 0.14 * s.tr + 0.12 * fresh + 0.12 * s.r + 0.2 * aff + isNew + fit(s) + Math.random() * 0.18;
      }
    }
  };

  const ranked = pool
    .map((s) => ({ s, k: score(s) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, Math.max(400, n * 10))
    .map((x) => x.s);

  return { items: diversify(ranked, n, opts.lastCh), recycled };
}

/** Never the same channel twice in a row, and at most 3 per channel in any run of 20. */
function diversify(list: Short[], n: number, lastCh?: number): Short[] {
  const out: Short[] = [];
  const rest = [...list];
  while (out.length < n && rest.length) {
    const prev = out.length ? out[out.length - 1].ch : lastCh;
    const recent = out.slice(-20);
    let pick = rest.findIndex((s) => s.ch !== prev && recent.filter((r) => r.ch === s.ch).length < 3);
    // Few channels to choose from: relax "max 3 per 20" but still never repeat the previous channel.
    if (pick < 0) pick = rest.findIndex((s) => s.ch !== prev);
    if (pick < 0) pick = 0; // only one channel left at all
    out.push(rest.splice(pick, 1)[0]);
  }
  return out;
}
