/**
 * Home: a row of Shorts, then the long videos — all under the same filters (the chips and ⚙ Filters at the top).
 * It is a screen of its own at /home; the swipe feed is one tap away (the Shorts tab, or tapping a Short in the
 * row) and the feed has a ⌂ button back. Nothing plays on Home. A bar at the bottom (thumb reach) holds
 * Home · Shorts · Search · Menu; it slides away while you scroll down and returns when you scroll up.
 *
 * Which Short or long video comes first follows the same ranking as the feed (the For You / Trending / … choice),
 * but the row is picked once per set of filters, so it doesn't reshuffle every time you come back.
 */
import { loadLong } from "./data";
import { ago, compact, el } from "./dom";
import { feed, homeHook, playList, resumeFeed } from "./feed";
import { pool } from "./player";
import { buildQueue, feedFilter } from "./rank";
import { go, setBase } from "./router";
import { state } from "./store";
import type { Dataset, Short } from "./types";
import { els, thumb } from "./view";

// ---------- what the app opens on ----------
export type OpenOn = "home" | "feed";
const OPEN_KEY = "rf.openOn";
/** Where the app opens: Home (default) or straight into the Shorts feed. A choice for this device only. */
export const openOn = (): OpenOn => {
  try {
    return localStorage.getItem(OPEN_KEY) === "feed" ? "feed" : "home";
  } catch {
    return "home";
  }
};
export function setOpenOn(v: OpenOn) {
  try {
    localStorage.setItem(OPEN_KEY, v);
  } catch {
    /* storage blocked: the default stays */
  }
}

const ROW_SIZE = 24;
const LONG_PAGE = 30;

let longDs: Dataset | null = null;
let longState: "idle" | "loading" | "none" | "ready" = "idle";
let rowItems: Short[] = [];
let longItems: Short[] = [];
let longShown = LONG_PAGE;
let rowKey = "";
let longKey = "";
let savedTop = 0;
let lastTop = 0;

export const isHome = () => !els.home.hidden;

/** Opens a long video on its own player page (loaded when first needed); ⏮ ⏭ follow `list`. */
function openLong(s: Short, list: Short[]) {
  const ds = longDs;
  if (!ds) return;
  void import("./watch").then((m) => m.openWatch({ s, list, ds }));
}

/** "1:02:03" / "42:10". */
export function lengthLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** What the picks depend on besides the data: the ranking choice and the filters. */
const filtersKey = () =>
  [state.tab, state.win, state.minV, state.lang, state.cats.join(), state.list, state.hidden.length, Object.keys(state.catFix).length].join(
    "|",
  );

function pick(ds: Dataset, n: number): Short[] {
  if (!ds.videos.length) return [];
  // Most viewed and Newest are plain orders: exactly by views / by date (the feed's mixing of channels would break them)
  if (state.tab === "top" || state.tab === "newest") {
    const passes = feedFilter(ds, state);
    const key = state.tab === "top" ? (s: Short) => s.v : (s: Short) => s.p;
    return ds.videos
      .filter(passes)
      .sort((a, b) => key(b) - key(a))
      .slice(0, n);
  }
  return buildQueue(ds, state, { prevVisit: state.prevVisit, exclude: new Set() }, n).items;
}

/**
 * Picks the row and the long list again, each only when its own data or the filters changed (so the row does not
 * reshuffle when the long videos arrive a moment later). Says what changed.
 */
function recompute(): { row: boolean; long: boolean } {
  const f = filtersKey();
  const rk = `${feed.ds.generatedAt}|${feed.ds.videos.length}|${f}`;
  const lk = `${longDs?.generatedAt ?? 0}|${f}`;
  const out = { row: rk !== rowKey, long: lk !== longKey };
  if (out.row) {
    rowKey = rk;
    rowItems = pick(feed.ds, ROW_SIZE);
  }
  if (out.long) {
    longKey = lk;
    longItems = longDs ? pick(longDs, 300) : [];
    longShown = LONG_PAGE;
  }
  return out;
}

/**
 * Tapping a Short plays it, then Shorts like it, one after another — not the rest of the row
 * (that is what "▶ Play all" is for). If the library has few like it, the row's other Shorts fill the rest.
 */
function playSimilar(s: Short, rowIndex: number) {
  void import("./similar").then((m) => {
    const like = m.similarInLibrary({ ds: feed.ds }, s, 40).map((r) => r.short);
    const seen = new Set([s.id, ...like.map((x) => x.id)]);
    const fill = like.length < 8 ? rowItems.filter((x) => !seen.has(x.id)).slice(0, 8 - like.length) : [];
    const list = [s, ...like, ...fill];
    if (list.length < 2) return playList("Home", rowItems, rowIndex);
    playList("More like this", list, 0);
  });
}

// ---------- drawing ----------
function shortCard(s: Short, i: number): HTMLElement {
  const b = el("button", "home-short");
  b.type = "button";
  b.setAttribute("role", "listitem");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  thumb(img, s.id);
  b.append(img, el("span", "home-short-t", s.t), el("span", "home-short-m", `${compact(s.v)} views`));
  b.onclick = () => playSimilar(s, i); // its name is the text on it: title, views
  return b;
}

function longCard(s: Short): HTMLElement {
  const ch = longDs?.channels[s.ch];
  const b = el("button", "home-long-card");
  b.type = "button";
  const box = el("span", "hl-thumb");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  thumb(img, s.id);
  box.append(img);
  if (s.d) box.append(el("span", "hl-dur", lengthLabel(s.d)));
  const meta = [ch?.n, `${compact(s.v)} views`, ago(s.p)].filter(Boolean).join(" · ");
  b.append(box, el("span", "hl-title", s.t), el("span", "hl-meta", meta));
  b.onclick = () => openLong(s, longItems); // its name is the text on it: length, title, channel, views
  return b;
}

const note = (text: string) => el("p", "home-note", text);

function drawRow() {
  if (!rowItems.length) {
    els.homeRow.replaceChildren(note(feed.ds.videos.length ? "No Shorts match these filters." : "Loading Shorts…"));
    els.homeSeeAll.hidden = true;
    return;
  }
  els.homeSeeAll.hidden = false;
  els.homeRow.replaceChildren(...rowItems.map(shortCard));
}

function drawLong() {
  const box = els.homeLong;
  if (longState === "loading") return box.replaceChildren(note("Loading long videos…"));
  if (longState === "none")
    return box.replaceChildren(note("Long videos from your channels will appear here after the next daily update."));
  if (!longItems.length) return box.replaceChildren(note("No long videos match these filters."));
  moreObs?.disconnect();
  box.replaceChildren(...longItems.slice(0, longShown).map(longCard));
  watchEnd();
}

/** The list grows by itself: when you near its end, the next videos are added (no button to tap). */
let moreObs: IntersectionObserver | null = null;
function watchEnd() {
  if (longItems.length <= longShown) return;
  const end = el("div", "home-end");
  end.setAttribute("aria-hidden", "true");
  els.homeLong.append(end);
  moreObs = new IntersectionObserver(
    (hits) => {
      if (!hits.some((h) => h.isIntersecting)) return;
      moreObs?.disconnect();
      end.remove();
      const from = longShown;
      longShown += LONG_PAGE;
      els.homeLong.append(...longItems.slice(from, longShown).map(longCard));
      watchEnd();
    },
    { root: els.homeScroll, rootMargin: "800px 0px" },
  );
  moreObs.observe(end);
}

/** Draws Home (again). Cheap when nothing changed. */
export function renderHome() {
  if (!isHome()) return;
  const changed = recompute();
  if (changed.row) drawRow();
  if (changed.long) drawLong();
  if (changed.row) {
    els.homeScroll.scrollTop = 0; // new filters: start from the top
    savedTop = 0;
  }
  arrows();
}

function ensureLong() {
  if (longState !== "idle" && longState !== "none") return;
  longState = "loading";
  drawLong();
  const arrived = (ds: Dataset | null) => {
    if (ds) longDs = ds;
    longState = longDs ? "ready" : "none";
    if (!isHome()) return;
    const before = longKey;
    renderHome(); // only the long list is drawn again (the row keeps its picks)
    if (before === longKey) drawLong(); // nothing new to pick, but the "loading" note must go
  };
  void loadLong(arrived).then(arrived);
}

// ---------- showing and hiding ----------
const layout = () => els.shell.parentElement as HTMLElement;

export function showHome() {
  const wasOpen = isHome();
  layout().classList.add("is-home");
  els.home.hidden = false;
  els.tabbar.hidden = false;
  homeHook.open = true;
  if (!wasOpen) pool.pause(); // nothing plays behind Home
  els.tabbar.classList.remove("tb-hide");
  renderHome();
  if (!wasOpen) {
    els.homeScroll.scrollTop = savedTop; // a hidden screen forgets where it was scrolled to
    lastTop = savedTop;
  }
  ensureLong();
}

/** Leaves Home without starting anything (a Short is about to be played, or a page opens). */
export function leaveHome() {
  if (!isHome()) return;
  savedTop = els.homeScroll.scrollTop;
  layout().classList.remove("is-home");
  els.home.hidden = true;
  els.tabbar.hidden = true;
  homeHook.open = false;
}

/** The Shorts tab: back to the swipe feed where it was. */
export function openShortsFeed() {
  leaveHome();
  resumeFeed();
}

// ---------- row arrows (wide screens) and the bottom bar ----------
function arrows() {
  const r = els.homeRow;
  const wide = r.scrollWidth > r.clientWidth + 4;
  els.homeRowPrev.hidden = !wide || r.scrollLeft < 8;
  els.homeRowNext.hidden = !wide || r.scrollLeft + r.clientWidth >= r.scrollWidth - 8;
}

export function initHome() {
  setBase(() => (isHome() ? { k: "home" } : { k: "feed" }));
  homeHook.refresh = () => renderHome();
  homeHook.leave = () => {
    leaveHome();
    go({ k: "feed" }, { replace: true }); // the address follows what's on screen
  };
  els.homeSeeAll.onclick = () => rowItems.length && playList("Home", rowItems, 0);
  els.homeBtn.onclick = () => {
    go({ k: "home" });
    showHome();
  };
  const step = () => Math.max(160, Math.round(els.homeRow.clientWidth * 0.8));
  els.homeRowPrev.onclick = () => els.homeRow.scrollBy({ left: -step(), behavior: "smooth" });
  els.homeRowNext.onclick = () => els.homeRow.scrollBy({ left: step(), behavior: "smooth" });
  els.homeRow.addEventListener("scroll", arrows, { passive: true });
  window.addEventListener("resize", arrows);

  els.tabbar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-go]");
    if (!b) return;
    switch (b.dataset.go) {
      case "home":
        els.homeScroll.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "shorts":
        go({ k: "feed" });
        openShortsFeed();
        break;
      case "search":
        els.searchBtn.click();
        break;
      case "menu":
        els.menuBtn.click();
        break;
    }
  });

  // the bar slides away while you scroll down (more room for the videos) and comes back when you scroll up
  els.homeScroll.addEventListener(
    "scroll",
    () => {
      const top = els.homeScroll.scrollTop;
      if (top > lastTop + 12 && top > 80) els.tabbar.classList.add("tb-hide");
      else if (top < lastTop - 8 || top < 40) els.tabbar.classList.remove("tb-hide");
      lastTop = top;
    },
    { passive: true },
  );
}
