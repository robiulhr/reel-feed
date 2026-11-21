/**
 * Small shared UI toolkit used by every screen:
 *  - toast(): a message queue — messages show one after another instead of overwriting each other;
 *    errors stay longer and can be dismissed.
 *  - confirmDialog() / infoDialog(): the app's own dialogs (instead of the browser's confirm/prompt,
 *    which look out of place and misbehave in the installed app).
 *  - busy(): locks a button while its action runs, so double taps can't run it twice.
 *  - latest(): "only the newest request counts" helper for searches/lookups.
 */
import { holdFocus } from "./a11y";

type Kind = "info" | "error";
interface ToastItem {
  msg: string;
  action?: { label: string; run: () => void };
  ms: number;
  kind: Kind;
}

const queue: ToastItem[] = [];
let showing: ToastItem | null = null;
let hideTimer: number | undefined;

function toastEl() {
  return document.getElementById("toast")!;
}

function showNext() {
  const box = toastEl();
  showing = queue.shift() ?? null;
  if (!showing) {
    box.hidden = true;
    return;
  }
  const item = showing;
  box.className = `toast${item.kind === "error" ? " error" : ""}`;
  box.replaceChildren(Object.assign(document.createElement("span"), { textContent: item.msg }));
  if (item.action) {
    const b = document.createElement("button");
    b.textContent = item.action.label;
    b.onclick = () => {
      item.action!.run();
      dismiss();
    };
    box.append(b);
  }
  if (item.kind === "error") {
    const x = document.createElement("button");
    x.className = "toast-x";
    x.textContent = "✕";
    x.setAttribute("aria-label", "Dismiss");
    x.onclick = dismiss;
    box.append(x);
  }
  box.setAttribute("role", item.kind === "error" ? "alert" : "status");
  box.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(dismiss, item.ms);
}

function dismiss() {
  clearTimeout(hideTimer);
  showing = null;
  // a short gap so consecutive messages are noticed as separate
  toastEl().hidden = true;
  if (queue.length) window.setTimeout(showNext, 150);
}

/** Show a message. Identical messages aren't repeated; info messages don't pile up behind each other. */
export function toast(msg: string, action?: { label: string; run: () => void }, ms?: number, kind: Kind = "info") {
  const item: ToastItem = { msg, action, kind, ms: ms ?? (kind === "error" ? 8000 : action ? 6000 : 2600) };
  if (showing?.msg === msg || queue.some((q) => q.msg === msg)) return;
  // A new normal message replaces an older normal one (it's out of date — e.g. "Removed… Undo"
  // after you already restored). Error messages are never replaced; they wait or stay until dismissed.
  if (kind === "info") {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === "info") queue.splice(i, 1);
    if (showing && showing.kind === "info") {
      queue.unshift(item);
      dismissNow();
      return;
    }
  }
  queue.push(item);
  if (queue.length > 4) queue.splice(0, queue.length - 4);
  if (!showing) showNext();
}
function dismissNow() {
  clearTimeout(hideTimer);
  showing = null;
  showNext();
}

export function toastError(msg: string, retry?: () => void) {
  toast(msg, retry ? { label: "Try again", run: retry } : undefined, 9000, "error");
}

// ---------- dialogs ----------
interface DialogOptions {
  title: string;
  body?: string;
  confirm?: string;
  cancel?: string;
  danger?: boolean;
  extra?: HTMLElement;
}

/** Resolves true if confirmed. Esc / tapping outside = cancel. */
export function confirmDialog(o: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dlg-overlay";
    const box = document.createElement("div");
    box.className = "dlg";
    const h = Object.assign(document.createElement("div"), { className: "dlg-title", textContent: o.title });
    box.append(h);
    if (o.body) box.append(Object.assign(document.createElement("p"), { className: "dlg-body", textContent: o.body }));
    if (o.extra) box.append(o.extra);
    const row = Object.assign(document.createElement("div"), { className: "dlg-actions" });
    const no = Object.assign(document.createElement("button"), { className: "btn", textContent: o.cancel ?? "Cancel", type: "button" });
    row.append(no);
    let yes: HTMLButtonElement | null = null;
    if (o.confirm !== "") {
      yes = Object.assign(document.createElement("button"), {
        className: `btn ${o.danger ? "danger-solid" : "primary"}`,
        textContent: o.confirm ?? "OK",
        type: "button",
      });
      row.append(yes);
    }
    box.append(row);
    overlay.append(box);
    const release = holdFocus(overlay, box, o.title, () => done(false));
    const done = (v: boolean) => {
      document.removeEventListener("keydown", onEnter, true);
      overlay.remove();
      release();
      resolve(v);
    };
    // Enter confirms — unless focus is on another button (Enter on "Cancel" must cancel, not confirm)
    const onEnter = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !yes) return;
      const a = document.activeElement;
      if (a instanceof HTMLButtonElement && a !== yes) return;
      e.preventDefault();
      e.stopPropagation();
      done(true);
    };
    document.addEventListener("keydown", onEnter, true);
    overlay.onclick = (e) => {
      if (e.target === overlay) done(false);
    };
    no.onclick = () => done(false);
    if (yes) yes.onclick = () => done(true);
    document.body.append(overlay);
    (yes ?? no).focus();
  });
}

/** A dialog that just shows something (e.g. a link to copy), with a Close button. */
export function infoDialog(title: string, extra: HTMLElement) {
  return confirmDialog({ title, extra, confirm: "", cancel: "Close" });
}

// ---------- busy buttons ----------
/**
 * Runs `fn` with the button locked (disabled + "busyLabel"). A second tap while it runs is ignored.
 * Returns fn's result, or undefined if the button was already busy.
 */
export async function busy<T>(btn: HTMLButtonElement | null | undefined, busyLabel: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (btn?.dataset.busy) return undefined;
  const label = btn?.textContent ?? "";
  if (btn) {
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    if (busyLabel) btn.textContent = busyLabel;
  }
  try {
    return await fn();
  } finally {
    // Always unlock — even if the action failed or the screen was redrawn meanwhile.
    if (btn) {
      delete btn.dataset.busy;
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      if (busyLabel) btn.textContent = label;
    }
  }
}

/** Guards a non-button action (e.g. a keyboard shortcut) so it can't run twice at once. */
export function once<A extends unknown[]>(fn: (...a: A) => Promise<unknown>) {
  let running = false;
  return async (...a: A) => {
    if (running) return;
    running = true;
    try {
      await fn(...a);
    } finally {
      running = false;
    }
  };
}

// ---------- latest request wins ----------
/** Each call returns a token; `isLatest(token)` is false once a newer call started. */
export function latest() {
  let n = 0;
  return { next: () => ++n, isLatest: (t: number) => t === n };
}

/** Random ID for a request, so the server can recognise (and ignore) a repeat of the same request. */
export const requestId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
