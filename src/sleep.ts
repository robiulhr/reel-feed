/**
 * Sleep mode (⋯ → 🌙 Sleep timer & dim screen): play on while you fall asleep. A timer stops the video
 * (the volume fades out over the last 20 seconds, or it stops when the list ends), the screen is kept
 * awake (a phone that locks its screen stops the embedded players) and dimmed to a black screen with a
 * small clock. Tap the black screen to show the buttons. Loaded only when used.
 */
import { btn, el } from "./dom";
import { feed, sleepGate } from "./feed";
import { pool } from "./player";
import { state } from "./store";
import { confirmDialog, toast } from "./ui";

interface Sleep {
  endAt: number | null; // when to stop (ms), null = no timer
  atListEnd: boolean; // stop when the list that is playing ends
  dim: boolean;
}
let active: Sleep | null = null;
let tick: number | undefined;
let lock: { release(): Promise<void>; addEventListener(t: string, f: () => void): void } | null = null;
let overlay: HTMLElement | null = null;
let pill: HTMLButtonElement | null = null;
let peekTimer: number | undefined;
const FADE_S = 20;

const MINUTES = [15, 30, 45, 60, 90, 120];
const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const left = () => (active?.endAt ? Math.max(0, active.endAt - Date.now()) : null);
function leftText(): string {
  if (!active) return "";
  const ms = left();
  if (ms === null) return active.atListEnd ? "Stops when the list ends" : "No timer";
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? `Stops in ${Math.floor(m / 60)} h ${m % 60} min` : `Stops in ${m} min`;
}

async function keepAwake() {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<typeof lock> } }).wakeLock;
    if (!wl) {
      toast("This browser can't keep the screen on — turn off auto-lock in your phone's settings");
      return;
    }
    lock = await wl.request("screen");
    lock?.addEventListener("release", () => {
      lock = null;
    });
  } catch {
    /* refused (low battery mode…): the timer still works */
  }
}
document.addEventListener("visibilitychange", () => {
  if (active && document.visibilityState === "visible" && !lock) void keepAwake(); // the lock ends when the page is hidden
});

function draw() {
  if (!active) return;
  const t = leftText();
  if (overlay) {
    overlay.querySelector(".sleep-clock")!.textContent = clock();
    overlay.querySelector(".sleep-left")!.textContent = t;
  }
  if (pill) pill.textContent = `🌙 ${t.replace("Stops in ", "").replace("Stops when the list ends", "list end")}`;
}

function update() {
  const ms = left();
  if (ms !== null) {
    if (ms <= 0) return finish();
    if (ms <= FADE_S * 1000 && !state.muted) pool.setVolume(Math.max(1, Math.round((state.volume * ms) / (FADE_S * 1000)))); // fade out
  }
  draw();
}

function finish() {
  pool.pause();
  stopSleep();
  toast("Sleep timer finished — good night 🌙", undefined, 8000);
}

function stopSleep() {
  clearInterval(tick);
  clearTimeout(peekTimer);
  window.removeEventListener("reel-list-ended", onListEnded);
  sleepGate.atListEnd = false;
  void lock?.release().catch(() => {});
  lock = null;
  overlay?.remove();
  overlay = null;
  pill?.remove();
  pill = null;
  active = null;
  if (!state.muted) pool.setVolume(state.volume); // back from the fade
}

function onListEnded() {
  if (active?.atListEnd) finish();
}

function showPill() {
  if (pill || !active) return;
  pill = el("button", "sleep-pill");
  pill.type = "button";
  pill.setAttribute("aria-label", "Sleep mode is on — tap for options");
  pill.onclick = () => void openSleep();
  document.body.append(pill);
  draw();
}

function showOverlay() {
  if (overlay || !active) return;
  pill?.remove();
  pill = null;
  const o = el("div", "sleep-screen");
  o.setAttribute("role", "region");
  o.setAttribute("aria-label", "Sleep mode: the screen is dimmed. Tap to show the buttons.");
  o.tabIndex = 0;
  const buttons = el("div", "sleep-btns");
  buttons.append(
    btn("☀ Wake up", () => hideOverlay(), "btn"),
    btn("+ 15 min", () => addTime(15), "btn"),
    btn(
      "Stop",
      () => {
        stopSleep();
        toast("Sleep mode off");
      },
      "btn danger",
    ),
  );
  o.append(el("div", "sleep-clock"), el("div", "sleep-left"), buttons, el("div", "sleep-hint", "Tap the screen to show the buttons"));
  const peek = () => {
    o.classList.add("show-btns");
    clearTimeout(peekTimer);
    peekTimer = window.setTimeout(() => o.classList.remove("show-btns"), 6000);
  };
  o.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    peek();
  });
  document.body.append(o);
  overlay = o;
  draw();
}

function hideOverlay() {
  overlay?.remove();
  overlay = null;
  showPill();
}

function addTime(min: number) {
  if (!active) return;
  active.endAt = Math.max(Date.now(), active.endAt ?? Date.now()) + min * 60000;
  if (!state.muted) pool.setVolume(state.volume);
  toast(`+${min} min`);
  draw();
}

function startSleep(s: Sleep) {
  stopSleep();
  active = s;
  sleepGate.atListEnd = s.atListEnd;
  window.addEventListener("reel-list-ended", onListEnded);
  void keepAwake();
  if (s.dim) showOverlay();
  else showPill();
  tick = window.setInterval(update, 1000);
  draw();
  toast(s.dim ? "Sleep mode on — tap the black screen for buttons" : "Sleep mode on — the screen stays awake");
}

/** The ⋯ sheet's sleep button: set it up, or (when it's already on) see how long is left. */
export async function openSleep(): Promise<void> {
  if (active) return statusSheet();
  const box = el("div", "sleep-opts");
  let minutes: number | null = 30;
  let atListEnd = false;
  const chips = el("div", "chips sleep-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Stop after");
  const options: [string, number | null | "list"][] = [
    ...MINUTES.map((m): [string, number] => [m >= 60 ? `${m / 60} h` : `${m} min`, m]),
    ["No timer", null],
  ];
  if (feed.ctx) options.push(["After this list", "list"]);
  let picked: number | null | "list" = 30;
  const drawChips = () => {
    chips.replaceChildren();
    for (const [label, v] of options) {
      const b = btn(
        label,
        () => {
          picked = v;
          drawChips();
        },
        picked === v ? "on" : "",
      );
      b.setAttribute("aria-pressed", String(picked === v));
      chips.append(b);
    }
  };
  drawChips();
  const dimRow = el("label", "sleep-dim");
  const dimBox = el("input");
  dimBox.type = "checkbox";
  dimBox.checked = true;
  dimRow.append(dimBox, el("span", "", "Dim the screen to black (it stays awake). Plug in your phone."));
  box.append(
    el(
      "p",
      "ch-note",
      "Plays on while you sleep. The volume fades out at the end. Pick Repeat or Next under ⋯ → When it ends, so it doesn't stop earlier.",
    ),
    chips,
    dimRow,
  );
  const ok = await confirmDialog({ title: "🌙 Sleep timer", extra: box, confirm: "Start", cancel: "Cancel", variant: "sheet" });
  if (!ok) return;
  const choice = picked as number | null | "list"; // (set by the chips above)
  minutes = typeof choice === "number" ? choice : null;
  atListEnd = choice === "list";
  startSleep({ endAt: minutes ? Date.now() + minutes * 60000 : null, atListEnd, dim: dimBox.checked });
}

async function statusSheet() {
  const box = el("div", "sleep-opts");
  box.append(el("p", "", leftText()));
  const row = el("div", "sleep-btns-row");
  const close = () => {
    for (const x of document.querySelectorAll<HTMLButtonElement>(".dlg-overlay button")) if (x.textContent === "Close") x.click();
  };
  row.append(
    btn("+ 15 min", () => {
      addTime(15);
      close();
    }),
    btn(overlay ? "☀ Wake up" : "🌑 Dim the screen", () => {
      close();
      if (overlay) hideOverlay();
      else showOverlay();
    }),
    btn(
      "Stop sleep mode",
      () => {
        close();
        stopSleep();
        toast("Sleep mode off");
      },
      "btn danger",
    ),
  );
  box.append(row);
  await confirmDialog({ title: "🌙 Sleep mode is on", extra: box, confirm: "", cancel: "Close", variant: "sheet" });
}
