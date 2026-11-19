import "./style.css";
import { ShortsPlayer } from "./player";
import { buildQueue, CATS } from "./rank";
import { act, learn, persist, startVisit, state } from "./store";
import * as sync from "./sync";
import { renderChannelsPanel, resetChannels } from "./channels";
import { renderUsagePanel } from "./usage";
import { openChannel } from "./explore";
import { openSimilar } from "./similar";
import { initChannels } from "./channels";
import type { AppApi, ExternalChannelInfo } from "./app";
import type { Dataset, Short, Tab, Win } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nowSec = () => Date.now() / 1000;

const el = {
  poster: $<HTMLImageElement>("poster"),
  tap: $("tap"),
  centerIcon: $("centerIcon"),
  tabs: $("tabs"),
  win: $<HTMLSelectElement>("win"),
  chips: $("chips"),
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

let ds: Dataset = { generatedAt: 0, units: 0, usage: [], channels: [], videos: [] };
let byId = new Map<string, Short>();
let history: Short[] = [];
let idx = -1;
let queue: Short[] = [];
let cur: Short | null = null;
let playing = false;
let watch = { playMs: 0, since: 0, maxT: 0, loops: 0 };
/** A temporary list you're swiping through (a channel's Shorts, "More like this"). null = main feed. */
let ctx: { title: string; items: Short[]; i: number; onBack?: () => void } | null = null;

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
function thumb(img: HTMLImageElement, id: string) {
  img.onerror = () => { img.onerror = null; img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; };
  img.src = `https://i.ytimg.com/vi/${id}/oar2.jpg`;
}

let toastTimer: number | undefined;
function toast(msg: string, action?: { label: string; run: () => void }) {
  clearTimeout(toastTimer);
  el.toast.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.toast.hidden = true; };
    el.toast.append(b);
  }
  el.toast.hidden = false;
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), action ? 5000 : 2500);
}

function flashIcon(symbol: string, pop = false) {
  el.centerIcon.textContent = symbol;
  el.centerIcon.className = `center-icon ${pop ? "pop" : "show"}`;
  if (pop) setTimeout(() => (el.centerIcon.className = "center-icon"), 600);
}

// ---------- player ----------
const player = new ShortsPlayer("player", {
  onPlaying() {
    playing = true;
    watch.since = performance.now();
    el.poster.classList.add("gone");
    el.centerIcon.className = "center-icon";
  },
  onPaused() {
    stopClock();
    playing = false;
  },
  onEnded() {
    // Loop like Shorts do. A replay is a strong "I like this" signal.
    stopClock();
    watch.loops++;
    watch.maxT = player.duration();
    player.restart();
  },
  onError(code) {
    if (!cur) return;
    act({ t: "bad", id: cur.id });
    cur = null; // no learning signal — it never played
    toast(code === 101 || code === 150 ? "Skipped — the creator blocked embedding" : "Skipped — video unavailable");
    next();
  },
});

function stopClock() {
  if (playing && watch.since) watch.playMs += performance.now() - watch.since;
  watch.since = 0;
}

setInterval(() => {
  if (!cur) return;
  const t = player.time();
  const d = player.duration();
  if (t > watch.maxT) watch.maxT = t;
  el.bar.style.width = d ? `${Math.min(100, (t / d) * 100)}%` : "0";
}, 200);

/** Turn how you watched the current Short into a learning signal. */
function finishCurrent() {
  if (!cur) return;
  stopClock();
  const d = player.duration();
  const dwell = watch.playMs / 1000;
  const frac = d ? watch.maxT / d : 0;
  let delta = 0;
  if (watch.loops > 0 || frac >= 0.9) delta = Math.min(2.5, 1 + 0.5 * watch.loops);
  else if (frac >= 0.5) delta = 0.5;
  else if (dwell < 3 && frac < 0.3) delta = -1;
  learn(ds.channels[cur.ch], delta);
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
  closePanel();
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
  watch = { playMs: 0, since: 0, maxT: 0, loops: 0 };
  el.bar.style.width = "0";

  const ch = ds.channels[s.ch];
  thumb(el.poster, s.id);
  el.poster.classList.remove("gone");
  el.chThumb.src = ch.thumb;
  el.chName.textContent = ch.n;
  el.badge.hidden = !(s.p > state.prevVisit);
  el.title.textContent = s.t;
  el.meta.textContent = `${compact.format(s.v)} views · ${compact.format(s.l)} likes · ${ago(s.p)}`;
  renderSave();
  if (ctx) renderCtxBar();

  state.lastActive = Math.floor(nowSec());
  act({ t: "seen", id: s.id, at: Math.floor(nowSec()) });
  player.load(s.id, state.muted);
}

// ---------- actions ----------
function togglePlay() {
  if (!cur) return;
  if (playing) { player.pause(); flashIcon("▶"); }
  else { player.play(); el.centerIcon.className = "center-icon"; }
}

function renderMute() {
  el.muteBtn.querySelector(".ico")!.textContent = state.muted ? "🔇" : "🔊";
  el.muteBtn.classList.toggle("pulse", state.muted);
}
function toggleMute() {
  state.muted = !state.muted;
  if (state.muted) player.mute(); else player.unMute();
  renderMute();
  persist();
}

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
    learn(ds.channels[cur.ch], 2);
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

// ---------- pages, ⋯ menu, channel explorer, More like this ----------
function openPage(title: string, render: (body: HTMLElement) => void) {
  if (playing) player.pause();
  closePanel();
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
el.chThumb.style.cursor = "pointer";

el.moreBtn.onclick = () => { if (cur) el.moreSheet.hidden = false; };
el.moreSheet.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("button")?.dataset.a;
  if (e.target !== el.moreSheet && !a) return;
  el.moreSheet.hidden = true;
  if (!cur) return;
  if (a === "similar") openSimilar(app, cur);
  else if (a === "channel") exploreCurrent();
  else if (a === "hide") hideChannel();
  else if (a === "open") window.open(`https://www.youtube.com/shorts/${cur.id}`, "_blank", "noopener");
});

// ---------- gestures & keys ----------
let touchY = 0, touchT = 0, swiped = false;
el.tap.addEventListener("touchstart", (e) => { touchY = e.touches[0].clientY; touchT = Date.now(); swiped = false; }, { passive: true });
el.tap.addEventListener("touchend", (e) => {
  const dy = touchY - e.changedTouches[0].clientY;
  if (Math.abs(dy) > 50 && Date.now() - touchT < 800) {
    swiped = true;
    if (dy > 0) next(); else prev();
  }
});

let lastClick = 0, clickTimer: number | undefined;
el.tap.addEventListener("click", () => {
  if (swiped) { swiped = false; return; }
  const t = Date.now();
  if (t - lastClick < 280) {
    clearTimeout(clickTimer);
    lastClick = 0;
    toggleSave(true); // double-tap = save
    return;
  }
  lastClick = t;
  clickTimer = window.setTimeout(togglePlay, 280);
});

let wheelAcc = 0, wheelLock = 0;
window.addEventListener("wheel", (e) => {
  if (!el.panel.hidden || !el.page.hidden || !el.moreSheet.hidden || document.querySelector(".cost-overlay")) return;
  const t = Date.now();
  if (t < wheelLock) return;
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) > 40) {
    wheelLock = t + 600;
    if (wheelAcc > 0) next(); else prev();
    wheelAcc = 0;
  }
}, { passive: true });

window.addEventListener("keydown", (e) => {
  if (document.querySelector(".cost-overlay")) return;
  if (!el.moreSheet.hidden) { if (e.key === "Escape") el.moreSheet.hidden = true; return; }
  if (!el.page.hidden) { if (e.key === "Escape") closePage(); return; }
  if (!el.panel.hidden) { if (e.key === "Escape") closePanel(); return; }
  if (["SELECT", "INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
  if (e.key === "Escape" && ctx) { exitList(); return; }
  switch (e.key) {
    case "ArrowDown": case "j": e.preventDefault(); next(); break;
    case "ArrowUp": case "k": e.preventDefault(); prev(); break;
    case " ": e.preventDefault(); togglePlay(); break;
    case "m": toggleMute(); break;
    case "s": toggleSave(); break;
  }
});

$("nextBtn").onclick = next;
$("prevBtn").onclick = prev;
el.muteBtn.onclick = toggleMute;
el.saveBtn.onclick = () => toggleSave();
el.shareBtn.onclick = shareCurrent;

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

// ---------- panel (Saved / Hidden / About) ----------
let panelTab = "saved";
function openPanel(tab = panelTab) {
  panelTab = tab;
  if (playing) player.pause();
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

function renderPanel() {
  el.ptabs.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.p === panelTab));
  const body = el.panelBody;
  body.replaceChildren();

  if (panelTab === "channels") {
    renderChannelsPanel(body, channelsCtx());
  } else if (panelTab === "saved") {
    const items = state.saved.map((id) => byId.get(id)).filter((s): s is Short => !!s);
    if (!items.length) { body.innerHTML = "<p>No saved Shorts yet. Tap ♡ or double-tap a video to save it.</p>"; return; }
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const s of items) {
      const card = document.createElement("div");
      card.className = "card";
      const img = document.createElement("img");
      img.loading = "lazy";
      thumb(img, s.id);
      const cap = document.createElement("div");
      cap.className = "cap";
      cap.textContent = `${ds.channels[s.ch].n} · ${s.t}`;
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "✕";
      x.title = "Remove from saved";
      x.onclick = (e) => {
        e.stopPropagation();
        act({ t: "unsave", id: s.id });
        renderPanel(); renderSave();
      };
      card.onclick = () => { closePanel(); playNow(s); };
      card.append(img, cap, x);
      grid.append(card);
    }
    body.append(grid);
  } else if (panelTab === "hidden") {
    if (!state.hidden.length) { body.innerHTML = "<p>No hidden channels. Use ⊘ on a video to stop seeing a channel.</p>"; return; }
    for (const h of state.hidden) {
      const ch = ds.channels.find((c) => c.h === h);
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span");
      name.textContent = ch ? `${ch.n} (${h})` : h;
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = "Unhide";
      b.onclick = () => { act({ t: "unhide", h }); renderPanel(); };
      row.append(name, b);
      body.append(row);
    }
  } else if (panelTab === "api") {
    renderUsagePanel(body, ds, ago);
  } else if (panelTab === "sync") {
    renderSyncPanel(body);
  } else {
    const seen = Object.keys(state.seen).length;
    const updated = ds.generatedAt ? new Date(ds.generatedAt * 1000).toLocaleString() : "never";
    const stats = document.createElement("div");
    stats.className = "stats";
    for (const [n, label] of [
      [ds.videos.length, "Shorts in library"], [ds.channels.length, "Channels with Shorts"],
      [seen, "Shorts you've seen"], [state.saved.length, "Saved"],
    ] as const) {
      const d = document.createElement("div");
      d.className = "stat";
      d.innerHTML = `<b>${compact.format(n)}</b><span>${label}</span>`;
      stats.append(d);
    }
    const p = document.createElement("p");
    p.textContent = `Data last refreshed: ${updated}${ds.units ? ` (used ~${ds.units} YouTube API units)` : ""}. New Shorts are pulled automatically every 4 hours, or use Channels → Refresh now.`;
    const keys = document.createElement("p");
    keys.innerHTML = "Keys: <b>↑/↓</b> or <b>j/k</b> move · <b>Space</b> pause · <b>m</b> sound · <b>s</b> save. On phone: swipe, tap to pause, double-tap to save.";
    const resetLearn = document.createElement("button");
    resetLearn.className = "btn";
    resetLearn.textContent = "Reset what the feed learned";
    resetLearn.onclick = () => { act({ t: "resetLearn" }); toast("Learning reset"); };
    const resetSeen = document.createElement("button");
    resetSeen.className = "btn danger";
    resetSeen.textContent = "Clear watched history";
    resetSeen.style.marginLeft = "8px";
    resetSeen.onclick = () => { act({ t: "clearSeen" }); toast("Watched history cleared"); renderPanel(); };
    body.append(stats, p, keys, resetLearn, resetSeen);
  }
}

function para(text: string, cls = "") {
  const p = document.createElement("p");
  p.textContent = text;
  if (cls) p.className = cls;
  return p;
}
function button(label: string, onClick: () => void, cls = "btn") {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  b.onclick = onClick;
  return b;
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
      button("Sync now", async () => { await sync.syncNow(); renderPanel(); }),
      button("Log out this device", () => {
        if (confirm("Log out this device? Your data stays in GitHub.")) { sync.disconnect(); resetChannels(); renderPanel(); }
      }, "btn danger"),
    );
    return;
  }

  const st = sync.status();
  body.append(
    para("Log in to sync your saves, hidden channels, history and learning across devices. You only need to do this once per device."),
  );
  if (st.lastError) body.append(para(st.lastError, "error"));
  const form = document.createElement("form");
  form.className = "form";
  form.innerHTML = `<label>Password<input name="password" type="password" autocomplete="current-password"></label>`;
  const err = para("", "error");
  const go = button("Log in", () => {}, "btn primary");
  go.type = "submit";
  form.append(go, err);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    go.disabled = true;
    go.textContent = "Logging in…";
    err.textContent = "";
    const msg = await sync.connect(String(data.get("password") ?? ""));
    if (msg) {
      err.textContent = msg;
      go.disabled = false;
      go.textContent = "Log in";
    } else {
      toast("Logged in — your data is synced");
      renderPanel();
    }
  };
  body.append(form);
}

/** Channels removed/hidden/re-categorised: drop them from the upcoming queue (and skip the current one). */
function onFeedChange() {
  const gone = (s: Short) => {
    const ch = ds.channels[s.ch];
    return ch.st === "removed" || state.hidden.includes(ch.h);
  };
  queue = queue.filter((s) => !gone(s));
  if (cur && gone(cur) && el.panel.hidden && el.page.hidden) next();
}

function onSyncUpdate() {
  renderSave();
  onFeedChange();
  // Don't rebuild the Channels panel on background syncs — it would wipe what you're typing.
  if (!el.panel.hidden && panelTab !== "channels" && (panelTab !== "sync" || sync.isConnected())) renderPanel();
}

// ---------- share ----------
async function shareCurrent() {
  if (!cur) return;
  const ch = ds.channels[cur.ch];
  const url = `https://youtube.com/shorts/${cur.id}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: cur.t, text: `${cur.t} — ${ch.n}`, url });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // you closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    window.prompt("Copy this link:", url);
  }
}

// ---------- boot ----------
async function loadData(): Promise<Dataset | null> {
  try {
    const r = await fetch("data/shorts.json", { cache: "no-store" });
    if (!r.ok) return null;
    const raw = await r.json();
    return {
      generatedAt: raw.generatedAt,
      units: raw.units ?? 0,
      usage: raw.usage ?? [],
      channels: raw.channels,
      videos: raw.videos.map((a: any[]) => ({
        id: a[0], ch: a[1], t: a[2], p: a[3], v: a[4], l: a[5], c: a[6], o: a[7], e: a[8], tr: a[9], r: a[10],
      })),
    };
  } catch {
    return null;
  }
}

async function boot() {
  renderControls();
  renderMute();
  startVisit(Math.floor(nowSec()));
  sync.startSync(onSyncUpdate);
  const data = await loadData();
  if (!data || !data.videos.length) {
    showEmpty("No Shorts loaded yet.<br>Run <code>npm run fetch</code> in the reel-feed folder, then refresh this page.");
    return;
  }
  ds = data;
  initChannels(channelsCtx());
  byId = new Map(ds.videos.map((s) => [s.id, s]));
  next();
}

boot();
