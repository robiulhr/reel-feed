/**
 * The feed's filters, phone-first:
 * - top bar: [⚙ Filters] + one short row of quick chips (All · your active filters · the biggest topics · More)
 * - Filters sheet: time range, language and every topic (grouped, with counts), applied with "Show N Shorts".
 */
import { CATEGORIES, type CatId, catInfo, GROUPS, groupOf, type Lang, PERSONAL_GROUP } from "./categories";
import { el } from "./dom";
import { app, feed, resetFeed } from "./feed";
import { feedFilter, videoCats } from "./rank";
import { persist, state } from "./store";
import type { Win } from "./types";
import { confirmDialog } from "./ui";
import { els } from "./view";

export const WINS: [Win, string][] = [
  ["all", "All time"],
  ["30", "30 days"],
  ["7", "7 days"],
  ["1", "Today"],
];
export const LANG_OPTS: [Lang | "all", string][] = [
  ["all", "All"],
  ["bn", "বাংলা"],
  ["en", "English"],
  ["hi", "हिन्दी/اردو"],
];
/** How many topic chips sit in the top bar (the rest are one tap away under More). */
const QUICK = 6;

type Draft = { win: Win; lang: Lang | "all"; cats: CatId[] };

/** Islamic and other topics don't mix: picking one kind starts a fresh pick. */
export function toggleCat(cats: CatId[], cat: CatId): CatId[] {
  if (cats.includes(cat)) return cats.filter((c) => c !== cat);
  if (cats.length && (groupOf(cat) === PERSONAL_GROUP) !== (groupOf(cats[0]) === PERSONAL_GROUP)) return [cat];
  return [...cats, cat];
}

/** Shorts per topic (any of its categories) for a time range + language. */
function topicCounts(d: Pick<Draft, "win" | "lang">) {
  const pass = feedFilter(feed.ds, { ...state, win: d.win, lang: d.lang, cats: [...CATEGORIES.map((c) => c.id)] });
  const counts = new Map<CatId, number>();
  for (const s of feed.ds.videos) if (pass(s)) for (const c of videoCats(s, state)) counts.set(c, (counts.get(c) ?? 0) + 1);
  return counts;
}

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));
const winLabel = (w: Win) => WINS.find(([k]) => k === w)![1];
const langLabel = (l: Lang | "all") => LANG_OPTS.find(([k]) => k === l)![1];

function apply(d: Draft) {
  state.win = d.win;
  state.lang = d.lang;
  state.cats = d.cats;
  persist();
  renderFilterBar();
  resetFeed();
}

// ---------- top bar ----------
let countsKey = "";
let quickOrder: CatId[] = [];

/** [⚙ Filters •n] + All · active time/language (tap ✕ to clear) · picked topics · biggest topics · More */
export function renderFilterBar() {
  const active = (state.win !== "all" ? 1 : 0) + (state.lang !== "all" ? 1 : 0) + state.cats.length;
  els.filtBtn.querySelector(".filt-n")!.textContent = active ? String(active) : "";
  els.filtBtn.setAttribute("aria-label", active ? `Filters, ${active} on` : "Filters");
  els.filtBtn.classList.toggle("on", active > 0);

  // biggest topics for this time range + language (order only changes when those do, so chips don't jump)
  const key = `${feed.ds.generatedAt}|${state.win}|${state.lang}`;
  if (key !== countsKey) {
    countsKey = key;
    const counts = topicCounts(state);
    quickOrder = CATEGORIES.filter((c) => c.group !== PERSONAL_GROUP && (counts.get(c.id) ?? 0) >= 8)
      .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))
      .map((c) => c.id);
  }
  const chip = (label: string, data: Record<string, string>, on: boolean, aria?: string) => {
    const b = el("button", on ? "on" : "", label);
    b.type = "button";
    Object.assign(b.dataset, data);
    if (data.cat !== undefined) b.setAttribute("aria-pressed", String(on));
    if (aria) b.setAttribute("aria-label", aria);
    return b;
  };
  const out: HTMLElement[] = [chip("All", { cat: "" }, !state.cats.length, "All topics")];
  if (state.win !== "all") out.push(chip(`${winLabel(state.win)} ✕`, { clear: "win" }, true, `${winLabel(state.win)}. Remove`));
  if (state.lang !== "all") out.push(chip(`${langLabel(state.lang)} ✕`, { clear: "lang" }, true, `${langLabel(state.lang)}. Remove`));
  const shown = [...state.cats, ...quickOrder.filter((c) => !state.cats.includes(c)).slice(0, Math.max(0, QUICK - state.cats.length))];
  for (const c of shown) out.push(chip(catInfo(c)!.short, { cat: c }, state.cats.includes(c), catInfo(c)!.label));
  out.push(chip("More topics…", { more: "1" }, false));
  els.chips.replaceChildren(...out);
}

export function bindFilterBar() {
  els.chips.setAttribute("role", "group");
  els.chips.setAttribute("aria-label", "Quick filters");
  els.filtBtn.onclick = () => openFilters();
  els.chips.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.dataset.more) return void openFilters(true);
    if (b.dataset.clear === "win") return apply({ ...state, win: "all" });
    if (b.dataset.clear === "lang") return apply({ ...state, lang: "all" });
    if (b.dataset.cat === undefined) return;
    const cat = b.dataset.cat as CatId | "";
    if (!cat && !state.cats.length) return;
    apply({ ...state, cats: cat ? toggleCat(state.cats, cat) : [] });
  });
}

// ---------- the Filters sheet ----------
export async function openFilters(toTopics = false) {
  const d: Draft = { win: state.win, lang: state.lang, cats: [...state.cats] };
  const box = el("div", "filt");
  let confirmBtn: HTMLButtonElement | null = null;

  const seg = <T extends string>(label: string, opts: [T, string][], get: () => T, set: (v: T) => void) => {
    const wrap = el("div", "filt-sec");
    wrap.append(el("div", "filt-head", label));
    const row = el("div", "filt-seg");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", label);
    for (const [v, text] of opts) {
      const b = el("button", "", text);
      b.type = "button";
      b.dataset.v = v;
      b.onclick = () => {
        set(v);
        update();
      };
      row.append(b);
    }
    wrap.append(row);
    return { wrap, row, get };
  };
  const time = seg(
    "Time",
    WINS,
    () => d.win,
    (v) => (d.win = v),
  );
  const lang = seg(
    "Language",
    LANG_OPTS,
    () => d.lang,
    (v) => (d.lang = v),
  );

  const topics = el("div", "filt-sec");
  const topHead = el("div", "filt-head filt-head-row");
  const clear = el("button", "filt-link", "Clear topics");
  clear.type = "button";
  clear.onclick = () => {
    d.cats = [];
    update();
  };
  topHead.append(el("span", "", "Topics"), clear);
  topics.append(topHead, el("p", "filt-hint", "Pick one or more. Islamic topics are kept out of All — pick them to watch."));
  const topicBtns = new Map<CatId, HTMLButtonElement>();
  for (const g of GROUPS) {
    topics.append(el("div", "filt-group", g.label));
    const grid = el("div", "filt-grid");
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", g.label);
    for (const c of CATEGORIES.filter((x) => x.group === g.id)) {
      const b = el("button", "filt-topic");
      b.type = "button";
      b.append(el("span", "ft-name", c.label), el("span", "ft-n"));
      b.onclick = () => {
        d.cats = toggleCat(d.cats, c.id);
        update();
      };
      topicBtns.set(c.id, b);
      grid.append(b);
    }
    topics.append(grid);
  }

  const reset = el("button", "filt-link", "Reset all");
  reset.type = "button";
  reset.onclick = () => {
    Object.assign(d, { win: "all", lang: "all", cats: [] });
    update();
  };
  box.append(reset, time.wrap, lang.wrap, topics);

  function update() {
    for (const s of [time, lang])
      s.row.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
        const on = b.dataset.v === s.get();
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    const counts = topicCounts(d);
    for (const [id, b] of topicBtns) {
      const n = counts.get(id) ?? 0;
      const on = d.cats.includes(id);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.disabled = !on && n === 0;
      b.querySelector(".ft-n")!.textContent = short(n);
      b.setAttribute("aria-label", `${catInfo(id)!.label}, ${n} Shorts`);
    }
    clear.hidden = !d.cats.length;
    const total = feed.ds.videos.filter(feedFilter(feed.ds, { ...state, ...d })).length;
    if (confirmBtn) {
      confirmBtn.textContent = total ? `Show ${app.fmt(total)} Shorts` : "Nothing matches";
      confirmBtn.disabled = !total;
    }
  }

  const ok = await confirmDialog({
    title: "Filters",
    extra: box,
    confirm: "Show",
    variant: "sheet",
    onOpen: (yes) => {
      confirmBtn = yes;
      update();
      if (toTopics) topics.scrollIntoView({ block: "start" });
    },
  });
  if (ok) apply(d);
}
