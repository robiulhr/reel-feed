import "./style.css";
import { PlayerPool, loadApi } from "./pool";
import { buildQueue, CATS } from "./rank";
import { act, learn, persist, startVisit, state } from "./store";
import * as sync from "./sync";
import { initChannels, renderChannelsPanel, resetChannels } from "./channels";
import { renderUsagePanel } from "./usage";
import { openChannel } from "./explore";
import { openSimilar } from "./similar";
import { historyShorts, renderHistory } from "./history";
import { checkForUpdate, isSlowNetwork, loadInitial, onNetworkChange } from "./data";
import { busy, confirmDialog, infoDialog, once, toast, toastError } from "./ui";
import type { AppApi, ExternalChannelInfo } from "./app";
import type { Dataset, Short, Tab, Win } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nowSec = () => Date.now() / 1000;

const el = {
  frame: $("frame"),
  track: $("track"),
  peekPrev: $<HTMLImageElement>("peekPrev"),
  peekNext: $<HTMLImageElement>("peekNext"),
  poster: $<HTMLImageElement>("poster"),
  tap: $("tap"),
  centerIcon: $("centerIcon"),
  spinner: $("spinner"),
  skipHint: $("skipHint"),
  speedHint: $("speedHint"),
  progress: $("progress"),
  volPop: $("volPop"),
  scrubTime: $("scrubTime"),
  banner: $<HTMLButtonElement>("banner"),
  tips: $("tips"),
  tabs: $("tabs"),
  win: $<HTMLSelectElement>("win"),
  chips: $("chips"),
  refreshBtn: $("refreshBtn"),
  muteBtn: $("muteBtn"),
  saveBtn: $("saveBtn"),
  shareBtn: $("shareBtn"),
  moreBtn: $("moreBtn"),
  moreSheet: $("moreSheet"),
  page: $("page"),
  pageTitle: $("pageTitle"),
  pageBody: $("pageBody"),
  ctxBar: $("ctxBar"),
  ctxTitle: $("ctxTitle"),
  ctxSub: $("ctxSub"),
  row1: document.querySelector<HTMLElement>(".row1")!,
  row2: document.querySelector<HTMLElement>(".row2")!,
  chThumb: $<HTMLImageElement>("chThumb"),
  chName: $<HTMLAnchorElement>("chName"),
  badge: $("badge"),
  title: $("title"),
  meta: $("meta"),
  bar: $("bar"),
  empty: $("empty"),
  panel: $("panel"),
  ptabs: $("ptabs"),
  panelBody: $("panelBody"),
  toast: $("toast"),
};

const ds: Dataset = { generatedAt: 0, units: 0, usage: [], channels: [], videos: [] };
let byId = new Map<string, Short>();
let libIds = new Set<string>();
let history: Short[] = [];
let idx = -1;
let queue: Short[] = [];
let cur: Short | null = null;
let playing = false;
let watch = { playMs: 0, since: 0, maxT: 0, loops: 0, shownAt: 0, skipped: 0 };
/** A temporary list you're swiping through (a channel's Shorts, "More like this", History). null = main feed. */
let ctx: { title: string; items: Short[]; i: number; onBack?: () => void } | null = null;
let pendingData: Dataset | null = null; // newer data downloaded, waiting for you to tap the banner

// ---------- helpers ----------
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
function ago(sec: number) {
  const d = nowSec() - sec;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)}d ago`;
  if (d < 86400 * 365) return `${Math.round(d / (86400 * 30))}mo ago`;
  return `${Math.round(d / (86400 * 365))}y ago`;
}

// Data saver: smaller thumbnails and fewer preloaded videos on slow connections.
let dataSaver = false;
function computeDataSaver() {
  return state.dataSaver === "on" || (state.dataSaver === "auto" && isSlowNetwork());
}
function poolSize() {
  const c = (navigator as any).connection;
  if (dataSaver && c && ["slow-2g", "2g"].includes(c.effectiveType)) return 1; // no preloading at all
  return dataSaver ? 2 : 3;
}

/** Big vertical thumbnail for the poster on good connections; small (~15 KB) everywhere else. */
function setThumb(img: HTMLImageElement, id: string, big: boolean) {
  const small = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  img.onerror = big ? () => { img.onerror = null; img.src = small; } : null;
  img.src = big ? `https://i.ytimg.com/vi/${id}/oar2.jpg` : small;
}
const thumb = (img: HTMLImageElement, id: string) => setThumb(img, id, false);


let bannerAction: (() => void) | null = null;
function banner(msg: string | null, onTap?: () => void) {
  el.banner.hidden = !msg;
  el.banner.textContent = msg ?? "";
  bannerAction = onTap ?? null;
  el.banner.classList.toggle("tappable", !!onTap);
}
el.banner.onclick = () => { const a = bannerAction; if (a) a(); };

function flashIcon(symbol: string, pop = false) {
  el.centerIcon.textContent = symbol;
  el.centerIcon.className = `center-icon ${pop ? "pop" : "show"}`;
  if (pop) setTimeout(() => (el.centerIcon.className = "center-icon"), 600);
}

// ---------- players ----------
let spinTimer: number | undefined;
let slowTimer: number | undefined;
function showSpinner(on: boolean) {
  clearTimeout(spinTimer);
  if (on) spinTimer = window.setTimeout(() => (el.spinner.hidden = false), 450);
  else el.spinner.hidden = true;
}

dataSaver = computeDataSaver();
const pool = new PlayerPool($("players"), {
  onPlaying() {
    playing = true;
    watch.since = performance.now();
    el.poster.classList.add("gone");
    el.centerIcon.className = "center-icon";
    showSpinner(false);
    clearTimeout(slowTimer);
  },
  onPaused() {
    stopClock();
    playing = false;
  },
  onBuffering() {
    showSpinner(true);
  },
  onEnded() {
    // Loop like Shorts do. A replay is a strong "I like this" signal.
    stopClock();
    watch.loops++;
    watch.maxT = pool.duration();
    pool.restart();
  },
  onError(code) {
    if (!cur) return;
    act({ t: "bad", id: cur.id });
    cur = null; // no learning signal — it never played
    showSpinner(false);
    toast(code === 101 || code === 150 ? "Skipped — the creator blocked embedding" : "Skipped — video unavailable");
    next();
  },
}, poolSize());

function stopClock() {
  if (playing && watch.since) watch.playMs += performance.now() - watch.since;
  watch.since = 0;
}

setInterval(() => {
  if (!cur || scrubbing) return;
  const t = pool.time();
  const d = pool.duration();
  if (t > watch.maxT) watch.maxT = t;
  el.bar.style.width = d ? `${Math.min(100, (t / d) * 100)}%` : "0";
}, 200);

// ---------- skip, scrub, speed ----------
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Skip forward/back (seconds). Skipped seconds don't count as "watched" for learning. */
function skip(sec: number) {
  if (!cur) return;
  const t = pool.time();
  if (sec > 0) watch.skipped += Math.min(sec, Math.max(0, pool.duration() - t));
  pool.seek(t + sec);
  flashSkip(sec);
}
let skipTimer: number | undefined;
function flashSkip(sec: number) {
  el.skipHint.textContent = sec > 0 ? `${sec}s ⏩` : `⏪ ${-sec}s`;
  el.skipHint.className = `skip-hint show ${sec > 0 ? "right" : "left"}`;
  clearTimeout(skipTimer);
  skipTimer = window.setTimeout(() => (el.skipHint.className = "skip-hint"), 650);
}

let scrubbing = false;
function scrubTo(clientX: number, commit: boolean) {
  const r = el.progress.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  const d = pool.duration();
  el.bar.style.width = `${f * 100}%`;
  el.scrubTime.hidden = !d || commit;
  if (d) el.scrubTime.textContent = `${fmtTime(f * d)} / ${fmtTime(d)}`;
  if (commit && d) {
    const t = pool.time();
    if (f * d > t) watch.skipped += f * d - t;
    pool.seek(f * d);
  }
}
el.progress.addEventListener("pointerdown", (e) => {
  if (!cur) return;
  scrubbing = true;
  el.progress.classList.add("scrubbing");
  el.progress.setPointerCapture(e.pointerId);
  scrubTo(e.clientX, false);
});
el.progress.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(e.clientX, false); });
const endScrub = (e: PointerEvent) => {
  if (!scrubbing) return;
  scrubbing = false;
  el.progress.classList.remove("scrubbing");
  scrubTo(e.clientX, true);
};
el.progress.addEventListener("pointerup", endScrub);
el.progress.addEventListener("pointercancel", endScrub);

function renderMeta() {
  const s = cur;
  const bits: string[] = [];
  if (state.rate !== 1) bits.push(`${state.rate}×`);
  if (s?.v) bits.push(`${compact.format(s.v)} views`, `${compact.format(s.l)} likes`, ago(s.p));
  el.meta.textContent = bits.join(" · ");
}

function setRate(r: number) {
  state.rate = r;
  persist();
  pool.setRate(r);
  renderMeta();
  toast(r === 1 ? "Normal speed" : `Speed ${r}×`);
}

/** Turn how you watched the current Short into a learning signal + a history entry. */
function finishCurrent() {
  if (!cur) return;
  stopClock();
  const d = pool.duration();
  const dwell = watch.playMs / 1000;
  // If you skipped ahead, count only what you actually watched.
  const watchedSec = watch.skipped ? Math.min(watch.maxT, (watch.playMs / 1000) * state.rate) : watch.maxT;
  const frac = d ? Math.min(1, watchedSec / d) : 0;
  let delta = 0;
  if (watch.loops > 0 || frac >= 0.9) delta = Math.min(2.5, 1 + 0.5 * watch.loops);
  else if (frac >= 0.5) delta = 0.5;
  else if (dwell < 3 && frac < 0.3) delta = -1;
  const ch = ds.channels[cur.ch];
  if (ch) learn(ch, delta);

  if (!state.histPaused && (dwell >= 1 || frac > 0.05)) {
    const f = watch.loops > 0 ? 1 : Math.round(frac * 100) / 100;
    act({
      t: "watch",
      item: {
        id: cur.id, at: Math.floor(watch.shownAt), f,
        ...(libIds.has(cur.id) || !ch ? {} : { x: { t: cur.t, n: ch.n, h: ch.h, c: ch.id } }),
      },
    });
  }
  cur = null;
}

// ---------- feed ----------
function refill() {
  const exclude = new Set([...history.map((s) => s.id), ...queue.map((s) => s.id)]);
  const last = queue.at(-1) ?? history.at(-1);
  const { items, recycled } = buildQueue(ds, state, { prevVisit: state.prevVisit, exclude, lastCh: last?.ch }, 30);
  queue.push(...items);
  if (recycled && items.length) toast("You've seen everything here — showing them again");
}

/** The Short a swipe would bring, without moving there. */
function upcoming(dir: 1 | -1): Short | undefined {
  if (ctx) return ctx.items[ctx.i + dir];
  if (dir === -1) return history[idx - 1];
  if (idx < history.length - 1) return history[idx + 1];
  if (queue.length < 5) refill();
  return queue[0];
}

function next() {
  if (ctx) {
    if (ctx.i >= ctx.items.length - 1) { toast("That's the end of this list — tap ← to go back"); return; }
    finishCurrent();
    ctx.i++;
    show(ctx.items[ctx.i]);
    return;
  }
  finishCurrent();
  if (idx < history.length - 1) idx++;
  else {
    if (queue.length < 5) refill();
    const s = queue.shift();
    if (!s) return showEmpty("Nothing matches these filters yet.<br>Try <b>All time</b> or another category.");
    history.push(s);
    idx = history.length - 1;
  }
  show(history[idx]);
}

function prev() {
  if (ctx) {
    if (ctx.i <= 0) return;
    finishCurrent();
    ctx.i--;
    show(ctx.items[ctx.i]);
    return;
  }
  if (idx <= 0) return;
  finishCurrent();
  idx--;
  show(history[idx]);
}

function playNow(s: Short) {
  if (ctx) { ctx = null; renderCtxBar(); }
  finishCurrent();
  history.splice(idx + 1, 0, s);
  idx++;
  show(s);
}

/** Swipe through a specific list; the main feed waits where you left it. */
function playList(title: string, items: Short[], start: number, onBack?: () => void) {
  if (!items.length) return;
  for (const s of items) if (!byId.has(s.id)) byId.set(s.id, s); // so saves from this list show in Saved
  finishCurrent();
  closePage();
  el.panel.hidden = true;
  ctx = { title, items, i: Math.max(0, Math.min(start, items.length - 1)), onBack };
  renderCtxBar();
  show(ctx.items[ctx.i]);
}

function exitList() {
  if (!ctx) return;
  const back = ctx.onBack;
  finishCurrent();
  ctx = null;
  renderCtxBar();
  if (history[idx]) show(history[idx]);
  else next();
  back?.();
}

function renderCtxBar() {
  el.ctxBar.hidden = !ctx;
  el.row1.hidden = !!ctx;
  el.row2.hidden = !!ctx;
  if (ctx) {
    el.ctxTitle.textContent = ctx.title;
    el.ctxSub.textContent = `${ctx.i + 1} of ${ctx.items.length} · ← back to your feed`;
  }
}

function resetFeed() {
  if (ctx) { ctx = null; renderCtxBar(); }
  finishCurrent();
  history = [];
  queue = [];
  idx = -1;
  next();
}

function showEmpty(html: string) {
  el.empty.innerHTML = html;
  el.empty.hidden = false;
}

function show(s: Short) {
  el.empty.hidden = true;
  cur = s;
  playing = false;
  watch = { playMs: 0, since: 0, maxT: 0, loops: 0, shownAt: nowSec(), skipped: 0 };
  el.bar.style.width = "0";

  const ch = ds.channels[s.ch];
  // Preloaded video already shows its first frame → no poster needed.
  if (pool.isPrimed(s.id)) el.poster.classList.add("gone");
  else {
    setThumb(el.poster, s.id, !dataSaver);
    el.poster.classList.remove("gone");
  }
  if (ch?.thumb) el.chThumb.src = ch.thumb; else el.chThumb.removeAttribute("src");
  el.chName.textContent = ch?.n ?? "";
  el.badge.hidden = !(s.p && s.p > state.prevVisit);
  el.title.textContent = s.t;
  renderMeta();
  renderSave();
  if (ctx) renderCtxBar();

  state.lastActive = Math.floor(nowSec());
  act({ t: "seen", id: s.id, at: Math.floor(nowSec()) });
  pool.show(s.id, state.muted);

  // Slow start? Say so, and offer to skip.
  clearTimeout(slowTimer);
  slowTimer = window.setTimeout(() => {
    if (cur === s && !playing) toast(navigator.onLine ? "Slow connection — still loading…" : "You're offline", { label: "Skip", run: next }, 5000);
  }, 7000);

  updatePeeks();
}

/** Thumbnails above/below for the swipe animation, and preload the next video. */
function updatePeeks() {
  const n = upcoming(1);
  const p = upcoming(-1);
  if (n) setThumb(el.peekNext, n.id, !dataSaver); else el.peekNext.removeAttribute("src");
  if (p) setThumb(el.peekPrev, p.id, !dataSaver); else el.peekPrev.removeAttribute("src");
  // Let the current video start first, then quietly load the next one.
  window.setTimeout(() => pool.preload(upcoming(1)?.id), dataSaver ? 2500 : 700);
}

// ---------- swipe (follows your finger, snaps like Shorts) ----------
let animating = false;
function animateTo(dir: 1 | -1) {
  // dir 1 = next (slides up), -1 = previous (slides down)
  if (animating) return;
  if (!upcoming(dir)) {
    if (dir === 1) next();
    snapBack();
    return;
  }
  animating = true;
  el.track.style.transition = "transform 200ms cubic-bezier(.2,.7,.2,1)";
  el.track.style.transform = `translateY(${dir === 1 ? -100 : 100}%)`;
  window.setTimeout(() => {
    el.track.style.transition = "none";
    el.track.style.transform = "translateY(0)";
    if (dir === 1) next(); else prev();
    animating = false;
  }, 200);
}
function snapBack() {
  el.track.style.transition = "transform 180ms ease-out";
  el.track.style.transform = "translateY(0)";
}

const drag = { on: false, x0: 0, y0: 0, t0: 0, dx: 0, dy: 0, axis: "" as "" | "x" | "y" };
let swiped = false;
// Press and hold = 2× speed while held (like Shorts)
let holdTimer: number | undefined;
let holding = false;
function startHold() {
  if (!cur || !playing) return;
  holding = true;
  if (state.rate < 2) pool.setRate(2);
  el.speedHint.hidden = false;
  navigator.vibrate?.(8);
}
function endHold() {
  clearTimeout(holdTimer);
  if (!holding) return;
  holding = false;
  pool.setRate(state.rate);
  el.speedHint.hidden = true;
  swiped = true; // don't treat the release as a tap
}

el.tap.addEventListener("touchstart", (e) => {
  if (animating) return;
  const t = e.touches[0];
  Object.assign(drag, { on: true, x0: t.clientX, y0: t.clientY, t0: performance.now(), dx: 0, dy: 0, axis: "" });
  swiped = false;
  el.track.style.transition = "none";
  clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => { if (drag.on && !drag.axis) startHold(); }, 450);
}, { passive: true });

el.tap.addEventListener("touchmove", (e) => {
  if (!drag.on) return;
  const t = e.touches[0];
  drag.dx = t.clientX - drag.x0;
  drag.dy = t.clientY - drag.y0;
  if (holding) return; // holding for 2× — ignore small finger movement
  if (!drag.axis && (Math.abs(drag.dx) > 10 || Math.abs(drag.dy) > 10)) {
    drag.axis = Math.abs(drag.dy) >= Math.abs(drag.dx) ? "y" : "x";
    clearTimeout(holdTimer);
  }
  if (drag.axis === "y") {
    const canGo = drag.dy < 0 ? !!upcoming(1) : !!upcoming(-1);
    const dy = canGo ? drag.dy : drag.dy * 0.25; // rubber-band at the ends
    el.track.style.transform = `translateY(${dy}px)`;
  } else if (drag.axis === "x" && drag.dx < 0) {
    el.track.style.transform = `translateX(${Math.max(drag.dx, -80) * 0.4}px)`;
  }
}, { passive: true });

el.tap.addEventListener("touchend", () => {
  if (!drag.on) return;
  drag.on = false;
  if (holding) { endHold(); snapBack(); return; }
  clearTimeout(holdTimer);
  const ms = Math.max(1, performance.now() - drag.t0);
  if (drag.axis === "y") {
    swiped = true;
    const h = el.frame.clientHeight;
    const v = drag.dy / ms; // px per ms
    if (drag.dy < -h * 0.15 || v < -0.45) animateTo(1);
    else if (drag.dy > h * 0.15 || v > 0.45) animateTo(-1);
    else snapBack();
  } else if (drag.axis === "x") {
    swiped = true;
    snapBack();
    if (drag.dx < -70) exploreCurrent(); // swipe left → channel
  }
});
el.tap.addEventListener("touchcancel", () => { drag.on = false; endHold(); snapBack(); });

// Tap = pause/play. Double-tap: left third = back 10 s, right third = forward 10 s, middle = save.
let lastClick = 0, lastZone = "", clickTimer: number | undefined;
el.tap.addEventListener("click", (e) => {
  if (swiped) { swiped = false; return; }
  if (animating) return; // a tap during the slide animation belongs to neither video
  const r = el.tap.getBoundingClientRect();
  const rel = (e.clientX - r.left) / r.width;
  const zone = rel < 0.33 ? "left" : rel > 0.67 ? "right" : "mid";
  const t = Date.now();
  if (t - lastClick < 300 && zone === lastZone) {
    clearTimeout(clickTimer);
    if (zone === "left") skip(-10);
    else if (zone === "right") skip(10);
    else toggleSave(true);
    // keep the double-tap window open on the sides, so tapping again keeps skipping
    lastClick = zone === "mid" ? 0 : t;
    return;
  }
  lastClick = t;
  lastZone = zone;
  clickTimer = window.setTimeout(togglePlay, 300);
});

// Desktop: hold the mouse button for 2×
el.tap.addEventListener("mousedown", () => {
  clearTimeout(holdTimer);
  holdTimer = window.setTimeout(startHold, 450);
});
el.tap.addEventListener("mouseup", () => { if (holding) endHold(); else clearTimeout(holdTimer); });
el.tap.addEventListener("mouseleave", () => endHold());

let wheelAcc = 0, wheelLock = 0;
window.addEventListener("wheel", (e) => {
  if (!el.panel.hidden || !el.page.hidden || !el.moreSheet.hidden || !el.tips.hidden || document.querySelector(".cost-overlay")) return;
  const t = Date.now();
  if (t < wheelLock) return;
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) > 40) {
    wheelLock = t + 450;
    animateTo(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0;
  }
}, { passive: true });

window.addEventListener("keydown", (e) => {
  if (document.querySelector(".cost-overlay")) return;
  if (!el.tips.hidden) { if (e.key === "Escape" || e.key === "Enter") closeTips(); return; }
  if (!el.moreSheet.hidden) { if (e.key === "Escape") el.moreSheet.hidden = true; return; }
  if (!el.page.hidden) { if (e.key === "Escape") closePage(); return; }
  if (!el.panel.hidden) { if (e.key === "Escape") closePanel(); return; }
  if (["SELECT", "INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
  if (e.key === "Escape" && ctx) { exitList(); return; }
  switch (e.key) {
    case "ArrowDown": case "j": e.preventDefault(); animateTo(1); break;
    case "ArrowUp": case "k": e.preventDefault(); animateTo(-1); break;
    case "ArrowRight": case "l": e.preventDefault(); skip(10); break;
    case "ArrowLeft": case "h": e.preventDefault(); skip(-10); break;
    case "c": exploreCurrent(); break;
    case "f": toggleFull(); break;
    case ">": setRate(Math.min(2, [0.5, 0.75, 1, 1.25, 1.5, 2].find((r) => r > state.rate) ?? 2)); break;
    case "<": setRate([0.5, 0.75, 1, 1.25, 1.5, 2].reverse().find((r) => r < state.rate) ?? 0.5); break;
    case " ": e.preventDefault(); togglePlay(); break;
    case "m": toggleMute(); break;
    case "+": case "=": setVolume(state.volume + 10); showVolume(); break;
    case "-": case "_": setVolume(state.volume - 10); showVolume(); break;
    case "s": toggleSave(); break;
    case "r": refreshFeed(); break;
  }
});

$("nextBtn").onclick = () => animateTo(1);
$("prevBtn").onclick = () => animateTo(-1);

// ---------- actions ----------
function togglePlay() {
  if (!cur) return;
  if (playing) { pool.pause(); flashIcon("▶"); }
  else { pool.play(); el.centerIcon.className = "center-icon"; }
}

// ---------- sound: mute + volume ----------
const volIcon = () => (state.muted || state.volume === 0 ? "🔇" : state.volume < 34 ? "🔈" : state.volume < 67 ? "🔉" : "🔊");
function renderMute() {
  el.muteBtn.querySelector(".ico")!.textContent = volIcon();
  el.muteBtn.classList.toggle("pulse", state.muted);
  for (const r of document.querySelectorAll<HTMLInputElement>(".vol-range")) r.value = String(state.muted ? 0 : state.volume);
  for (const t of document.querySelectorAll<HTMLElement>(".vol-pct")) t.textContent = state.muted ? "Muted" : `${state.volume}%`;
  for (const b of document.querySelectorAll<HTMLElement>(".vol-mute")) b.textContent = state.muted ? "🔇 Unmute" : "🔊 Mute";
}
function toggleMute() {
  state.muted = !state.muted;
  if (state.muted) pool.mute();
  else {
    if (state.volume === 0) state.volume = 60;
    pool.setVolume(state.volume);
    pool.unMute();
    showVolume(); // unmuting → show the slider briefly so you can set the level
  }
  renderMute();
  persist();
}
function setVolume(v: number) {
  state.volume = Math.max(0, Math.min(100, Math.round(v)));
  pool.setVolume(state.volume);
  if (state.volume === 0 && !state.muted) { state.muted = true; pool.mute(); }
  else if (state.volume > 0 && state.muted) { state.muted = false; pool.unMute(); }
  renderMute();
  persist();
}
/** Wire a volume slider (popup above the sound button, and the one in the ⋯ menu). */
function bindVolume(range: HTMLInputElement) {
  range.addEventListener("input", () => { setVolume(Number(range.value)); keepVolume(); });
}
let volTimer: number | undefined;
function keepVolume() {
  clearTimeout(volTimer);
  volTimer = window.setTimeout(() => (el.volPop.hidden = true), 3000);
}
function showVolume() {
  el.volPop.hidden = false;
  renderMute();
  keepVolume();
}
bindVolume(el.volPop.querySelector<HTMLInputElement>(".vol-range")!);
bindVolume(el.moreSheet.querySelector<HTMLInputElement>(".vol-range")!);
for (const b of document.querySelectorAll<HTMLElement>(".vol-mute")) b.addEventListener("click", (e) => { e.stopPropagation(); toggleMute(); keepVolume(); });
el.volPop.addEventListener("pointerdown", () => keepVolume());

// Sound button: tap = mute/unmute, press & hold = volume slider
let volHold: number | undefined;
let volHeld = false;
el.muteBtn.addEventListener("pointerdown", () => {
  volHeld = false;
  volHold = window.setTimeout(() => { volHeld = true; showVolume(); }, 400);
});
el.muteBtn.addEventListener("pointerup", () => clearTimeout(volHold));
el.muteBtn.addEventListener("pointerleave", () => clearTimeout(volHold));
el.muteBtn.addEventListener("contextmenu", (e) => e.preventDefault());

function renderSave() {
  const on = !!cur && state.saved.includes(cur.id);
  el.saveBtn.classList.toggle("on", on);
  el.saveBtn.querySelector(".ico")!.textContent = on ? "♥" : "♡";
}
function toggleSave(forceOn = false) {
  if (!cur) return;
  const isSaved = state.saved.includes(cur.id);
  if (isSaved && !forceOn) {
    act({ t: "unsave", id: cur.id });
  } else if (!isSaved) {
    act({ t: "save", id: cur.id });
    const ch = ds.channels[cur.ch];
    if (ch) learn(ch, 2);
    navigator.vibrate?.(12);
    toast("Saved");
  }
  if (forceOn) flashIcon("♥", true);
  renderSave();
}

function hideChannel() {
  if (!cur) return;
  const ch = ds.channels[cur.ch];
  act({ t: "hide", h: ch.h });
  queue = queue.filter((s) => ds.channels[s.ch].h !== ch.h);
  toast(`Hidden ${ch.n}`, { label: "Undo", run: () => act({ t: "unhide", h: ch.h }) });
  cur = null;
  next();
}

el.muteBtn.onclick = () => { if (volHeld) { volHeld = false; return; } toggleMute(); };
el.saveBtn.onclick = () => toggleSave();
el.shareBtn.onclick = shareCurrent;

// ---------- refresh ----------
let refreshing = false;
async function refreshFeed() {
  if (refreshing) return;
  refreshing = true;
  el.refreshBtn.classList.add("spinning");
  try {
    if (pendingData) { applyData(pendingData); return; }
    const r = await checkForUpdate(ds.generatedAt, (d) => applyData(d));
    if (r === "new") return; // applyData showed the message
    if (r === "offline") { toast("You're offline — showing your saved Shorts"); return; }
    resetFeed();
    toast(`Fresh feed ✓ · Shorts updated ${ago(ds.generatedAt)}`,
      sync.isConnected() ? { label: "Get newer", run: fetchFromYouTube } : undefined);
  } finally {
    refreshing = false;
    el.refreshBtn.classList.remove("spinning");
  }
}
el.refreshBtn.onclick = refreshFeed;

let watchTimer: number | undefined;
const fetchFromYouTube = once(fetchFromYouTubeNow); // tapping "Get newer" twice starts one fetch
async function fetchFromYouTubeNow() {
  try {
    await sync.call("/refresh", { method: "POST" });
    toast("Getting new Shorts from YouTube — about 3 minutes. A banner will appear when they're ready.", undefined, 6000);
    // check every 45 s for up to 12 minutes
    clearInterval(watchTimer);
    let n = 0;
    watchTimer = window.setInterval(async () => {
      if (++n > 16) { clearInterval(watchTimer); return; }
      const r = await checkForUpdate(latestVersion(), offerData);
      if (r === "new") clearInterval(watchTimer);
    }, 45_000);
  } catch (e) {
    toastError(e instanceof Error ? e.message : "Couldn't start the refresh", () => fetchFromYouTube());
  }
}

/** Version we already have (or have downloaded and are offering), so checks don't download it twice. */
const latestVersion = () => Math.max(ds.generatedAt, pendingData?.generatedAt ?? 0);

/** Newer data arrived in the background — offer it without interrupting the current video. */
function offerData(d: Dataset) {
  pendingData = d;
  const fresh = d.videos.filter((v) => !libIds.has(v.id)).length;
  banner(`✨ ${fresh ? `${fresh} new Shorts` : "Updated Shorts"} — tap to load`, () => applyData(d));
}

function applyData(d: Dataset) {
  pendingData = null;
  banner(null);
  const fresh = d.videos.filter((v) => !libIds.has(v.id)).length;
  setData(d, false);
  resetFeed();
  toast(fresh ? `Loaded ${fresh} new Shorts ✓` : "Feed updated ✓");
}

/** Swap in a dataset. keepExternal: same version (starter → full), keep temporary channels so open lists stay valid. */
function setData(d: Dataset, keepExternal: boolean) {
  const extras = keepExternal ? ds.channels.slice(d.channels.length).filter((c) => c.st === "external") : [];
  const extraShorts = keepExternal ? [...byId.values()].filter((s) => !libIds.has(s.id)) : [];
  ds.generatedAt = d.generatedAt;
  ds.units = d.units;
  ds.usage = d.usage;
  ds.videos = d.videos;
  ds.channels = keepExternal && d.channels.length === ds.channels.length - extras.length ? [...d.channels, ...extras] : d.channels;
  if (!keepExternal) { ctx = null; renderCtxBar(); }
  libIds = new Set(ds.videos.map((s) => s.id));
  byId = new Map(ds.videos.map((s) => [s.id, s]));
  for (const s of extraShorts) byId.set(s.id, s);
}

// ---------- pages, ⋯ menu, channel explorer, More like this ----------
function openPage(title: string, render: (body: HTMLElement) => void) {
  if (playing) pool.pause();
  el.panel.hidden = true;
  el.moreSheet.hidden = true;
  el.pageTitle.textContent = title;
  el.pageBody.replaceChildren();
  el.pageBody.scrollTop = 0;
  el.page.hidden = false;
  render(el.pageBody);
}
function closePage() {
  el.page.hidden = true;
}
$("pageClose").onclick = closePage;
el.page.addEventListener("click", (e) => { if (e.target === el.page) closePage(); });
$("ctxBack").onclick = exitList;

const BENGALI = /[ঀ-৿]/;
function ensureChannel(info: ExternalChannelInfo): number {
  const lc = (x: string) => x.toLowerCase();
  const i = ds.channels.findIndex((c) => (info.id && c.id === info.id) || lc(c.h) === lc(info.handle));
  if (i >= 0) return i;
  ds.channels.push({
    h: info.handle || info.id, n: info.name || info.handle, cat: (info.suggestedCat ?? "stories") as never,
    bn: BENGALI.test(info.name), subs: info.subs, thumb: info.thumb, id: info.id, st: "external", cnt: 0, last: 0,
  });
  return ds.channels.length - 1;
}

const app: AppApi = {
  get ds() { return ds; },
  toast, ago, fmt: (n) => compact.format(n), thumb,
  openPage, closePage, playList, ensureChannel,
  onFeedChange: () => onFeedChange(),
};

function channelsCtx() {
  return {
    ds, toast, ago, fmt: (n: number) => compact.format(n), onFeedChange,
    explore: (info: ExternalChannelInfo) => openChannel(app, { info }),
  };
}

function exploreCurrent() {
  if (cur) openChannel(app, { chIndex: cur.ch });
}
el.chName.addEventListener("click", (e) => { e.preventDefault(); exploreCurrent(); });
el.chThumb.addEventListener("click", exploreCurrent);

function renderSpeedRow() {
  el.moreSheet.querySelectorAll<HTMLButtonElement>("button[data-r]").forEach((b) => b.classList.toggle("on", Number(b.dataset.r) === state.rate));
}
el.moreBtn.onclick = () => { if (cur) { renderSpeedRow(); el.moreSheet.hidden = false; } };
el.moreSheet.addEventListener("click", (e) => {
  const rateBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-r]");
  if (rateBtn) {
    setRate(Number(rateBtn.dataset.r));
    renderSpeedRow();
    return;
  }
  const a = (e.target as HTMLElement).closest("button")?.dataset.a;
  if (e.target !== el.moreSheet && !a) return;
  el.moreSheet.hidden = true;
  if (!cur) return;
  if (a === "similar") openSimilar(app, cur);
  else if (a === "channel") exploreCurrent();
  else if (a === "hide") hideChannel();
  else if (a === "open") window.open(`https://www.youtube.com/shorts/${cur.id}`, "_blank", "noopener");
});

// ---------- ‹ › buttons for rows that don't fit (tabs, categories, menu tabs) ----------
function scrollArrows(row: HTMLElement) {
  const wrap = document.createElement("div");
  wrap.className = "scroll-wrap";
  row.replaceWith(wrap);
  wrap.append(row);
  const mk = (cls: string, label: string, dir: number) => {
    const b = document.createElement("button");
    b.className = `scroll-arrow ${cls}`;
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-label", dir > 0 ? "Show more options" : "Back");
    b.onclick = (e) => { e.stopPropagation(); row.scrollBy({ left: dir * row.clientWidth * 0.7 }); };
    wrap.append(b);
    return b;
  };
  const left = mk("left", "‹", -1);
  const right = mk("right", "›", 1);
  const update = () => {
    const max = row.scrollWidth - row.clientWidth;
    left.hidden = row.scrollLeft <= 4;
    right.hidden = max <= 4 || row.scrollLeft >= max - 4;
  };
  row.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(row);
  // keep the selected item in view
  row.addEventListener("click", (e) => (e.target as HTMLElement).closest("button")?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  update();
}
scrollArrows(el.tabs);
scrollArrows(el.chips);
scrollArrows(el.ptabs);

// ---------- full screen ----------
// On phones the browser's address bar stays because the page never scrolls; the Fullscreen API
// hides it (Android Chrome etc.). Installed as an app, the manifest opens it full screen anyway.
const fsBtn = $("fsBtn");
const isStandalone = () =>
  matchMedia("(display-mode: fullscreen)").matches || matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone;
const isPhone = () => matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820;
const canFull = () => !!document.documentElement.requestFullscreen && document.fullscreenEnabled && !isStandalone();
let fullDeclined = false; // you left full screen yourself → don't push it again this session

async function enterFull() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" } as FullscreenOptions);
    (screen.orientation as any)?.lock?.("portrait").catch(() => {});
  } catch { /* not allowed here (e.g. iPhone Safari) */ }
}
function toggleFull() {
  if (document.fullscreenElement) { fullDeclined = true; document.exitFullscreen().catch(() => {}); }
  else enterFull();
}
function renderFsBtn() {
  // lives in the ⋯ menu (the top bar had no room for it on phones)
  fsBtn.hidden = !canFull();
  fsBtn.textContent = document.fullscreenElement ? "🗗 Exit full screen" : "⛶ Full screen";
}
fsBtn.onclick = toggleFull;
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && wasFull) fullDeclined = true;
  wasFull = !!document.fullscreenElement;
  renderFsBtn();
});
let wasFull = false;
/** First tap on a phone → full screen (needs a tap; browsers don't allow it on page load). */
function maybeAutoFull() {
  if (state.autoFull && !fullDeclined && !document.fullscreenElement && canFull() && isPhone()) enterFull();
}
el.tap.addEventListener("touchend", maybeAutoFull);
renderFsBtn();

// ---------- tips ----------
function closeTips() {
  maybeAutoFull(); // "Got it" is a tap — a good moment to go full screen
  el.tips.hidden = true;
  state.tipsSeen = true;
  persist();
}
$("tipsOk").onclick = closeTips;

// ---------- tabs, time range, categories ----------
function renderControls() {
  el.tabs.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.tab === state.tab));
  el.win.value = state.win;
  el.chips.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.cat === state.cat));
}

for (const c of CATS) {
  const b = document.createElement("button");
  b.textContent = c.label;
  b.dataset.cat = c.id;
  el.chips.append(b);
}
el.chips.addEventListener("click", (e) => {
  const cat = (e.target as HTMLElement).closest("button")?.dataset.cat;
  if (!cat || cat === state.cat) return;
  state.cat = cat;
  persist(); renderControls(); resetFeed();
});
el.tabs.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest("button")?.dataset.tab as Tab | undefined;
  if (!tab || tab === state.tab) return;
  state.tab = tab;
  persist(); renderControls(); resetFeed();
});
el.win.addEventListener("change", () => {
  state.win = el.win.value as Win;
  persist(); renderControls(); resetFeed();
  el.win.blur();
});

// ---------- panel ----------
let panelTab = "history";
function openPanel(tab = panelTab) {
  panelTab = tab;
  if (playing) pool.pause();
  el.panel.hidden = false;
  renderPanel();
}
function closePanel() {
  el.panel.hidden = true;
  onFeedChange(); // skip the current Short if its channel was removed/hidden while the menu was open
}
$("menuBtn").onclick = () => openPanel();
$("closePanel").onclick = closePanel;
el.panel.addEventListener("click", (e) => { if (e.target === el.panel) closePanel(); });
el.ptabs.addEventListener("click", (e) => {
  const p = (e.target as HTMLElement).closest("button")?.dataset.p;
  if (p) openPanel(p);
});

function para(text: string, cls = "") {
  const p = document.createElement("p");
  p.textContent = text;
  if (cls) p.className = cls;
  return p;
}
function button(label: string, onClick: (b: HTMLButtonElement) => unknown, cls = "btn") {
  const b = document.createElement("button");
  b.className = cls;
  b.type = "button";
  b.textContent = label;
  b.onclick = () => onClick(b);
  return b;
}

/** A saved Short may come from outside your library — rebuild it from history if needed. */
function savedShort(id: string): Short | undefined {
  const s = byId.get(id);
  if (s) return s;
  const h = state.hist.find((x) => x.id === id);
  return h ? historyShorts(app, byId, [h])[0] : undefined;
}

function renderPanel() {
  el.ptabs.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.p === panelTab));
  const body = el.panelBody;
  body.replaceChildren();

  if (panelTab === "channels") {
    renderChannelsPanel(body, channelsCtx());
  } else if (panelTab === "history") {
    renderHistory(body, app, byId, () => openPanel("history"));
  } else if (panelTab === "saved") {
    const items = state.saved.map(savedShort).filter((s): s is Short => !!s);
    if (!items.length) { body.innerHTML = "<p>No saved Shorts yet. Tap ♡ or double-tap a video to save it.</p>"; return; }
    body.append(button("▶ Play all saved", () => playList("Saved", items, 0, () => openPanel("saved")), "btn primary"));
    const grid = document.createElement("div");
    grid.className = "grid";
    items.forEach((s, i) => {
      const card = document.createElement("div");
      card.className = "card";
      const img = document.createElement("img");
      img.loading = "lazy";
      thumb(img, s.id);
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = `${ds.channels[s.ch]?.n ?? ""} · ${s.t}`;
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "✕";
      x.title = "Remove from saved";
      x.onclick = (e) => {
        e.stopPropagation();
        act({ t: "unsave", id: s.id });
        renderPanel(); renderSave();
      };
      card.onclick = () => playList("Saved", items, i, () => openPanel("saved"));
      card.append(img, cap, x);
      grid.append(card);
    });
    body.append(grid);
  } else if (panelTab === "hidden") {
    if (!state.hidden.length) { body.innerHTML = "<p>No hidden channels. Use ⋯ → Hide on a video to stop seeing a channel.</p>"; return; }
    for (const h of state.hidden) {
      const ch = ds.channels.find((c) => c.h === h);
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span");
      name.textContent = ch ? `${ch.n} (${h})` : h;
      const b = button("Unhide", () => { act({ t: "unhide", h }); renderPanel(); });
      row.append(name, b);
      body.append(row);
    }
  } else if (panelTab === "api") {
    renderUsagePanel(body, ds, ago);
  } else if (panelTab === "sync") {
    renderSyncPanel(body);
  } else {
    renderAbout(body);
  }
}

function renderAbout(body: HTMLElement) {
  const seen = Object.keys(state.seen).length;
  const updated = ds.generatedAt ? `${new Date(ds.generatedAt * 1000).toLocaleString()} (${ago(ds.generatedAt)})` : "never";
  const stats = document.createElement("div");
  stats.className = "stats";
  for (const [n, label] of [
    [ds.videos.length, "Shorts in library"], [ds.channels.filter((c) => c.st === "active").length, "Channels with Shorts"],
    [state.hist.length, "In your history"], [state.saved.length, "Saved"],
  ] as const) {
    const d = document.createElement("div");
    d.className = "stat";
    d.innerHTML = `<b>${compact.format(n)}</b><span>${label}</span>`;
    stats.append(d);
  }
  body.append(stats, para(`Shorts last updated: ${updated}. New Shorts arrive automatically every 4 hours — tap ↻ for a fresh feed.`));
  const builtAt = new Date(__BUILD__);
  body.append(
    para(`App version: ${builtAt.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`, "ver"),
    button("Check for app update", (b) => busy(b, "Checking…", async () => {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update().catch(() => {});
      toast(reg?.installing || reg?.waiting ? "Updating — the app will reload" : "Checked ✓ — if the version above doesn't change, close the app fully and open it again");
      if (!reg) location.reload();
    })),
  );

  // data saver
  const ds1 = document.createElement("div");
  ds1.className = "u-budget-form";
  const sel = document.createElement("select");
  for (const [v, l] of [["auto", "Auto (on when the connection is slow)"], ["on", "Always on"], ["off", "Off"]]) sel.append(new Option(l, v));
  sel.value = state.dataSaver;
  sel.onchange = () => { state.dataSaver = sel.value as typeof state.dataSaver; persist(); applyNetwork(true); renderPanel(); };
  ds1.append(para("Data saver:"), sel);
  body.append(ds1, para(dataSaver
    ? "Data saver is ON now: smaller thumbnails and less preloading, so it works better on slow connections."
    : "Data saver is off now: the next video is preloaded so swiping is instant."));

  const fsRow = document.createElement("label");
  fsRow.className = "u-budget-form";
  const fsBox = document.createElement("input");
  fsBox.type = "checkbox";
  fsBox.checked = state.autoFull;
  fsBox.onchange = () => { state.autoFull = fsBox.checked; persist(); };
  fsRow.append(fsBox, para("Full screen automatically on phones (hides the browser's address bar after your first tap). ⛶ in the top bar toggles it."));
  body.append(fsRow, para(isStandalone()
    ? "You're using the installed app — it's always full screen."
    : "Tip: install it (browser menu → Install app / Add to Home screen) to open full screen like a normal app."));

  const keys = document.createElement("p");
  keys.innerHTML = "Phone: <b>swipe up/down</b> · <b>swipe left</b> for the channel · tap to pause · <b>double-tap left/right</b> = 10 s back/forward · double-tap middle = save · <b>hold</b> = 2× · drag the progress bar to jump · speed in ⋯.<br>Keys: <b>↑/↓</b> move · <b>←/→</b> 10 s · <b>&lt; &gt;</b> speed · <b>c</b> channel · <b>Space</b> pause · <b>m</b> sound · <b>s</b> save · <b>r</b> refresh.";
  body.append(keys,
    button("Show the tips again", () => { closePanel(); el.tips.hidden = false; }),
    button("Reset what the feed learned", () => { act({ t: "resetLearn" }); toast("Learning reset"); }),
    button(`Show already-seen Shorts again (${compact.format(seen)})`, () => { act({ t: "clearSeen" }); toast("Done — seen Shorts can appear again"); renderPanel(); }, "btn danger"),
  );
}

function renderSyncPanel(body: HTMLElement) {
  if (!sync.isAvailable()) {
    body.append(para("Sync isn't set up for this copy of the site yet (no sync server address). Your data is kept in this browser for now."));
    return;
  }
  if (sync.isConnected()) {
    const st = sync.status();
    body.append(
      para("This device is logged in. Saves, hidden channels, history and learning sync across all your devices."),
      para(st.busy ? "Syncing…" : `Last synced: ${st.lastSync ? ago(st.lastSync / 1000) : "not yet"}`),
      para(`Changes waiting to upload: ${st.pending}`),
    );
    if (st.lastError) body.append(para(`Problem: ${st.lastError}`, "error"));
    body.append(
      para("Every sync is a commit in your private GitHub repo, so GitHub keeps every earlier version as a backup."),
      button("Sync now", (b) => busy(b, "Syncing…", async () => { await sync.syncNow(); renderPanel(); })),
      button("Log out this device", async () => {
        const ok = await confirmDialog({
          title: "Log out this device?",
          body: "Your saves, history and learning stay safe in GitHub. You can log in again any time.",
          confirm: "Log out", danger: true,
        });
        if (ok) { sync.disconnect(); resetChannels(); renderPanel(); }
      }, "btn danger"),
    );
    return;
  }

  const st = sync.status();
  body.append(para("Log in to sync your saves, history and learning across devices, and to add channels. You only need to do this once per device."));
  if (st.lastError) body.append(para(st.lastError, "error"));
  const form = document.createElement("form");
  form.className = "form";
  form.innerHTML = `<label>Password<input name="password" type="password" autocomplete="current-password"></label>`;
  const err = para("", "error");
  const go = button("Log in", () => {}, "btn primary");
  go.type = "submit";
  form.append(go, err);
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = new FormData(form);
    err.textContent = "";
    busy(go, "Logging in…", async () => {
      const msg = await sync.connect(String(data.get("password") ?? ""));
      if (msg) err.textContent = msg;
      else { toast("Logged in — your data is synced"); renderPanel(); }
    });
  };
  body.append(form);
}

/** Channels removed/hidden/re-categorised: drop them from the upcoming queue (and skip the current one). */
function onFeedChange() {
  const gone = (s: Short) => {
    const ch = ds.channels[s.ch];
    return !!ch && (ch.st === "removed" || state.hidden.includes(ch.h));
  };
  queue = queue.filter((s) => !gone(s));
  if (cur && gone(cur) && el.panel.hidden && el.page.hidden && !ctx) next();
  else updatePeeks();
}

function onSyncUpdate() {
  renderSave();
  onFeedChange();
  // Don't rebuild the Channels/History panels on background syncs — it would wipe what you're typing.
  if (!el.panel.hidden && !["channels", "history"].includes(panelTab) && (panelTab !== "sync" || sync.isConnected())) renderPanel();
}

// ---------- share ----------
async function shareCurrent() {
  if (!cur) return;
  const ch = ds.channels[cur.ch];
  const url = `https://youtube.com/shorts/${cur.id}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: cur.t, text: `${cur.t} — ${ch?.n ?? ""}`, url });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // you closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    // Clipboard blocked: show the link in a dialog, already selected, ready to copy.
    const input = Object.assign(document.createElement("input"), { value: url, readOnly: true });
    input.onfocus = () => input.select();
    infoDialog("Copy this link", input);
    setTimeout(() => input.select(), 50);
  }
}

// ---------- network ----------
let lastNetMsg = "";
function applyNetwork(userChanged = false) {
  const was = dataSaver;
  dataSaver = computeDataSaver();
  pool.resize(poolSize());
  if (!navigator.onLine) {
    banner("📴 You're offline — videos need a connection. History, saved and lists still work.");
    lastNetMsg = "offline";
    return;
  }
  if (lastNetMsg === "offline") {
    banner(null);
    lastNetMsg = "";
    checkForUpdate(latestVersion(), offerData);
  }
  if (dataSaver && !was && !userChanged && !saverToldThisSession) {
    saverToldThisSession = true;
    toast("Slow connection — data saver on (smaller images, less preloading)");
  }
}
let saverToldThisSession = false;

// ---------- boot ----------
async function boot() {
  renderControls();
  renderMute();
  startVisit(Math.floor(nowSec()));
  loadApi(); // start loading the YouTube player right away
  pool.setRate(state.rate ?? 1);
  pool.setVolume(state.volume ?? 100);
  sync.startSync(onSyncUpdate);
  onNetworkChange(() => applyNetwork());

  const t0 = performance.now();
  const first = await loadInitial(
    (full, sameVersion) => {
      // Full library arrived after the starter
      if (sameVersion) { setData(full, true); updatePeeks(); }
      else offerData(full);
    },
    (msg) => toast(msg),
  );
  if (!first) {
    showEmpty(navigator.onLine
      ? "Couldn't load Shorts — the connection is very weak.<br><br><button class=\"btn primary\" onclick=\"location.reload()\">Try again</button>"
      : "You're offline and nothing is saved on this device yet.<br>Connect once and the app will work offline afterwards.");
    return;
  }
  setData(first.ds, false);
  initChannels(channelsCtx());
  next();
  console.info(`First video in ${Math.round(performance.now() - t0)} ms (from ${first.source})`);

  if (!state.tipsSeen) el.tips.hidden = false;
  applyNetwork();

  // Continue where you left off
  const last = state.hist[0];
  if (last && nowSec() - last.at < 24 * 3600 && last.f < 0.9 && last.id !== cur?.id) {
    const s = savedShort(last.id);
    if (s) toast(`Continue “${s.t.slice(0, 40)}${s.t.length > 40 ? "…" : ""}”?`, { label: "Resume", run: () => playNow(s) }, 7000);
  }

  // Newer data? Check now (if we started from the saved copy), when you come back, and every 10 minutes.
  if (first.source === "saved") checkForUpdate(latestVersion(), offerData);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate(latestVersion(), offerData);
  });
  setInterval(() => { if (document.visibilityState === "visible") checkForUpdate(latestVersion(), offerData); }, 10 * 60_000);
}

// Keep the app on the device (opens instantly, works offline). Only in the built site.
// Updates: check for a new app version when the app opens, when you come back to it, and every
// 30 minutes. When a new version takes over: reload right away if you just opened the app,
// otherwise show "New version — tap to update" (never interrupts a video by itself).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
      const check = () => reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
      setInterval(check, 30 * 60_000);
    }).catch(() => {});
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return; // first install — nothing to update
    const reload = () => { reloading = true; location.reload(); };
    if (performance.now() < 10_000) reload();
    else banner("🆕 New version of the app — tap to update", reload);
  });
}

boot();
