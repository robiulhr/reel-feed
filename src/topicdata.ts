/**
 * Topics: subjects you're researching (a name, why, search words, pinned videos, notes, links).
 * The data and its rules — pure functions, so the store, the tests and the page share one meaning.
 * Every change is a small operation (see TopicOp) so two devices editing the same topic merge instead
 * of one overwriting the other.
 */

export type TopicStatus = "idea" | "researching" | "ready" | "made";
export const TOPIC_STATUSES: { id: TopicStatus; label: string }[] = [
  { id: "idea", label: "Idea" },
  { id: "researching", label: "Researching" },
  { id: "ready", label: "Ready to make" },
  { id: "made", label: "Made" },
];

export interface TopicVideo {
  id: string; // a video's feed id
  at: number; // when pinned (unix seconds)
  ti: string; // its title then (so the topic reads well even if the video leaves the library)
}
export interface TopicNote {
  i: string; // unique id
  x: string; // the text
  at: number;
}
export interface TopicLink {
  i: string;
  u: string; // address
  x: string; // what it is, in your words
  at: number;
}
export interface Topic {
  id: string;
  name: string;
  why: string; // the angle: why you're researching this
  st: TopicStatus;
  kw: string[]; // search words: finding videos in your library and on YouTube
  vids: TopicVideo[]; // pinned, newest first
  no: string[]; // "not about this": videos the automatic matching must leave out
  notes: TopicNote[]; // newest first
  links: TopicLink[]; // newest first
  at: number; // created
  up: number; // last changed (the newer one wins when two devices both changed the name, status, …)
}

export const MAX_TOPICS = 300;
export const MAX_TOPIC_VIDEOS = 500;
export const MAX_TOPIC_NOTES = 300;
export const MAX_TOPIC_LINKS = 100;
export const MAX_TOPIC_NOTE = 5000;
export const MAX_KEYWORDS = 12;

export type TopicOp =
  | { t: "topicNew"; p: Topic }
  | { t: "topicSet"; id: string; name: string; why: string; st: TopicStatus; kw: string[]; up: number }
  | { t: "topicDrop"; id: string }
  | { t: "topicVid"; id: string; v: string; m: "pin" | "unpin" | "skip" | "unskip"; at: number; ti?: string }
  | { t: "topicNote"; id: string; n: TopicNote } // empty text = delete that note
  | { t: "topicLink"; id: string; l: TopicLink }; // empty address = delete that link

const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const STATUS = new Set<string>(TOPIC_STATUSES.map((s) => s.id));

/** Search words: lower case, one space between words, no duplicates. */
export function normKeywords(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const k of x) {
    const w = str(k, 60).toLowerCase().replace(/\s+/g, " ");
    if (w && !out.includes(w)) out.push(w);
  }
  return out.slice(0, MAX_KEYWORDS);
}

const byNewest = <T extends { at: number }>(a: T, b: T) => b.at - a.at;

/** Cleans one topic from any source (a file, a backup). Returns null if it isn't one. */
export function normTopic(x: any): Topic | null {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !x.id || x.id.length > 40) return null;
  const name = str(x.name, 120);
  if (!name) return null;
  const seen = new Set<string>();
  const vids: TopicVideo[] = [];
  for (const v of Array.isArray(x.vids) ? x.vids : []) {
    if (!v || typeof v.id !== "string" || !v.id || v.id.length > 40 || seen.has(v.id)) continue;
    seen.add(v.id);
    vids.push({ id: v.id, at: num(v.at), ti: str(v.ti, 200) });
  }
  const noteIds = new Set<string>();
  const notes: TopicNote[] = [];
  for (const n of Array.isArray(x.notes) ? x.notes : []) {
    const text = str(n?.x, MAX_TOPIC_NOTE);
    if (!text || typeof n.i !== "string" || !n.i || noteIds.has(n.i)) continue;
    noteIds.add(n.i);
    notes.push({ i: n.i.slice(0, 40), x: text, at: num(n.at) });
  }
  const linkIds = new Set<string>();
  const links: TopicLink[] = [];
  for (const l of Array.isArray(x.links) ? x.links : []) {
    const u = str(l?.u, 500);
    if (!u || typeof l.i !== "string" || !l.i || linkIds.has(l.i)) continue;
    linkIds.add(l.i);
    links.push({ i: l.i.slice(0, 40), u, x: str(l.x, 300), at: num(l.at) });
  }
  return {
    id: x.id,
    name,
    why: str(x.why, 1000),
    st: STATUS.has(x.st) ? x.st : "researching",
    kw: normKeywords(x.kw),
    vids: vids.sort(byNewest).slice(0, MAX_TOPIC_VIDEOS),
    no: [
      ...new Set<string>(
        (Array.isArray(x.no) ? x.no : []).filter((v: unknown) => typeof v === "string" && v).map((v: string) => v.slice(0, 40)),
      ),
    ].slice(0, 2000),
    notes: notes.sort(byNewest).slice(0, MAX_TOPIC_NOTES),
    links: links.sort(byNewest).slice(0, MAX_TOPIC_LINKS),
    at: num(x.at),
    up: num(x.up) || num(x.at),
  };
}

export function normTopics(x: unknown): Topic[] {
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  const out: Topic[] = [];
  for (const t of x) {
    const p = normTopic(t);
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out.sort((a, b) => b.up - a.up).slice(0, MAX_TOPICS);
}

export const topicById = (topics: Topic[], id: string) => topics.find((t) => t.id === id);

/** Applies one topic operation to the list (in place). Unknown topics and repeats are ignored. */
export function applyTopicOp(topics: Topic[], op: TopicOp) {
  if (op.t === "topicNew") {
    const p = normTopic(op.p);
    if (p && !topicById(topics, p.id) && topics.length < MAX_TOPICS) topics.unshift(p);
    return;
  }
  const i = topics.findIndex((t) => t.id === op.id);
  if (i < 0) return;
  const tp = topics[i];
  switch (op.t) {
    case "topicDrop":
      topics.splice(i, 1);
      return;
    case "topicSet": {
      if (op.up < tp.up) return; // a newer change from another device stays
      const name = str(op.name, 120);
      if (name) tp.name = name;
      tp.why = str(op.why, 1000);
      if (STATUS.has(op.st)) tp.st = op.st;
      tp.kw = normKeywords(op.kw);
      tp.up = op.up;
      break;
    }
    case "topicVid": {
      const has = tp.vids.findIndex((v) => v.id === op.v);
      if (op.m === "pin") {
        if (has < 0 && tp.vids.length < MAX_TOPIC_VIDEOS) tp.vids.unshift({ id: op.v, at: op.at, ti: str(op.ti, 200) });
        tp.no = tp.no.filter((v) => v !== op.v); // pinning means it IS about this
      } else if (op.m === "unpin") {
        if (has >= 0) tp.vids.splice(has, 1);
      } else if (op.m === "skip") {
        if (!tp.no.includes(op.v) && tp.no.length < 2000) tp.no.push(op.v);
        if (has >= 0) tp.vids.splice(has, 1);
      } else {
        tp.no = tp.no.filter((v) => v !== op.v);
      }
      tp.up = Math.max(tp.up, op.at);
      break;
    }
    case "topicNote": {
      const j = tp.notes.findIndex((n) => n.i === op.n.i);
      const text = str(op.n.x, MAX_TOPIC_NOTE);
      if (j >= 0 && tp.notes[j].at > op.n.at) return; // the newer text (from another device) stays
      if (!text) {
        if (j >= 0) tp.notes.splice(j, 1);
      } else if (j >= 0) tp.notes[j] = { i: op.n.i, x: text, at: op.n.at };
      else if (tp.notes.length < MAX_TOPIC_NOTES) tp.notes = [{ i: op.n.i, x: text, at: op.n.at }, ...tp.notes].sort(byNewest);
      tp.up = Math.max(tp.up, op.n.at);
      break;
    }
    case "topicLink": {
      const j = tp.links.findIndex((l) => l.i === op.l.i);
      const u = str(op.l.u, 500);
      if (!u) {
        if (j >= 0) tp.links.splice(j, 1);
      } else if (j >= 0) tp.links[j] = { i: op.l.i, u, x: str(op.l.x, 300), at: op.l.at };
      else if (tp.links.length < MAX_TOPIC_LINKS)
        tp.links = [{ i: op.l.i, u, x: str(op.l.x, 300), at: op.l.at }, ...tp.links].sort(byNewest);
      tp.up = Math.max(tp.up, op.l.at);
      break;
    }
  }
  topics.sort((a, b) => b.up - a.up);
}

/** Adds what `from` has and `into` lacks (a restore that keeps what was added since, or a first sync). */
export function mergeTopics(into: Topic[], from: unknown) {
  for (const p of normTopics(from)) {
    if (!topicById(into, p.id)) {
      applyTopicOp(into, { t: "topicNew", p });
      continue;
    }
    applyTopicOp(into, { t: "topicSet", id: p.id, name: p.name, why: p.why, st: p.st, kw: p.kw, up: p.up });
    for (const v of [...p.vids].reverse()) applyTopicOp(into, { t: "topicVid", id: p.id, v: v.id, m: "pin", at: v.at, ti: v.ti });
    // "not about this" marks are added, but never undo a pin that is already here
    for (const v of p.no)
      if (!topicById(into, p.id)?.vids.some((x) => x.id === v)) applyTopicOp(into, { t: "topicVid", id: p.id, v, m: "skip", at: p.up });
    for (const n of p.notes) applyTopicOp(into, { t: "topicNote", id: p.id, n });
    for (const l of p.links) applyTopicOp(into, { t: "topicLink", id: p.id, l });
  }
}

/** A short unique id for a topic, a note or a link. */
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
