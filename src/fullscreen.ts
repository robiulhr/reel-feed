/**
 * Full screen. On phones the browser's address bar stays because the page never scrolls; the
 * Fullscreen API hides it (Android Chrome etc.). Installed as an app, the manifest opens it full screen anyway.
 */
import { state } from "./store";
import { els } from "./view";

export const isStandalone = () =>
  matchMedia("(display-mode: fullscreen)").matches || matchMedia("(display-mode: standalone)").matches || !!(navigator as any).standalone;
const isPhone = () => matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820;
const canFull = () => !!document.documentElement.requestFullscreen && document.fullscreenEnabled && !isStandalone();

let fullDeclined = false; // you left full screen yourself → don't push it again this session
let wasFull = false;

async function enterFull() {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" } as FullscreenOptions);
    (screen.orientation as any)?.lock?.("portrait").catch(() => {});
  } catch {
    /* not allowed here (e.g. iPhone Safari) */
  }
}

export function toggleFull() {
  if (document.fullscreenElement) {
    fullDeclined = true;
    document.exitFullscreen().catch(() => {});
  } else enterFull();
}

function renderFsBtn() {
  // lives in the ⋯ menu (the top bar had no room for it on phones)
  els.fsBtn.hidden = !canFull();
  els.fsBtn.textContent = document.fullscreenElement ? "🗗 Exit full screen" : "⛶ Full screen";
}

/** First tap on a phone → full screen (needs a tap; browsers don't allow it on page load). */
export function maybeAutoFull() {
  if (state.autoFull && !fullDeclined && !document.fullscreenElement && canFull() && isPhone()) enterFull();
}

export function initFullscreen() {
  els.fsBtn.onclick = toggleFull;
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && wasFull) fullDeclined = true;
    wasFull = !!document.fullscreenElement;
    renderFsBtn();
  });
  renderFsBtn();
}
