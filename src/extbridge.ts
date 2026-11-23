/**
 * Tells the Reel Feed browser extension which Facebook videos you've already added, so its panel can
 * mark them. The extension has one small script that runs only on this site; it listens for this
 * message and keeps the list of ids. Only the public Facebook video numbers are sent, and only to this
 * very page (same origin) — the extension never gets your account, notes or anything else.
 *
 * Sent when the app starts, whenever the added videos change (add, delete, undo, sync), and when the
 * extension says hello (it may have been installed or reloaded after the app opened).
 */
import { state } from "./store";

let last = "";

/** Posts the ids of the added Facebook videos (only when they changed, unless `force`). */
export function announceAdded(force = false) {
  const ids = state.manual.map((m) => m.id);
  const key = ids.join(",");
  if (!force && key === last) return;
  last = key;
  window.postMessage({ source: "reel-feed-app", t: "library", ids }, location.origin);
}

export function startExtBridge() {
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.source === "reel-feed-ext" && e.data.t === "hello") announceAdded(true);
  });
  announceAdded(true);
}
