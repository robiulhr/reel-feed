/**
 * The feed's filters, phone-first:
 * - top bar: [⚙ Filters] + one short row of quick chips (All · your active filters · the biggest main categories · More)
 * - Filters sheet: time range, views, language and every main category with its topics (with counts), applied with
 *   "Show N Shorts". Tapping a main category picks all its topics; each topic can also be picked on its own.
 */
import { CATEGORIES, type CatId, catInfo, GROUPS, type GroupId, groupCats, groupOf, isPersonalGroup, type Lang } from "./categories";
import { el } from "./dom";
import { app, feed, resetFeed } from "./feed";
import { feedFilter, videoCats } from "./rank";
import { persist, state } from "./store";
import type { Win } from "./types";
import { confirmDialog, toast } from "./ui";
import { listById, listLabel, listSize, manageLists } from "./lists";
import { els } from "./view";

export const WINS: [Win, string][] = [
  ["all", "All time"],
  ["365", "1 year"],
  ["90", "3 months"],
  ["30", "30 days"],
  ["7", "7 days"],
  ["1", "Today"],
];
/** "Fewest views" choices, as text (the filter stores the number). */
export const VIEW_OPTS: [string, string][] = [
  ["0", "Any views"],
  ["1000", "1K+"],
  ["10000", "10K+"],
  ["100000", "100K+"],
  ["1000000", "1M+"],
];
export const LANG_OPTS: [Lang | "all", string][] = [
  ["all", "All"],
  ["bn", "বাংলা"],
  ["en", "English"],
  ["hi", "हिन्दी/اردو"],
];
/** How many category chips sit in the top bar (the rest are one tap away under More). */
const QUICK = 5;

type Draft = { win: Win; minV: number; lang: Lang | "all"; cats: CatId[]; list: string };
const isIslamic = (c: CatId) => isPersonalGroup(groupOf(c));

/** Islamic/Learn and other topics don't mix: picking one kind starts a fresh pick. */
function addCats(cats: CatId[], add: CatId[]): CatId[] {
  if (cats.length && isIslamic(add[0]) !== isIslamic(cats[0])) return [...add];
  return [...cats, ...add.filter((c) => !cats.includes(c))];
}
export function toggleCat(cats: CatId[], cat: CatId): CatId[] {
  return cats.includes(cat) ? cats.filter((c) => c !== cat) : addCats(cats, [cat]);
}
/** A main category: all its topics on, or (when all are already on) all off. */
export function toggleGroup(cats: CatId[], g: GroupId): CatId[] {
  const sub = groupCats(g);
  return sub.every((c) => cats.includes(c)) ? cats.filter((c) => !sub.includes(c)) : addCats(cats, sub);
}
export const groupState = (cats: CatId[], g: GroupId): "all" | "some" | "none" => {
  const n = groupCats(g).filter((c) => cats.includes(c)).length;
  return n === 0 ? "none" : n === groupCats(g).length ? "all" : "some";
};

/** Shorts per topic and per main category (any of the Short's categories) for a time range + views + language. */
function counts(d: Pick<Draft, "win" | "minV" | "lang" | "list">) {
  const pass = feedFilter(feed.ds, {
    ...state,
    win: d.win,
    minV: d.minV,
    lang: d.lang,
    list: d.list,
    cats: [...CATEGORIES.map((c) => c.id)],
  });
  const cat = new Map<CatId, number>();
  const group = new Map<GroupId, number>();
  for (const s of feed.ds.videos) {
    if (!pass(s)) continue;
    const ks = videoCats(s, state);
    for (const c of ks) cat.set(c, (cat.get(c) ?? 0) + 1);
    for (const g of new Set(ks.map(groupOf))) if (g) group.set(g, (group.get(g) ?? 0) + 1);
  }
  return { cat, group };
}

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n));
const winLabel = (w: Win) => WINS.find(([k]) => k === w)![1];
const viewsLabel = (n: number) => `${VIEW_OPTS.find(([k]) => k === String(n))?.[1] ?? short(n)} views`;
const langLabel = (l: Lang | "all") => LANG_OPTS.find(([k]) => k === l)![1];

function apply(d: Draft) {
  state.win = d.win;
  state.minV = d.minV;
  state.lang = d.lang;
  state.cats = d.cats;
  state.list = d.list;
  persist();
  renderFilterBar();
  resetFeed();
}

// ---------- top bar ----------
let countsKey = "";
let quickOrder: GroupId[] = [];

/** [⚙ Filters •n] + All · active time/language (✕) · what you picked · biggest main categories · More */
export function renderFilterBar() {
  const active =
    (state.win !== "all" ? 1 : 0) +
    (state.minV ? 1 : 0) +
    (state.lang !== "all" ? 1 : 0) +
    (state.cats.length ? 1 : 0) +
    (state.list ? 1 : 0);
  els.filtBtn.querySelector(".filt-n")!.textContent = active ? String(active) : "";
  els.filtBtn.setAttribute("aria-label", active ? `Filters, ${active} on` : "Filters");
  els.filtBtn.classList.toggle("on", active > 0);

  // biggest main categories for this time range + language (order only changes with those, so chips don't jump)
  const key = `${feed.ds.generatedAt}|${state.win}|${state.minV}|${state.lang}|${state.list}|${state.lists.map((l) => listSize(l)).join()}`;
  if (key !== countsKey) {
    countsKey = key;
    const n = counts(state).group;
    quickOrder = GROUPS.filter((g) => !isPersonalGroup(g.id) && (n.get(g.id) ?? 0) >= 8)
      .sort((a, b) => (n.get(b.id) ?? 0) - (n.get(a.id) ?? 0))
      .map((g) => g.id);
  }
  const chip = (label: string, data: Record<string, string>, on: boolean, aria?: string) => {
    const b = el("button", on ? "on" : "", label);
    b.type = "button";
    Object.assign(b.dataset, data);
    if (!data.clear && !data.more) b.setAttribute("aria-pressed", String(on));
    if (aria) b.setAttribute("aria-label", aria);
    return b;
  };
  const out: HTMLElement[] = [chip("All", { cat: "" }, !state.cats.length, "All categories")];
  // your channel lists (Competitors, Inspiration…): each is a feed of its own
  const curList = state.list ? listById(state.list) : undefined;
  if (curList) out.push(chip(`${listLabel(curList)} ✕`, { list: "" }, true, `${curList.name} feed. Back to all channels`));
  for (const l of state.lists) if (l !== curList && listSize(l)) out.push(chip(listLabel(l), { list: l.id }, false, `${l.name} feed`));
  if (state.win !== "all") out.push(chip(`${winLabel(state.win)} ✕`, { clear: "win" }, true, `${winLabel(state.win)}. Remove`));
  if (state.minV) out.push(chip(`${viewsLabel(state.minV)} ✕`, { clear: "minV" }, true, `${viewsLabel(state.minV)}. Remove`));
  if (state.lang !== "all") out.push(chip(`${langLabel(state.lang)} ✕`, { clear: "lang" }, true, `${langLabel(state.lang)}. Remove`));
  // what you picked: a whole main category shows as one chip, single topics as their own chips
  const pickedGroups: GroupId[] = [];
  for (const g of GROUPS) {
    const st = groupState(state.cats, g.id);
    if (st === "all") {
      pickedGroups.push(g.id);
      out.push(chip(`${g.icon} ${g.label}`, { group: g.id }, true, g.label));
    } else if (st === "some")
      for (const c of groupCats(g.id).filter((x) => state.cats.includes(x)))
        out.push(chip(catInfo(c)!.short, { cat: c }, true, catInfo(c)!.label));
  }
  const room = Math.max(0, QUICK - (out.length - 1));
  for (const g of quickOrder.filter((x) => groupState(state.cats, x) === "none").slice(0, room)) {
    const info = GROUPS.find((x) => x.id === g)!;
    out.push(chip(`${info.icon} ${info.label}`, { group: g }, false, info.label));
  }
  out.push(chip("More…", { more: "1" }, false, "More… all categories and topics"));
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
    if (b.dataset.list !== undefined) return apply({ ...state, list: b.dataset.list });
    if (b.dataset.clear === "win") return apply({ ...state, win: "all" });
    if (b.dataset.clear === "minV") return apply({ ...state, minV: 0 });
    if (b.dataset.clear === "lang") return apply({ ...state, lang: "all" });
    if (b.dataset.group) return apply({ ...state, cats: toggleGroup(state.cats, b.dataset.group as GroupId) });
    if (b.dataset.cat === undefined) return;
    const cat = b.dataset.cat as CatId | "";
    if (!cat && !state.cats.length) return;
    apply({ ...state, cats: cat ? toggleCat(state.cats, cat) : [] });
  });
}

// ---------- the Filters sheet ----------
export async function openFilters(toTopics = false) {
  const d: Draft = { win: state.win, minV: state.minV, lang: state.lang, cats: [...state.cats], list: state.list };
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
  const views = seg(
    "Views",
    VIEW_OPTS,
    () => String(d.minV),
    (v) => (d.minV = Number(v)),
  );
  const lang = seg(
    "Language",
    LANG_OPTS,
    () => d.lang,
    (v) => (d.lang = v),
  );

  // ---- channel lists
  const lists = el("div", "filt-sec");
  const listHead = el("div", "filt-head filt-head-row");
  const editLists = el("button", "filt-link", "Edit lists");
  editLists.type = "button";
  editLists.onclick = async () => {
    await manageLists((h) => feed.ds.channels.find((c) => c.h.toLowerCase() === h.toLowerCase())?.n ?? h);
    if (d.list && !listById(d.list)) d.list = "";
    renderListBtns();
    update();
  };
  listHead.append(el("span", "", "Channel lists"), editLists);
  const listRow = el("div", "filt-seg filt-lists");
  listRow.setAttribute("role", "group");
  listRow.setAttribute("aria-label", "Channel lists");
  lists.append(
    listHead,
    el("p", "filt-hint", "A feed of just the channels in a list. Add channels from a channel's page or the ⋯ menu."),
    listRow,
  );
  function renderListBtns() {
    listRow.replaceChildren();
    for (const l of [{ id: "", name: "All channels", icon: "", ch: [] as string[] }, ...state.lists]) {
      const b = el("button", "", l.id ? `${listLabel(l)} · ${listSize(l)}` : l.name);
      b.type = "button";
      b.dataset.v = l.id;
      b.onclick = () => {
        if (l.id && !listSize(l)) return void toast(`Nothing in ${l.name} yet — add channels from a channel's page or the ⋯ menu`);
        d.list = l.id;
        update();
      };
      listRow.append(b);
    }
  }
  renderListBtns();

  const topics = el("div", "filt-sec");
  const topHead = el("div", "filt-head filt-head-row");
  const clear = el("button", "filt-link", "Clear");
  clear.type = "button";
  clear.onclick = () => {
    d.cats = [];
    update();
  };
  topHead.append(el("span", "", "Categories"), clear);
  topics.append(
    topHead,
    el(
      "p",
      "filt-hint",
      "Tap a category for all its topics, or pick single topics. Islamic and Learn are kept out of All — pick them to watch.",
    ),
  );
  const mainBtns = new Map<GroupId, HTMLButtonElement>();
  const topicBtns = new Map<CatId, HTMLButtonElement>();
  for (const g of GROUPS) {
    const card = el("div", "filt-card");
    const main = el("button", "filt-main");
    main.type = "button";
    main.append(el("span", "fm-ico", g.icon), el("span", "fm-name", g.label), el("span", "fm-n"), el("span", "fm-tick"));
    main.querySelector(".fm-ico")!.setAttribute("aria-hidden", "true");
    main.querySelector(".fm-tick")!.setAttribute("aria-hidden", "true");
    main.onclick = () => {
      d.cats = toggleGroup(d.cats, g.id);
      update();
    };
    mainBtns.set(g.id, main);
    card.append(main);
    const sub = groupCats(g.id);
    if (sub.length > 1) {
      const grid = el("div", "filt-grid");
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", `${g.label} topics`);
      for (const id of sub) {
        const b = el("button", "filt-topic");
        b.type = "button";
        b.append(el("span", "ft-name", catInfo(id)!.label), el("span", "ft-n"));
        b.onclick = () => {
          d.cats = toggleCat(d.cats, id);
          update();
        };
        topicBtns.set(id, b);
        grid.append(b);
      }
      card.append(grid);
    }
    topics.append(card);
  }

  const reset = el("button", "filt-link", "Reset all");
  reset.type = "button";
  reset.onclick = () => {
    Object.assign(d, { win: "all", minV: 0, lang: "all", cats: [], list: "" });
    update();
  };
  box.append(reset, lists, time.wrap, views.wrap, lang.wrap, topics);

  function update() {
    listRow.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      const on = b.dataset.v === d.list;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    for (const s of [time, views, lang])
      s.row.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
        const on = b.dataset.v === s.get();
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    const n = counts(d);
    for (const [g, b] of mainBtns) {
      const st = groupState(d.cats, g);
      const total = n.group.get(g) ?? 0;
      b.classList.toggle("on", st === "all");
      b.classList.toggle("some", st === "some");
      b.setAttribute("aria-pressed", st === "all" ? "true" : st === "some" ? "mixed" : "false");
      b.disabled = st === "none" && total === 0;
      b.querySelector(".fm-n")!.textContent = short(total);
      b.querySelector(".fm-tick")!.textContent = st === "all" ? "✓" : st === "some" ? "–" : "";
      b.setAttribute("aria-label", `${GROUPS.find((x) => x.id === g)!.label}, ${total} Shorts`);
    }
    for (const [id, b] of topicBtns) {
      const total = n.cat.get(id) ?? 0;
      const on = d.cats.includes(id);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.disabled = !on && total === 0;
      b.querySelector(".ft-n")!.textContent = short(total);
      b.setAttribute("aria-label", `${catInfo(id)!.label}, ${total} Shorts`);
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
