/**
 * The feed: which Short is on screen, what comes next, going back, temporary lists
 * (a channel, "More like this", History, Saved), and swapping in newer data.
 */
import { catInfo, normCats } from "./categories";
import { buildQueue, isGuessed, videoCats } from "./rank";
import { act, learn, state } from "./store";
import { openChannel } from "./explore";
import { historyShorts } from "./history";
import { toast } from "./ui";
import { announce } from "./a11y";
import { ago, compact, nowSec } from "./dom";
import { banner, els, setThumb, showEmpty, showSpinner, thumb } from "./view";
import { playback, playerHooks, pool, resetWatch, stopClock } from "./player";
import { closeOverlaysForPlayback, closePage, openPage, renderControls } from "./panels";
import type { AppApi, ExternalChannelInfo } from "./app";
import type { Dataset, Short } from "./types";

export const feed = {
  ds: { generatedAt: 0, units: 0, usage: [], channels: [], videos: [] } as Dataset,
  byId: new Map<string, Short>(),
  libIds: new Set<string>(),
  /** Shorts you've been shown in the main feed (swipe down goes back through these). */
  history: [] as Short[],
  idx: -1,
  queue: [] as Short[],
  cur: null as Short | null,
  /** A temporary list you're swiping through (a channel's Shorts, "More like this", History). null = main feed. */
  ctx: null as { title: string; items: Short[]; i: number; onBack?: () => void } | null,
  /** Newer data downloaded, waiting for you to tap the banner. */
  pendingData: null as Dataset | null,
};

// ---------- learning + history ----------
/** Turn how you watched the current Short into a learning signal + a history entry. */
export function finishCurrent() {
  const cur = feed.cur;
  if (!cur) return;
  stopClock();
  const w = playback.watch;
  const d = pool.duration();
  const dwell = w.playMs / 1000;
  // If you skipped ahead, count only what you actually watched.
  const watchedSec = w.skipped ? Math.min(w.maxT, (w.playMs / 1000) * state.rate) : w.maxT;
  const frac = d ? Math.min(1, watchedSec / d) : 0;
  let delta = 0;
  if (w.loops > 0 || frac >= 0.9) delta = Math.min(2.5, 1 + 0.5 * w.loops);
  else if (frac >= 0.5) delta = 0.5;
  else if (dwell < 3 && frac < 0.3) delta = -1;
  const ch = feed.ds.channels[cur.ch];
  if (ch) learn(ch, videoCats(cur, state)[0], delta);

  if (!state.histPaused && (dwell >= 1 || frac > 0.05)) {
    const f = w.loops > 0 ? 1 : Math.round(frac * 100) / 100;
    act({
      t: "watch",
      item: {
        id: cur.id,
        at: Math.floor(w.shownAt),
        f,
        ...(feed.libIds.has(cur.id) || !ch ? {} : { x: { t: cur.t, n: ch.n, h: ch.h, c: ch.id } }),
      },
    });
  }
  feed.cur = null;
}

// ---------- moving through the feed ----------
function refill() {
  const exclude = new Set([...feed.history.map((s) => s.id), ...feed.queue.map((s) => s.id)]);
  const last = feed.queue.at(-1) ?? feed.history.at(-1);
  const { items, recycled } = buildQueue(feed.ds, state, { prevVisit: state.prevVisit, exclude, lastCh: last?.ch }, 30);
  feed.queue.push(...items);
  if (recycled && items.length) toast("You've seen everything here — showing them again");
}

/** The Short a swipe would bring, without moving there. */
export function upcoming(dir: 1 | -1): Short | undefined {
  const { ctx, history, idx } = feed;
  if (ctx) return ctx.items[ctx.i + dir];
  if (dir === -1) return history[idx - 1];
  if (idx < history.length - 1) return history[idx + 1];
  if (feed.queue.length < 5) refill();
  return feed.queue[0];
}

export function next() {
  const ctx = feed.ctx;
  if (ctx) {
    if (ctx.i >= ctx.items.length - 1) {
      toast("That's the end of this list — tap ← to go back");
      return;
    }
    finishCurrent();
    ctx.i++;
    show(ctx.items[ctx.i]);
    return;
  }
  finishCurrent();
  if (feed.idx < feed.history.length - 1) feed.idx++;
  else {
    if (feed.queue.length < 5) refill();
    const s = feed.queue.shift();
    if (!s) return showEmpty("Nothing matches these filters yet.<br>Try <b>All time</b> or another category.");
    feed.history.push(s);
    feed.idx = feed.history.length - 1;
  }
  show(feed.history[feed.idx]);
}

export function prev() {
  const ctx = feed.ctx;
  if (ctx) {
    if (ctx.i <= 0) return;
    finishCurrent();
    ctx.i--;
    show(ctx.items[ctx.i]);
    return;
  }
  if (feed.idx <= 0) return;
  finishCurrent();
  feed.idx--;
  show(feed.history[feed.idx]);
}

/** Play one Short right now (e.g. "Resume"), then carry on with the feed. */
export function playNow(s: Short) {
  if (feed.ctx) {
    feed.ctx = null;
    renderCtxBar();
  }
  finishCurrent();
  feed.history.splice(feed.idx + 1, 0, s);
  feed.idx++;
  show(s);
}

/** Swipe through a specific list; the main feed waits where you left it. */
export function playList(title: string, items: Short[], start: number, onBack?: () => void) {
  if (!items.length) return;
  for (const s of items) if (!feed.byId.has(s.id)) feed.byId.set(s.id, s); // so saves from this list show in Saved
  finishCurrent();
  closeOverlaysForPlayback();
  feed.ctx = { title, items, i: Math.max(0, Math.min(start, items.length - 1)), onBack };
  renderCtxBar();
  show(feed.ctx.items[feed.ctx.i]);
}

export function exitList() {
  if (!feed.ctx) return;
  const back = feed.ctx.onBack;
  finishCurrent();
  feed.ctx = null;
  renderCtxBar();
  if (feed.history[feed.idx]) show(feed.history[feed.idx]);
  else next();
  back?.();
}

function renderCtxBar() {
  const ctx = feed.ctx;
  els.ctxBar.hidden = !ctx;
  els.row1.hidden = !!ctx;
  els.row2.hidden = !!ctx;
  if (ctx) {
    els.ctxTitle.textContent = ctx.title;
    els.ctxSub.textContent = `${ctx.i + 1} of ${ctx.items.length} · ← back to your feed`;
  }
}

/** Start the main feed over (new filters, refresh). */
export function resetFeed() {
  if (feed.ctx) {
    feed.ctx = null;
    renderCtxBar();
  }
  finishCurrent();
  feed.history = [];
  feed.queue = [];
  feed.idx = -1;
  next();
}

let slowTimer: number | undefined;
playerHooks.onPlaying = () => clearTimeout(slowTimer);
playerHooks.onUnplayable = (code) => {
  if (!feed.cur) return;
  act({ t: "bad", id: feed.cur.id });
  feed.cur = null; // no learning signal — it never played
  showSpinner(false);
  toast(code === 101 || code === 150 ? "Skipped — the creator blocked embedding" : "Skipped — video unavailable");
  next();
};

function show(s: Short) {
  els.empty.hidden = true;
  feed.cur = s;
  resetWatch();
  els.bar.style.width = "0";

  const ch = feed.ds.channels[s.ch];
  // Preloaded video already shows its first frame → no poster needed.
  if (pool.isPrimed(s.id)) els.poster.classList.add("gone");
  else {
    setThumb(els.poster, s.id, !playback.dataSaver);
    els.poster.classList.remove("gone");
  }
  if (ch?.thumb) els.chThumb.src = ch.thumb;
  else els.chThumb.removeAttribute("src");
  els.chName.textContent = ch?.n ?? "";
  els.badge.hidden = !(s.p && s.p > state.prevVisit);
  els.title.textContent = s.t;
  renderMeta();
  renderSave();
  if (feed.ctx) renderCtxBar();
  announce(`${ch?.n ? `${ch.n}: ` : ""}${s.t}`);

  state.lastActive = Math.floor(nowSec());
  act({ t: "seen", id: s.id, at: Math.floor(nowSec()) });
  pool.show(s.id, state.muted);

  // Slow start? Say so, and offer to skip.
  clearTimeout(slowTimer);
  slowTimer = window.setTimeout(() => {
    if (feed.cur === s && !playback.playing)
      toast(navigator.onLine ? "Slow connection — still loading…" : "You're offline", { label: "Skip", run: next }, 5000);
  }, 7000);

  updatePeeks();
}

/** Thumbnails above/below for the swipe animation, and preload the next video. */
export function updatePeeks() {
  const n = upcoming(1);
  const p = upcoming(-1);
  if (n) setThumb(els.peekNext, n.id, !playback.dataSaver);
  else els.peekNext.removeAttribute("src");
  if (p) setThumb(els.peekPrev, p.id, !playback.dataSaver);
  else els.peekPrev.removeAttribute("src");
  // Let the current video start first, then quietly load the next one.
  window.setTimeout(() => pool.preload(upcoming(1)?.id), playback.dataSaver ? 2500 : 700);
}

export function renderMeta() {
  const s = feed.cur;
  const bits: string[] = [];
  if (state.rate !== 1) bits.push(`${state.rate}×`);
  if (s?.v) bits.push(`${compact(s.v)} views`, `${compact(s.l)} likes`, ago(s.p));
  if (s) {
    const cats = videoCats(s, state);
    if (cats.length) bits.push(`${cats.map((c) => catInfo(c)?.short ?? c).join(" / ")}${isGuessed(s, state) ? " ?" : ""}`);
  }
  els.meta.textContent = bits.join(" · ");
}

export function renderSave() {
  const on = !!feed.cur && state.saved.includes(feed.cur.id);
  els.saveBtn.classList.toggle("on", on);
  els.saveBtn.setAttribute("aria-pressed", String(on));
  els.saveBtn.querySelector(".ico")!.textContent = on ? "♥" : "♡";
}

export function hideChannel() {
  const cur = feed.cur;
  if (!cur) return;
  const ch = feed.ds.channels[cur.ch];
  act({ t: "hide", h: ch.h });
  feed.queue = feed.queue.filter((s) => feed.ds.channels[s.ch].h !== ch.h);
  toast(`Hidden ${ch.n}`, { label: "Undo", run: () => act({ t: "unhide", h: ch.h }) });
  feed.cur = null;
  next();
}

/** Channels removed/hidden/re-categorised: drop them from the upcoming queue (and skip the current one). */
export function onFeedChange() {
  const gone = (s: Short) => {
    const ch = feed.ds.channels[s.ch];
    return !!ch && (ch.st === "removed" || state.hidden.includes(ch.h));
  };
  feed.queue = feed.queue.filter((s) => !gone(s));
  if (feed.cur && gone(feed.cur) && els.panel.hidden && els.page.hidden && !feed.ctx) next();
  else updatePeeks();
}

// ---------- data versions ----------
/** Version we already have (or have downloaded and are offering), so checks don't download it twice. */
export const latestVersion = () => Math.max(feed.ds.generatedAt, feed.pendingData?.generatedAt ?? 0);

/** Newer data arrived in the background — offer it without interrupting the current video. */
export function offerData(d: Dataset) {
  feed.pendingData = d;
  const fresh = d.videos.filter((v) => !feed.libIds.has(v.id)).length;
  banner(`✨ ${fresh ? `${fresh} new Shorts` : "Updated Shorts"} — tap to load`, () => applyData(d));
}

export function applyData(d: Dataset) {
  feed.pendingData = null;
  banner(null);
  const fresh = d.videos.filter((v) => !feed.libIds.has(v.id)).length;
  setData(d, false);
  resetFeed();
  toast(fresh ? `Loaded ${fresh} new Shorts ✓` : "Feed updated ✓");
}

/** Swap in a dataset. keepExternal: same version (starter → full), keep temporary channels so open lists stay valid. */
export function setData(d: Dataset, keepExternal: boolean) {
  const ds = feed.ds;
  const extras = keepExternal ? ds.channels.slice(d.channels.length).filter((c) => c.st === "external") : [];
  const extraShorts = keepExternal ? [...feed.byId.values()].filter((s) => !feed.libIds.has(s.id)) : [];
  ds.generatedAt = d.generatedAt;
  ds.units = d.units;
  ds.usage = d.usage;
  ds.videos = d.videos;
  ds.channels = keepExternal && d.channels.length === ds.channels.length - extras.length ? [...d.channels, ...extras] : d.channels;
  if (!keepExternal) {
    feed.ctx = null;
    renderCtxBar();
  }
  feed.libIds = new Set(ds.videos.map((s) => s.id));
  feed.byId = new Map(ds.videos.map((s) => [s.id, s]));
  for (const s of extraShorts) feed.byId.set(s.id, s);
  renderControls(); // category chips follow the library (which categories have Shorts)
}

// ---------- channels outside your list, saved Shorts ----------
const BENGALI = /[ঀ-৿]/;
function ensureChannel(info: ExternalChannelInfo): number {
  const ds = feed.ds;
  const lc = (x: string) => x.toLowerCase();
  const i = ds.channels.findIndex((c) => (info.id && c.id === info.id) || lc(c.h) === lc(info.handle));
  if (i >= 0) return i;
  ds.channels.push({
    h: info.handle || info.id,
    n: info.name || info.handle,
    cats: normCats(info.suggestedCats),
    mix: [],
    bn: BENGALI.test(info.name),
    subs: info.subs,
    thumb: info.thumb,
    id: info.id,
    st: "external",
    cnt: 0,
    last: 0,
  });
  return ds.channels.length - 1;
}

/** What the feature modules (explore, similar, history) can ask the feed to do. */
export const app: AppApi = {
  get ds() {
    return feed.ds;
  },
  toast,
  ago,
  fmt: compact,
  thumb,
  openPage,
  closePage,
  playList,
  ensureChannel,
  onFeedChange: () => onFeedChange(),
};

export function channelsCtx() {
  return {
    ds: feed.ds,
    toast,
    ago,
    fmt: compact,
    onFeedChange,
    explore: (info: ExternalChannelInfo) => openChannel(app, { info }),
  };
}

/** A saved Short may come from outside your library — rebuild it from history if needed. */
export function savedShort(id: string): Short | undefined {
  const s = feed.byId.get(id);
  if (s) return s;
  const h = state.hist.find((x) => x.id === id);
  return h ? historyShorts(app, feed.byId, [h])[0] : undefined;
}

export function exploreCurrent() {
  if (feed.cur) openChannel(app, { chIndex: feed.cur.ch });
}
