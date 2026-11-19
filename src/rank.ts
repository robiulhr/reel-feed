import type { State } from "./store";
import type { Dataset, Short } from "./types";

export const CATS = [
  { id: "all", label: "All" },
  { id: "bangla", label: "Bangla" },
  { id: "ads", label: "Ads & E-com" },
  { id: "stories", label: "Biz Stories" },
  { id: "founders", label: "Founders" },
  { id: "books", label: "Books & Money" },
  { id: "ai", label: "AI & Brand" },
];

const WIN_DAYS: Record<string, number> = { all: Infinity, "30": 30, "7": 7, "1": 1 };

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
  const maxAge = (WIN_DAYS[st.win] ?? Infinity) * 86400;
  const hidden = new Set(st.hidden);
  const bad = new Set(st.bad);

  const allowed = (s: Short, ignoreSeen: boolean) => {
    const ch = ds.channels[s.ch];
    if (hidden.has(ch.h) || bad.has(s.id) || opts.exclude.has(s.id)) return false;
    if (now - s.p > maxAge) return false;
    if (st.cat !== "all") {
      if (st.cat === "bangla" ? !(ch.cat === "bangla" || ch.bn) : ch.cat !== st.cat) return false;
    }
    return ignoreSeen || !st.seen[s.id];
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
      case "trending":
        return 0.65 * s.tr + 0.2 * fresh + 0.15 * s.e + Math.random() * 0.05;
      case "popular":
        return 0.6 * s.o + 0.25 * views + 0.15 * s.e + Math.random() * 0.05;
      default: {
        const ch = ds.channels[s.ch];
        const aff = 0.5 + 0.5 * Math.tanh((st.affCh[ch.h] ?? 0) / 4 + (st.affCat[ch.cat] ?? 0) / 8);
        const isNew = s.p > opts.prevVisit ? 0.15 : 0;
        return 0.28 * s.o + 0.14 * s.e + 0.14 * s.tr + 0.12 * fresh + 0.12 * s.r + 0.2 * aff + isNew + Math.random() * 0.18;
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
    let pick = rest.findIndex(
      (s) => s.ch !== prev && recent.filter((r) => r.ch === s.ch).length < 3,
    );
    if (pick < 0) pick = 0;
    out.push(rest.splice(pick, 1)[0]);
  }
  return out;
}
