/**
 * The search engine behind the search page (search.ts): finds videos, notes and topics for the words you
 * typed. No screen code here, so it can be tested on its own.
 */
import type { AppApi } from "./app";
import { catLabel } from "./categories";
import { type Note, state } from "./store";
import type { Topic } from "./topicdata";
import type { Short } from "./types";

// ---------- the engine (no screen: tested on its own) ----------
/** Lower-case words, in any script (Bangla too). */
export const wordsOf = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);

type Pool = { words: string[]; w: number };
const W = { title: 3, note: 2.5, topic: 2, maker: 1.5 };

/** How well every word you typed matches in the pools (0 = some word matches nowhere). */
function scoreOf(tokens: string[], pools: Pool[]): number {
  let total = 0;
  for (const tok of tokens) {
    let best = 0;
    for (const p of pools) {
      for (const w of p.words) {
        if (w === tok) best = Math.max(best, p.w * 1.5);
        else if (w.startsWith(tok)) best = Math.max(best, p.w);
      }
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}

const noteWords = new WeakMap<Note, string[]>();
const wordsOfNote = (n: Note) => {
  let w = noteWords.get(n);
  if (!w) noteWords.set(n, (w = wordsOf(`${n.x} ${n.ti}`)));
  return w;
};
const staticWords = new WeakMap<Short, string[]>();
function makerAndCats(app: Pick<AppApi, "ds">, s: Short): string[] {
  let w = staticWords.get(s);
  if (!w) {
    const maker = s.fb ? (state.fbPages.find((p) => p.key === s.fb!.by)?.name ?? "Facebook") : (app.ds.channels[s.ch]?.n ?? "");
    staticWords.set(s, (w = wordsOf(`${maker} ${s.k.map(catLabel).join(" ")}`)));
  }
  return w;
}

export type Only = "all" | "saved" | "notes" | "fb" | "yt";

/** Videos in your library that match, best first. */
export function searchVideos(app: Pick<AppApi, "ds">, q: string, only: Only = "all"): Short[] {
  const tokens = wordsOf(q);
  if (!tokens.length) return [];
  const topicNames = new Map<string, string[]>(); // video id → words of the topics it's pinned in
  for (const t of state.topics) for (const v of t.vids) topicNames.set(v.id, [...(topicNames.get(v.id) ?? []), ...wordsOf(t.name)]);
  const saved = new Set(state.saved);
  const hits: { s: Short; score: number }[] = [];
  for (const s of app.ds.videos) {
    if (app.ds.channels[s.ch]?.st === "removed") continue;
    if (only === "saved" && !saved.has(s.id)) continue;
    if (only === "notes" && !state.notes[s.id]) continue;
    if (only === "fb" && !s.fb) continue;
    if (only === "yt" && s.fb) continue;
    const pools: Pool[] = [
      { words: wordsOf(s.t), w: W.title },
      { words: makerAndCats(app, s), w: W.maker },
    ];
    const n = state.notes[s.id];
    if (n) pools.push({ words: wordsOfNote(n), w: W.note });
    const tn = topicNames.get(s.id);
    if (tn) pools.push({ words: tn, w: W.topic });
    const score = scoreOf(tokens, pools);
    if (score) hits.push({ s, score: score + Math.log10(s.v + 10) * 0.05 });
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.s);
}

/** Topics that match: name, why, search words or notes. */
export function searchTopics(q: string): Topic[] {
  const tokens = wordsOf(q);
  if (!tokens.length) return [];
  return state.topics
    .map((t) => ({
      t,
      score: scoreOf(tokens, [
        { words: wordsOf(t.name), w: W.title },
        { words: wordsOf(`${t.why} ${t.kw.join(" ")}`), w: W.maker },
        { words: wordsOf(t.notes.map((n) => n.x).join(" ")), w: W.note },
      ]),
    }))
    .filter((r) => r.score)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.t);
}

/** Your notes that match (the note's words or its video's title). */
export function searchNotes(q: string): [string, Note][] {
  const tokens = wordsOf(q);
  if (!tokens.length) return [];
  return Object.entries(state.notes)
    .map(([id, n]) => ({ id, n, score: scoreOf(tokens, [{ words: wordsOfNote(n), w: W.note }]) }))
    .filter((r) => r.score)
    .sort((a, b) => b.score - a.score || b.n.at - a.n.at)
    .map((r) => [r.id, r.n]);
}
