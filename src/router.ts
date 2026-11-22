/**
 * Page addresses + the Back button.
 *
 *   /                      the feed            /v/VIDEO_ID         the feed, on that Short (share links)
 *   /saved, /history, …    a Menu page         /channel/handle     a channel's page (handle without @)
 *   /similar/VIDEO_ID      "More like this"
 *
 * Every screen that opens over the feed adds a step to the browser's history, so Back (Android's
 * back swipe, the browser's ←) closes the top one: a sheet or dialog, then a page, then the menu.
 * Sheets and dialogs keep the address (they're "layers"). Swiping through Shorts never adds a step
 * — the address is just updated, so a refresh keeps your place.
 *
 * This module only knows addresses; what each one shows is decided by routes.ts (onRoute).
 */

export type Route = { k: "feed"; v?: string } | { k: "panel"; tab: string } | { k: "channel"; h: string } | { k: "similar"; id: string };

/** Menu tabs and their addresses ("api" can't be /api — that's the sync server). */
const PANEL_PATHS: Record<string, string> = {
  channels: "channels",
  history: "history",
  saved: "saved",
  sorting: "sorting",
  hidden: "hidden",
  sync: "sync",
  api: "usage",
  backups: "backups",
  about: "about",
};
const PANEL_BY_PATH = Object.fromEntries(Object.entries(PANEL_PATHS).map(([tab, p]) => [p, tab]));
const VIDEO_ID = /^[\w-]{6,20}$/;

/** Where the app lives ("/" on Cloudflare, "/reel-feed/" on GitHub Pages). */
export const BASE = (import.meta.env?.BASE_URL as string | undefined) ?? "/";

export function parse(pathname: string, base = BASE): Route {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\//, "");
  const [a = "", b = ""] = rest.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return "";
    }
  });
  if (a === "v" && VIDEO_ID.test(b)) return { k: "feed", v: b };
  if (a === "channel" && b.replace(/^@/, "")) return { k: "channel", h: b.replace(/^@/, "") }; // old links had the @
  if (a === "similar" && VIDEO_ID.test(b)) return { k: "similar", id: b };
  if (PANEL_BY_PATH[a]) return { k: "panel", tab: PANEL_BY_PATH[a] };
  return { k: "feed" };
}

export function toPath(r: Route, base = BASE): string {
  const enc = encodeURIComponent;
  if (r.k === "feed") return r.v ? `${base}v/${enc(r.v)}` : base;
  if (r.k === "panel") return `${base}${PANEL_PATHS[r.tab] ?? "history"}`;
  // no "@": Cloudflare redirects /channel/@x to /channel/%40x — an extra round trip and an ugly link
  if (r.k === "channel") return `${base}channel/${enc(r.h.replace(/^@/, ""))}`;
  return `${base}similar/${enc(r.id)}`;
}

/** Full link to share (works for anyone who opens it). */
export const shareLink = (videoId: string) => new URL(toPath({ k: "feed", v: videoId }), location.origin).href;

// ---------- history entries ----------
interface Entry {
  d: number; // steps above the first entry (0 = the bottom, Back leaves the app)
  list?: boolean; // swiping through a list (a channel's Shorts, History, …)
  layer?: number; // a sheet or dialog (same address)
}
const entry = (): Entry => (history.state && typeof history.state.d === "number" ? history.state : { d: 0 });

type OnRoute = (r: Route, e: Entry) => void;
let onRoute: OnRoute = () => {};
let applying = false;
let ignorePops = 0;

/** Layers (sheets, dialogs) that are open, bottom → top. */
const layers: { id: number; d: number; close: () => void }[] = [];
let nextLayer = 1;
const isDeadLayer = (e: Entry) => !!e.layer && !layers.some((l) => l.id === e.layer);

export const current = () => parse(location.pathname);
export const inList = () => !!entry().list;

/**
 * Show a new screen's address. Same address → just updated (re-render, switching menu tabs).
 * Called while following Back/Forward → only updated (the browser already moved).
 */
export function go(r: Route, o: { list?: boolean; replace?: boolean } = {}) {
  const path = toPath(r);
  const e = entry();
  const same = path === location.pathname && !e.layer && !!e.list === !!o.list;
  if (applying || o.replace || same || isDeadLayer(e)) {
    // a closed sheet's step is reused, so Back never lands on "nothing"
    history.replaceState({ d: e.d, ...(o.list ? { list: true } : {}) }, "", path);
    return;
  }
  history.pushState({ d: e.d + 1, ...(o.list ? { list: true } : {}) }, "", path);
}

/** The feed moved to another Short: update the address (no new Back step). */
export function setFeed(id: string | undefined) {
  if (current().k !== "feed" || entry().layer) return;
  const path = toPath({ k: "feed", v: id });
  if (path !== location.pathname) history.replaceState(entry(), "", path);
}

/** You closed the top screen yourself (✕, tap outside, ← back): same as pressing Back. */
export function dismiss() {
  if (entry().d > 0) {
    history.back();
    return;
  }
  // opened straight from a link with nothing underneath: go to the feed in place
  history.replaceState({ d: 0 }, "", toPath({ k: "feed" }));
  apply();
}

/**
 * A sheet or dialog opened: Back should close it. `close` closes it without touching history.
 * Returns `closed()` — call it when it closes by itself (choice made, ✕, tap outside).
 */
export function pushLayer(close: () => void): () => void {
  const id = nextLayer++;
  const e = entry();
  const reuse = isDeadLayer(e); // a sheet that just closed opened this one: take over its step
  const d = reuse ? e.d : e.d + 1;
  layers.push({ id, d, close });
  if (reuse) history.replaceState({ d, layer: id }, "", location.pathname);
  else history.pushState({ d, layer: id }, "", location.pathname);
  return () => {
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return; // already closed by Back
    layers.splice(i, 1);
    // Take its step back out — unless something opened from it in the meantime (that reuses the step).
    setTimeout(() => {
      if (entry().layer === id) {
        ignorePops++;
        history.back();
      }
    }, 0);
  };
}

function apply() {
  applying = true;
  try {
    onRoute(current(), entry());
  } finally {
    applying = false;
  }
}

function onPop() {
  const e = entry();
  // close sheets/dialogs above where we are now (top first)
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.d > e.d || (l.d === e.d && e.layer !== l.id)) {
      layers.splice(i, 1);
      l.close();
    }
  }
  if (ignorePops > 0) {
    ignorePops--;
    return;
  }
  if (isDeadLayer(e)) {
    // landed on the step of a sheet that's already closed: skip over it
    ignorePops++;
    history.back();
    apply();
    return;
  }
  apply();
}

/**
 * Start listening. If the app was opened on a deeper address (a link to /saved, /channel/…), the
 * feed is put underneath it, so Back goes to the feed instead of leaving the app.
 * Returns the address the app was opened on.
 */
export function startRouter(handler: OnRoute): Route {
  onRoute = handler;
  const first = current();
  const e = entry();
  if (first.k !== "feed" && e.d === 0) {
    const path = location.pathname;
    history.replaceState({ d: 0 }, "", toPath({ k: "feed" }));
    history.pushState({ d: 1 }, "", path);
  } else if (e.list || e.layer) {
    // a refresh while in a list or sheet: those aren't restored
    history.replaceState({ d: e.d }, "", location.pathname);
  }
  window.addEventListener("popstate", onPop);
  return first;
}

/** Follow the current address now (after the data has loaded). */
export const applyCurrent = apply;
