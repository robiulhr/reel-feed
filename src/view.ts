/** The page's fixed elements (from index.html) and small visual feedback helpers. */
import { byId as $ } from "./dom";

export const els = {
  frame: $("frame"),
  track: $("track"),
  players: $("players"),
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
  tipsOk: $<HTMLButtonElement>("tipsOk"),
  tabs: $("tabs"),
  filtBtn: $<HTMLButtonElement>("filtBtn"),
  chips: $("chips"),
  refreshBtn: $<HTMLButtonElement>("refreshBtn"),
  menuBtn: $<HTMLButtonElement>("menuBtn"),
  muteBtn: $<HTMLButtonElement>("muteBtn"),
  saveBtn: $<HTMLButtonElement>("saveBtn"),
  shareBtn: $<HTMLButtonElement>("shareBtn"),
  moreBtn: $<HTMLButtonElement>("moreBtn"),
  moreSheet: $("moreSheet"),
  fsBtn: $<HTMLButtonElement>("fsBtn"),
  page: $("page"),
  pageTitle: $("pageTitle"),
  pageBody: $("pageBody"),
  pageClose: $<HTMLButtonElement>("pageClose"),
  ctxBar: $("ctxBar"),
  ctxBack: $<HTMLButtonElement>("ctxBack"),
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
  closePanel: $<HTMLButtonElement>("closePanel"),
  prevBtn: $<HTMLButtonElement>("prevBtn"),
  nextBtn: $<HTMLButtonElement>("nextBtn"),
};

// ---------- banner (new Shorts / offline / new app version) ----------
let bannerAction: (() => void) | null = null;
export function banner(msg: string | null, onTap?: () => void) {
  els.banner.hidden = !msg;
  els.banner.textContent = msg ?? "";
  bannerAction = onTap ?? null;
  els.banner.classList.toggle("tappable", !!onTap);
}
els.banner.onclick = () => bannerAction?.();

export function flashIcon(symbol: string, pop = false) {
  els.centerIcon.textContent = symbol;
  els.centerIcon.className = `center-icon ${pop ? "pop" : "show"}`;
  if (pop) setTimeout(() => (els.centerIcon.className = "center-icon"), 600);
}

let spinTimer: number | undefined;
/** Show the loading spinner only if loading takes a moment (no flicker on fast loads). */
export function showSpinner(on: boolean) {
  clearTimeout(spinTimer);
  if (on) spinTimer = window.setTimeout(() => (els.spinner.hidden = false), 450);
  else els.spinner.hidden = true;
}

export function showEmpty(html: string) {
  els.empty.innerHTML = html;
  els.empty.hidden = false;
}

/** Thumbnail: big vertical one for the poster on good connections; small (~15 KB) everywhere else. */
export function setThumb(img: HTMLImageElement, id: string, big: boolean) {
  const small = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  img.onerror = big
    ? () => {
        img.onerror = null;
        img.src = small;
      }
    : null;
  img.src = big ? `https://i.ytimg.com/vi/${id}/oar2.jpg` : small;
}
export const thumb = (img: HTMLImageElement, id: string) => setThumb(img, id, false);
