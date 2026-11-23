/**
 * Player controls: play/pause, 10 s skip, the progress bar (drag to jump), speed, sound
 * (mute + volume), save, share, and refresh / "Get newer".
 */
import { shareLink } from "./router";
import { videoCats } from "./rank";
import { act, learn, persist, state } from "./store";
import { undoable } from "./backup";
import * as sync from "./sync";
import { checkForUpdate } from "./data";
import { infoDialog, once, toast, toastError } from "./ui";
import { ago, el, fmtTime } from "./dom";
import { els, flashIcon } from "./view";
import { playback, playerHooks, pool } from "./player";
import { applyData, feed, latestVersion, offerData, renderMeta, renderSave, resetFeed } from "./feed";

export function togglePlay() {
  if (!feed.cur) return;
  if (playback.playing) {
    pool.pause();
    flashIcon("▶");
  } else {
    pool.play();
    els.centerIcon.className = "center-icon";
  }
}

// ---------- skip + progress bar ----------
/** Skip forward/back (seconds). Skipped seconds don't count as "watched" for learning. */
export function skip(sec: number) {
  if (!feed.cur) return;
  const t = pool.time();
  if (sec > 0) playback.watch.skipped += Math.min(sec, Math.max(0, pool.duration() - t));
  pool.seek(t + sec);
  flashSkip(sec);
}
let skipTimer: number | undefined;
function flashSkip(sec: number) {
  els.skipHint.textContent = sec > 0 ? `${sec}s ⏩` : `⏪ ${-sec}s`;
  els.skipHint.className = `skip-hint show ${sec > 0 ? "right" : "left"}`;
  clearTimeout(skipTimer);
  skipTimer = window.setTimeout(() => (els.skipHint.className = "skip-hint"), 650);
}

let scrubbing = false;
function scrubTo(clientX: number, commit: boolean) {
  const r = els.progress.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  const d = pool.duration();
  els.bar.style.width = `${f * 100}%`;
  els.scrubTime.hidden = !d || commit;
  if (d) els.scrubTime.textContent = `${fmtTime(f * d)} / ${fmtTime(d)}`;
  if (commit && d) {
    const t = pool.time();
    if (f * d > t) playback.watch.skipped += f * d - t;
    pool.seek(f * d);
  }
}

function bindProgress() {
  const p = els.progress;
  // A slider for screen readers and keyboards (←/→ while it has focus = 5 s).
  p.setAttribute("role", "slider");
  p.setAttribute("aria-label", "Video position");
  p.setAttribute("aria-valuemin", "0");
  p.tabIndex = 0;
  p.addEventListener("pointerdown", (e) => {
    if (!feed.cur) return;
    scrubbing = true;
    p.classList.add("scrubbing");
    p.setPointerCapture(e.pointerId);
    scrubTo(e.clientX, false);
  });
  p.addEventListener("pointermove", (e) => {
    if (scrubbing) scrubTo(e.clientX, false);
  });
  const endScrub = (e: PointerEvent) => {
    if (!scrubbing) return;
    scrubbing = false;
    p.classList.remove("scrubbing");
    scrubTo(e.clientX, true);
  };
  p.addEventListener("pointerup", endScrub);
  p.addEventListener("pointercancel", endScrub);
  p.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation(); // not "next Short"
    skip(step);
  });

  let lastSec = -1;
  setInterval(() => {
    if (!feed.cur || scrubbing) return;
    const t = pool.time();
    const d = pool.duration();
    if (t > playback.watch.maxT) playback.watch.maxT = t;
    els.bar.style.width = d ? `${Math.min(100, (t / d) * 100)}%` : "0";
    if (Math.floor(t) !== lastSec) {
      lastSec = Math.floor(t);
      p.setAttribute("aria-valuemax", String(Math.round(d)));
      p.setAttribute("aria-valuenow", String(lastSec));
      p.setAttribute("aria-valuetext", d ? `${fmtTime(t)} of ${fmtTime(d)}` : "loading");
    }
  }, 200);
}

// ---------- speed ----------
export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
export function setRate(r: number) {
  state.rate = r;
  persist();
  pool.setRate(r);
  renderMeta();
  toast(r === 1 ? "Normal speed" : `Speed ${r}×`);
}
export const fasterRate = () => RATES.find((r) => r > state.rate) ?? 2;
export const slowerRate = () => [...RATES].reverse().find((r) => r < state.rate) ?? 0.5;

// ---------- sound: mute + volume ----------
const volIcon = () => (state.muted || state.volume === 0 ? "🔇" : state.volume < 34 ? "🔈" : state.volume < 67 ? "🔉" : "🔊");
export function renderMute() {
  els.muteBtn.querySelector(".ico")!.textContent = volIcon();
  els.muteBtn.classList.toggle("pulse", state.muted);
  els.muteBtn.setAttribute("aria-pressed", String(state.muted));
  for (const r of document.querySelectorAll<HTMLInputElement>(".vol-range")) {
    r.value = String(state.muted ? 0 : state.volume);
    r.setAttribute("aria-valuetext", state.muted ? "Muted" : `${state.volume}%`);
  }
  for (const t of document.querySelectorAll<HTMLElement>(".vol-pct")) t.textContent = state.muted ? "Muted" : `${state.volume}%`;
  for (const b of document.querySelectorAll<HTMLElement>(".vol-mute")) b.textContent = state.muted ? "🔇 Unmute" : "🔊 Mute";
}
// The browser only allows sound after a tap on the page: show the video as muted, one tap turns sound on.
playerHooks.onSoundBlocked = () => {
  if (state.muted) return;
  state.muted = true;
  renderMute();
  toast("Your browser started it without sound — tap 🔇 for sound");
};

export function toggleMute() {
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
export function setVolume(v: number) {
  state.volume = Math.max(0, Math.min(100, Math.round(v)));
  pool.setVolume(state.volume);
  if (state.volume === 0 && !state.muted) {
    state.muted = true;
    pool.mute();
  } else if (state.volume > 0 && state.muted) {
    state.muted = false;
    pool.unMute();
  }
  renderMute();
  persist();
}
let volTimer: number | undefined;
function keepVolume() {
  clearTimeout(volTimer);
  volTimer = window.setTimeout(() => {
    // don't yank the slider away from a keyboard user who is using it
    if (els.volPop.contains(document.activeElement)) return keepVolume();
    els.volPop.hidden = true;
  }, 3000);
}
export function showVolume() {
  els.volPop.hidden = false;
  renderMute();
  keepVolume();
}

function bindSound() {
  for (const range of document.querySelectorAll<HTMLInputElement>(".vol-range")) {
    range.addEventListener("input", () => {
      setVolume(Number(range.value));
      keepVolume();
    });
  }
  for (const b of document.querySelectorAll<HTMLElement>(".vol-mute")) {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMute();
      keepVolume();
    });
  }
  els.volPop.addEventListener("pointerdown", () => keepVolume());

  // Sound button: tap = mute/unmute, press & hold = volume slider
  let volHold: number | undefined;
  let volHeld = false;
  els.muteBtn.addEventListener("pointerdown", () => {
    volHeld = false;
    volHold = window.setTimeout(() => {
      volHeld = true;
      showVolume();
    }, 400);
  });
  els.muteBtn.addEventListener("pointerup", () => clearTimeout(volHold));
  els.muteBtn.addEventListener("pointerleave", () => clearTimeout(volHold));
  els.muteBtn.addEventListener("contextmenu", (e) => e.preventDefault());
  els.muteBtn.onclick = () => {
    if (volHeld) {
      volHeld = false;
      return;
    }
    toggleMute();
  };
}

// ---------- save + share ----------
export function toggleSave(forceOn = false) {
  const cur = feed.cur;
  if (!cur) return;
  const isSaved = state.saved.includes(cur.id);
  if (isSaved && !forceOn) {
    const i = state.saved.indexOf(cur.id);
    act({ t: "unsave", id: cur.id });
    undoable("Removed from saved", () => {
      act({ t: "save", id: cur.id, i });
      renderSave();
    });
  } else if (!isSaved) {
    act({ t: "save", id: cur.id });
    const ch = feed.ds.channels[cur.ch];
    if (ch) learn(ch, videoCats(cur, state)[0], 2);
    navigator.vibrate?.(12);
    toast("Saved");
  }
  if (forceOn) flashIcon("♥", true);
  renderSave();
}

/** Share is a choice of two links: the Ecomgy one, or the video's own address on YouTube / Facebook. */
function shareCurrent() {
  const cur = feed.cur;
  if (!cur) return;
  const ch = feed.ds.channels[cur.ch];
  const original = cur.fb ? cur.fb.url : `https://www.youtube.com/shorts/${cur.id}`;
  const box = el("div", "share-opts");
  const option = (title: string, hint: string, url: string) => {
    const b = el("button", "share-opt");
    b.type = "button";
    b.append(el("strong", "", title), el("span", "", hint));
    b.onclick = () => {
      for (const x of document.querySelectorAll<HTMLButtonElement>(".dlg-overlay button")) if (x.textContent === "Close") x.click();
      void sendLink(url, cur.t, `${cur.t} — ${ch?.n ?? ""}`);
    };
    return b;
  };
  box.append(
    option(
      "Ecomgy link",
      "Shows a preview card in chats. People with the password open it in the app; everyone else goes to the video.",
      shareLink(cur.id),
    ),
    option(cur.fb ? "Original Facebook link" : "Original YouTube link", "The video's own page. Works for anyone, no password.", original),
  );
  void infoDialog("Share this video", box);
}

async function sendLink(url: string, title: string, text: string) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
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
    input.setAttribute("aria-label", "Link to this Short");
    input.onfocus = () => input.select();
    infoDialog("Copy this link", input);
    setTimeout(() => input.select(), 50);
  }
}

// ---------- refresh ----------
let refreshing = false;
export async function refreshFeed() {
  if (refreshing) return;
  refreshing = true;
  els.refreshBtn.classList.add("spinning");
  els.refreshBtn.setAttribute("aria-busy", "true");
  try {
    if (feed.pendingData) {
      applyData(feed.pendingData);
      return;
    }
    const r = await checkForUpdate(feed.ds.generatedAt, (d) => applyData(d));
    if (r === "new") return; // applyData showed the message
    if (r === "offline") {
      toast("You're offline — showing your saved Shorts");
      return;
    }
    resetFeed();
    toast(
      `Fresh feed ✓ · Shorts updated ${ago(feed.ds.generatedAt)}`,
      sync.isConnected() ? { label: "Get newer", run: fetchFromYouTube } : undefined,
    );
  } finally {
    refreshing = false;
    els.refreshBtn.classList.remove("spinning");
    els.refreshBtn.removeAttribute("aria-busy");
  }
}

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
      if (++n > 16) {
        clearInterval(watchTimer);
        return;
      }
      const r = await checkForUpdate(latestVersion(), offerData);
      if (r === "new") clearInterval(watchTimer);
    }, 45_000);
  } catch (e) {
    toastError(e instanceof Error ? e.message : "Couldn't start the refresh", () => fetchFromYouTube());
  }
}

/** Opens the note sheet for the video on screen (the notes code is only downloaded the first time). */
export async function noteCurrent() {
  const cur = feed.cur;
  if (!cur) return;
  try {
    const m = await import("./notes");
    await m.editNote(cur.id, cur.t);
  } catch {
    toast("Couldn't open notes — check your connection and try again");
  }
}

export function initControls() {
  bindProgress();
  bindSound();
  els.saveBtn.onclick = () => toggleSave();
  els.noteBtn.onclick = () => void noteCurrent();
  els.shareBtn.onclick = shareCurrent;
  els.refreshBtn.onclick = refreshFeed;
}
