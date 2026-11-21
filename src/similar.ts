/**
 * "More like this" for a Short.
 *  A) In your feed (free, instant): topic similarity over titles of every Short in your library
 *     (TF-IDF, Bangla + English), blended with quality (outlier + engagement), max 3 per channel.
 *  B) On YouTube (on request, ~103 units, behind the cost card): searches Shorts with the key words
 *     of this Short (editable). Results show new channels you can explore and add.
 */
import type { AppApi } from "./app";
import { listStatus } from "./channels";
import { openChannel, shortGrid } from "./explore";
import { COST, confirmCost, getQuota, normQuery, noteSpend, similarPastSearch, spendToast, vagueWarning } from "./quota";
import * as sync from "./sync";
import type { Short } from "./types";

const STOP = new Set([
  // English
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by", "from", "is", "are", "was", "were",
  "be", "been", "it", "its", "this", "that", "these", "those", "you", "your", "i", "me", "my", "we", "our", "they", "their",
  "he", "she", "his", "her", "as", "if", "so", "not", "no", "do", "does", "did", "can", "will", "just", "how", "what", "why",
  "when", "who", "which", "all", "more", "most", "about", "into", "than", "then", "there", "here", "have", "has", "had", "get",
  "got", "make", "made", "one", "two", "new", "now", "out", "up", "very", "really", "every", "ever", "never", "should", "would",
  "could", "need", "want", "like", "know", "think", "people", "thing", "things", "way", "day", "time", "year", "years",
  // Platform noise
  "shorts", "short", "viral", "trending", "fyp", "reels", "reel", "video", "videos", "subscribe", "follow", "watch", "part",
  "ep", "episode", "full", "official", "youtube", "tiktok", "instagram", "ytshorts", "foryou", "foryoupage", "explore",
  // Bangla / Banglish
  "এর", "এই", "কি", "কী", "না", "আর", "করে", "থেকে", "জন্য", "একটি", "এক", "ও", "যে", "তো", "হয়", "হয়", "হবে", "আপনি",
  "আপনার", "আমি", "আমার", "আমরা", "কেন", "কিভাবে", "কীভাবে", "দিয়ে", "দিয়ে", "নিয়ে", "নিয়ে", "সব", "কোন", "কোনো", "যদি",
  "তাহলে", "কিন্তু", "এবং", "বা", "শুধু", "আছে", "নেই", "ছিল", "করতে", "করার", "হলে", "মত", "মতো", "ki", "na", "ar", "kore",
  "theke", "jonno", "ami", "apni", "apnar", "kivabe", "keno", "ei", "er",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
}

// ---------- library index (built once, on first use) ----------
interface Index { docs: Map<string, number>[]; norms: number[]; inv: Map<string, number[]>; idf: Map<string, number> }
let index: Index | null = null;
let indexedFor: Short[] | null = null; // rebuild when the library is replaced

function buildIndex(videos: Short[]): Index {
  const docs: Map<string, number>[] = [];
  const df = new Map<string, number>();
  for (const v of videos) {
    const tf = new Map<string, number>();
    for (const w of tokenize(v.t)) tf.set(w, (tf.get(w) ?? 0) + 1);
    docs.push(tf);
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const N = videos.length;
  const idf = new Map<string, number>();
  for (const [w, d] of df) idf.set(w, Math.log((N + 1) / (d + 1)) + 1);
  const inv = new Map<string, number[]>();
  const norms: number[] = [];
  docs.forEach((tf, i) => {
    let sq = 0;
    for (const [w, c] of tf) {
      const x = c * idf.get(w)!;
      sq += x * x;
      if (df.get(w)! < N * 0.05) { // very common words don't help find matches
        let l = inv.get(w);
        if (!l) inv.set(w, (l = []));
        l.push(i);
      }
    }
    norms.push(Math.sqrt(sq) || 1);
  });
  return { docs, norms, inv, idf };
}

function getIndex(app: AppApi) {
  if (!index || indexedFor !== app.ds.videos) {
    index = buildIndex(app.ds.videos);
    indexedFor = app.ds.videos;
  }
  return index;
}

function queryVector(ix: Index, text: string) {
  const tf = new Map<string, number>();
  for (const w of tokenize(text)) tf.set(w, (tf.get(w) ?? 0) + 1);
  const vec = new Map<string, number>();
  let sq = 0;
  for (const [w, c] of tf) {
    const x = c * (ix.idf.get(w) ?? Math.log(ix.docs.length + 1) + 1);
    vec.set(w, x);
    sq += x * x;
  }
  return { vec, norm: Math.sqrt(sq) || 1 };
}

/** Free, instant: Shorts in your library about the same topic. */
export function similarInLibrary(app: AppApi, s: Short, limit = 40): { short: Short; score: number }[] {
  const ix = getIndex(app);
  const { vec, norm } = queryVector(ix, s.t);
  const scores = new Map<number, number>();
  for (const [w, qx] of vec) {
    const idf = ix.idf.get(w);
    for (const i of ix.inv.get(w) ?? []) {
      scores.set(i, (scores.get(i) ?? 0) + qx * (ix.docs[i].get(w)! * idf!));
    }
  }
  const vids = app.ds.videos;
  const ranked = [...scores]
    .map(([i, dot]) => ({ i, cos: dot / (norm * ix.norms[i]) }))
    .filter(({ i, cos }) => vids[i].id !== s.id && cos > 0.08 && app.ds.channels[vids[i].ch].st !== "removed")
    .map(({ i, cos }) => ({ short: vids[i], score: 0.75 * cos + 0.15 * vids[i].o + 0.1 * vids[i].e }))
    .sort((a, b) => b.score - a.score);
  const perChannel = new Map<number, number>();
  const out: { short: Short; score: number }[] = [];
  for (const r of ranked) {
    const n = perChannel.get(r.short.ch) ?? 0;
    if (n >= 3) continue;
    perChannel.set(r.short.ch, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** The 3–4 most distinctive words of the title — a starting point you can edit. */
export function suggestQuery(app: AppApi, s: Short) {
  const ix = getIndex(app);
  const { vec } = queryVector(ix, s.t);
  const words = [...vec].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 4);
  return words.join(" ");
}

// ---------- page ----------
interface SearchResult {
  id: string; t: string; p: number; v: number; l: number; c: number;
  ch: { id: string; name: string; thumb: string; handle: string; subs: number; suggestedCat: string };
}
interface SearchResponse { q: string; results: SearchResult[]; units: number; cached: boolean; fetchedAt: number; quota?: { used: number; budget: number } }

const searches = new Map<string, SearchResponse>(); // by source Short id (this session)
const queries = new Map<string, string>();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const btn = (label: string, onClick: () => void, cls = "btn sm") => {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
};

export function openSimilar(app: AppApi, s: Short, tab: "feed" | "youtube" = "feed") {
  app.openPage("More like this", (body) => {
    const reopen = (t: "feed" | "youtube" = tab) => openSimilar(app, s, t);

    // source Short
    const src = el("div", "sim-src");
    const img = el("img") as HTMLImageElement;
    img.alt = "";
    app.thumb(img, s.id);
    const txt = el("div", "sim-src-txt");
    txt.append(el("div", "sim-src-title", s.t), el("div", "ch-note", app.ds.channels[s.ch]?.n ?? ""));
    src.append(img, txt);
    body.append(src);

    const lib = similarInLibrary(app, s);
    const tabs = el("div", "cp-tabs");
    tabs.append(
      btn(`In your feed (${lib.length}) · free`, () => reopen("feed"), `cp-tab${tab === "feed" ? " on" : ""}`),
      btn("On YouTube", () => reopen("youtube"), `cp-tab${tab === "youtube" ? " on" : ""}`),
    );
    body.append(tabs);

    if (tab === "feed") {
      if (!lib.length) {
        body.append(el("p", "ch-note", "No close matches in your library for this one. Try the On YouTube tab."));
        return;
      }
      const list = lib.map((r) => r.short);
      const play = (i: number) => app.playList("More like this", list, i, () => reopen("feed"));
      body.append(btn("▶ Play all", () => play(0), "btn sm primary"));
      body.append(el("p", "ch-note", "Matched by topic words in the titles, then by how well each Short performed. Free — no API units."));
      body.append(shortGrid(app, list, play, { showChannel: true }));
      return;
    }

    // ---- On YouTube
    const form = el("form", "ch-add-form");
    const input = el("input") as HTMLInputElement;
    input.value = queries.get(s.id) ?? suggestQuery(app, s);
    input.placeholder = "Search words";
    input.autocomplete = "off";
    const go = btn(`Search · ~${COST.search} units`, () => {}, "btn sm primary");
    go.type = "submit";
    form.append(input, go);
    body.append(form);
    const hint = el("p", "ch-note", "These are the most distinctive words of this Short. Edit them to say what you're really looking for — specific words find better Shorts.");
    const warn = el("p", "ch-note warn", "");
    const updateWarn = () => { warn.textContent = vagueWarning(input.value); };
    input.oninput = () => { queries.set(s.id, input.value); updateWarn(); };
    updateWarn();
    body.append(hint, warn);

    const resultsBox = el("div");
    body.append(resultsBox);

    const runSearch = async (q: string) => {
      if (!sync.isConnected()) { app.toast("Log in first (Menu → Sync)"); return; }
      const quota = await getQuota();
      const past = quota ? similarPastSearch(q, quota.recent) : null;
      const free: { label: string; run: () => void }[] = [];
      if (lib.length) free.push({ label: `${lib.length} similar Shorts from your own feed`, run: () => reopen("feed") });
      const exact = !!past && past.norm === normQuery(q); // same words as a search from the last 7 days → free
      if (past && !exact) {
        free.push({ label: `Reuse your search "${past.q}" from ${app.ago(past.at)} (${past.n} results)`, run: () => runSearch(past.q) });
      }
      if (!exact) {
        const ok = await confirmCost({
          title: `Search YouTube for "${q}"`,
          cost: COST.search,
          alwaysAsk: true,
          warning: vagueWarning(q) || undefined,
          detail: "Finds up to 25 Shorts on all of YouTube, mostly from channels you don't follow yet. Repeating this search within 7 days is free.",
          free,
        });
        if (!ok) return;
      }
      go.disabled = true;
      go.textContent = "Searching…";
      try {
        const r = await sync.call<SearchResponse>("/search-shorts", { method: "POST", body: JSON.stringify({ q }) });
        searches.set(s.id, r);
        noteSpend(r.units, `YouTube search "${q.slice(0, 60)}"`, r.quota);
        app.toast(spendToast(r.units, r.quota, r.cached));
        reopen("youtube");
      } catch (e) {
        app.toast(e instanceof Error ? e.message : "Search failed");
        go.disabled = false;
        go.textContent = `Search · ~${COST.search} units`;
      }
    };
    form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) runSearch(input.value.trim()); };

    const res = searches.get(s.id);
    if (!res) {
      resultsBox.append(el("p", "ch-note", `Nothing searched yet. Each new search costs ~${COST.search} of your daily units; the cost card shows your budget before anything is spent.`));
      return;
    }
    resultsBox.append(el("p", "ch-note", `${res.results.length} Shorts for "${res.q}" · ${res.cached ? "from cache, 0 units" : `${res.units} units`} · ${app.ago(res.fetchedAt)}`));

    // channels found, most frequent first
    const byCh = new Map<string, { ch: SearchResult["ch"]; n: number }>();
    for (const r of res.results) {
      const x = byCh.get(r.ch.id) ?? { ch: r.ch, n: 0 };
      x.n++;
      byCh.set(r.ch.id, x);
    }
    const chans = [...byCh.values()].sort((a, b) => b.n - a.n || b.ch.subs - a.ch.subs);
    const chBox = el("div", "sim-chans");
    chBox.append(el("div", "u-h", "Channels found"));
    for (const { ch, n } of chans) {
      const st = listStatus(ch.handle, ch.id);
      const row = el("button", "sim-chan");
      row.type = "button";
      const a = el("img") as HTMLImageElement;
      a.alt = "";
      if (ch.thumb) a.src = ch.thumb;
      const t = el("span", "sim-chan-name", ch.name || ch.handle);
      const sub = el("span", "ch-note", `${n} Short${n === 1 ? "" : "s"} here · ${app.fmt(ch.subs)} subs`);
      const tag = el("span", `pill st-${st === "listed" ? "active" : st === "removed" ? "removed" : "pending"}`,
        st === "listed" ? "In your list" : st === "removed" ? "Removed" : n >= 2 ? "Good candidate" : "New");
      const txt2 = el("span", "sim-chan-txt");
      txt2.append(t, sub);
      row.append(a, txt2, tag);
      row.onclick = () => openChannel(app, { info: ch });
      chBox.append(row);
    }
    resultsBox.append(chBox);

    const list: Short[] = res.results.map((r) => ({
      id: r.id, t: r.t, p: r.p, v: r.v, l: r.l, c: r.c, o: 0, e: 0, tr: 0, r: 0,
      ch: app.ensureChannel(r.ch),
    }));
    const play = (i: number) => app.playList(`YouTube: ${res.q}`, list, i, () => reopen("youtube"));
    resultsBox.append(btn("▶ Play all", () => play(0), "btn sm primary"));
    resultsBox.append(shortGrid(app, list, play, {
      showChannel: true,
      badge: (sh) => (listStatus(app.ds.channels[sh.ch].h, app.ds.channels[sh.ch].id) === "listed" ? "" : "New channel"),
    }));
  });
}
