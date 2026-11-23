/**
 * Touch, mouse, wheel and keyboard input on the video:
 * swipe up/down (follows your finger, snaps like Shorts), swipe left = channel, tap = pause,
 * double-tap left/right = 10 s, double-tap middle = save, hold = 2×, and keyboard shortcuts.
 */
import { state } from "./store";
import { anyModalOpen, reducedMotion } from "./a11y";
import { els } from "./view";
import { playback, pool } from "./player";
import { leaveList, exploreCurrent, feed, next, prev, upcoming } from "./feed";
import {
  fasterRate,
  noteCurrent,
  topicCurrent,
  refreshFeed,
  setRate,
  setVolume,
  showVolume,
  skip,
  slowerRate,
  toggleMute,
  togglePlay,
  toggleSave,
} from "./controls";
import { maybeAutoFull, toggleFull } from "./fullscreen";

// ---------- slide animation ----------
let animating = false;
export function animateTo(dir: 1 | -1) {
  // dir 1 = next (slides up), -1 = previous (slides down)
  if (animating) return;
  if (!upcoming(dir)) {
    if (dir === 1) next();
    snapBack();
    return;
  }
  const ms = reducedMotion() ? 0 : 200;
  animating = true;
  els.track.style.transition = ms ? `transform ${ms}ms cubic-bezier(.2,.7,.2,1)` : "none";
  els.track.style.transform = `translateY(${dir === 1 ? -100 : 100}%)`;
  window.setTimeout(() => {
    els.track.style.transition = "none";
    els.track.style.transform = "translateY(0)";
    if (dir === 1) next();
    else prev();
    animating = false;
  }, ms);
}
function snapBack() {
  els.track.style.transition = reducedMotion() ? "none" : "transform 180ms ease-out";
  els.track.style.transform = "translateY(0)";
}

// ---------- press & hold = 2× ----------
let holdTimer: number | undefined;
let holding = false;
let swiped = false;
function startHold() {
  if (!feed.cur || !playback.playing) return;
  holding = true;
  if (state.rate < 2) pool.setRate(2);
  els.speedHint.hidden = false;
  navigator.vibrate?.(8);
}
function endHold() {
  clearTimeout(holdTimer);
  if (!holding) return;
  holding = false;
  pool.setRate(state.rate);
  els.speedHint.hidden = true;
  swiped = true; // don't treat the release as a tap
}

function bindTouch() {
  const tap = els.tap;
  const drag = { on: false, x0: 0, y0: 0, t0: 0, dx: 0, dy: 0, axis: "" as "" | "x" | "y" };

  tap.addEventListener(
    "touchstart",
    (e) => {
      if (animating) return;
      const t = e.touches[0];
      Object.assign(drag, { on: true, x0: t.clientX, y0: t.clientY, t0: performance.now(), dx: 0, dy: 0, axis: "" });
      swiped = false;
      els.track.style.transition = "none";
      clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        if (drag.on && !drag.axis) startHold();
      }, 450);
    },
    { passive: true },
  );

  tap.addEventListener(
    "touchmove",
    (e) => {
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
        els.track.style.transform = `translateY(${dy}px)`;
      } else if (drag.axis === "x" && drag.dx < 0) {
        els.track.style.transform = `translateX(${Math.max(drag.dx, -80) * 0.4}px)`;
      }
    },
    { passive: true },
  );

  tap.addEventListener("touchend", () => {
    if (!drag.on) return;
    drag.on = false;
    if (holding) {
      endHold();
      snapBack();
      return;
    }
    clearTimeout(holdTimer);
    const ms = Math.max(1, performance.now() - drag.t0);
    if (drag.axis === "y") {
      swiped = true;
      const h = els.frame.clientHeight;
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
  tap.addEventListener("touchcancel", () => {
    drag.on = false;
    endHold();
    snapBack();
  });
  tap.addEventListener("touchend", maybeAutoFull); // first tap on a phone → full screen

  // Tap = pause/play. Double-tap: left third = back 10 s, right third = forward 10 s, middle = save.
  let lastClick = 0,
    lastZone = "",
    clickTimer: number | undefined;
  tap.addEventListener("click", (e) => {
    if (swiped) {
      swiped = false;
      return;
    }
    if (animating) return; // a tap during the slide animation belongs to neither video
    const r = tap.getBoundingClientRect();
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
  tap.addEventListener("mousedown", () => {
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(startHold, 450);
  });
  tap.addEventListener("mouseup", () => {
    if (holding) endHold();
    else clearTimeout(holdTimer);
  });
  tap.addEventListener("mouseleave", () => endHold());
}

function bindWheel() {
  let wheelAcc = 0,
    wheelLock = 0;
  window.addEventListener(
    "wheel",
    (e) => {
      if (anyModalOpen() || !els.tips.hidden) return;
      const t = Date.now();
      if (t < wheelLock) return;
      wheelAcc += e.deltaY;
      if (Math.abs(wheelAcc) > 40) {
        wheelLock = t + 450;
        animateTo(wheelAcc > 0 ? 1 : -1);
        wheelAcc = 0;
      }
    },
    { passive: true },
  );
}

/** Keys work only when you're on the video (not typing, no menu open). Esc in menus is handled by a11y.ts. */
function bindKeys() {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // browser shortcuts
    if (anyModalOpen()) return;
    const target = e.target as HTMLElement;
    if (["SELECT", "INPUT", "TEXTAREA"].includes(target.tagName)) return;
    // Space/Enter on a focused button presses that button, not play/pause
    const onControl = target.tagName === "BUTTON" || target.tagName === "A" || target.getAttribute("role") === "slider";
    if (e.key === "Escape" && feed.ctx) {
      leaveList();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
      case "j":
        e.preventDefault();
        animateTo(1);
        break;
      case "ArrowUp":
      case "k":
        e.preventDefault();
        animateTo(-1);
        break;
      case "ArrowRight":
      case "l":
        e.preventDefault();
        skip(10);
        break;
      case "ArrowLeft":
      case "h":
        e.preventDefault();
        skip(-10);
        break;
      case "c":
        exploreCurrent();
        break;
      case "f":
        toggleFull();
        break;
      case ">":
        setRate(fasterRate());
        break;
      case "<":
        setRate(slowerRate());
        break;
      case " ":
        if (onControl) return;
        e.preventDefault();
        togglePlay();
        break;
      case "m":
        toggleMute();
        break;
      case "+":
      case "=":
        setVolume(state.volume + 10);
        showVolume();
        break;
      case "-":
      case "_":
        setVolume(state.volume - 10);
        showVolume();
        break;
      case "s":
        toggleSave();
        break;
      case "n":
        e.preventDefault(); // so the letter doesn't land in the note's text box
        void noteCurrent();
        break;
      case "t":
        e.preventDefault();
        void topicCurrent();
        break;
      case "r":
        refreshFeed();
        break;
    }
  });
}

export function initGestures() {
  bindTouch();
  bindWheel();
  bindKeys();
  els.nextBtn.onclick = () => animateTo(1);
  els.prevBtn.onclick = () => animateTo(-1);
}
