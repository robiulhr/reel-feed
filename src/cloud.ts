/**
 * Where your data stands, in words: saved to the cloud, saving, can't reach it, or not backed up at all
 * (sync isn't connected). Shown as a dot on the Menu button when something needs you, as a line on the
 * Added page, and as the card at the top of the Activity tab.
 */
import { ago, btn, el } from "./dom";
import { state } from "./store";
import * as sync from "./sync";

export type CloudKind = "off" | "ok" | "saving" | "error" | "local";
export interface Cloud {
  kind: CloudKind;
  text: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** How things stand right now. */
export function cloudState(): Cloud {
  if (!sync.isAvailable()) return { kind: "off", text: "" };
  const st = sync.status();
  if (!st.connected) {
    const worth = state.manual.length || state.saved.length || Object.keys(state.notes).length || state.lists.some((l) => l.ch.length);
    return worth
      ? { kind: "local", text: "⚠️ Not backed up: sync isn't connected, so your videos and notes exist only in this browser." }
      : { kind: "off", text: "" };
  }
  if (st.lastError && st.pending) {
    const n = st.unsaved ? ` — ${plural(st.unsaved, "change")} not saved yet` : "";
    return { kind: "error", text: `⚠️ Couldn't reach the cloud${n}. Trying again…` };
  }
  if (st.busy || st.unsaved)
    return { kind: "saving", text: st.unsaved ? `☁️ Saving ${plural(st.unsaved, "change")} to the cloud…` : "☁️ Saving to the cloud…" };
  return { kind: "ok", text: `☁️ All saved to the cloud${st.lastSync ? ` · checked ${ago(st.lastSync / 1000)}` : ""}` };
}

let connectHook: (() => void) | undefined;
/** What the "Connect" button does (opens Menu → Sync). Set by the app. */
export function onConnectRequest(fn: () => void) {
  connectHook = fn;
}

/** A status line that keeps itself up to date while it's on screen. */
export function cloudLine(): HTMLElement {
  const box = el("div", "cloud-line");
  box.setAttribute("role", "status");
  const draw = () => {
    const c = cloudState();
    box.className = `cloud-line cloud-${c.kind}`;
    box.hidden = c.kind === "off";
    box.replaceChildren(el("span", "", c.text));
    if (c.kind === "local") box.append(btn("Connect", () => connectHook?.(), "btn sm primary"));
    if (c.kind === "error") box.append(btn("Retry now", () => void sync.syncNow(), "btn sm"));
  };
  let attached = false;
  let off: () => void = () => {};
  let timer = 0;
  const stop = () => {
    off();
    window.clearInterval(timer);
  };
  const update = () => {
    if (box.isConnected) attached = true;
    else if (attached) return stop(); // it was on screen and has left: stop listening
    draw();
  };
  draw();
  off = sync.onStatus(update);
  timer = window.setInterval(update, 30_000); // "checked 3m ago" ages by itself
  return box;
}

/** A dot on the Menu button when your data isn't safe (not backed up, or the cloud can't be reached). */
export function initCloudDot() {
  const menu = document.getElementById("menuBtn");
  if (!menu) return;
  const base = menu.getAttribute("aria-label") || "Menu";
  const draw = () => {
    const c = cloudState();
    const warn = c.kind === "local" || c.kind === "error";
    menu.dataset.cloud = warn ? c.kind : "";
    menu.setAttribute(
      "aria-label",
      warn ? `${base}, ${c.kind === "local" ? "your data is not backed up" : "the cloud can't be reached"}` : base,
    );
  };
  sync.onStatus(draw);
  window.setInterval(draw, 30_000);
  draw();
}
