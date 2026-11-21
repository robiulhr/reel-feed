/**
 * Accessibility helpers shared by every overlay and list:
 *  - modal(): menus, pages, sheets and dialogs are announced as dialogs, keep keyboard focus inside
 *    while open (Tab wraps around), close with Esc, and give focus back to what opened them.
 *  - clickable(): makes a non-button element (a card, a row) usable with the keyboard and screen readers.
 *  - announce(): tells screen readers about changes that aren't focused (e.g. the next Short).
 *  - reducedMotion(): respects the phone's "reduce motion" setting.
 */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface Modal {
  root: HTMLElement;
  open(): void;
  /** Hide without the owner's extra close work (use requestClose for user-initiated closes). */
  close(): void;
  /** Esc / ✕ / tap outside: runs the owner's close handler. */
  requestClose(): void;
  isOpen(): boolean;
}

const stack: Modal[] = [];
export const topModal = (): Modal | undefined => stack.at(-1);
export const anyModalOpen = () => stack.length > 0 || !!document.querySelector(".dlg-overlay, .cost-overlay");

function visibleFocusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !e.closest("[hidden]") && e.getClientRects().length > 0);
}

/** Keep Tab / Shift+Tab inside `root`. */
export function trapTab(root: HTMLElement, e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  const f = visibleFocusables(root);
  if (!f.length) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = f[0],
    last = f[f.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

export function modal(root: HTMLElement, opts: { label: string; onRequestClose: () => void; focus?: () => HTMLElement | null }): Modal {
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", opts.label);
  if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
  let returnTo: HTMLElement | null = null;
  const m: Modal = {
    root,
    open() {
      if (stack.includes(m)) {
        root.hidden = false;
        return;
      } // already open (e.g. switching menu tabs): keep focus where it is
      returnTo = document.activeElement as HTMLElement | null;
      stack.push(m);
      root.hidden = false;
      const target = opts.focus?.() ?? visibleFocusables(root)[0] ?? root;
      target.focus({ preventScroll: true });
    },
    close() {
      root.hidden = true;
      const i = stack.indexOf(m);
      if (i < 0) return;
      stack.splice(i, 1);
      if (returnTo?.isConnected && !returnTo.closest("[hidden]")) returnTo.focus({ preventScroll: true });
      returnTo = null;
    },
    requestClose: () => opts.onRequestClose(),
    isOpen: () => !root.hidden,
  };
  return m;
}

// One key handler for all modals: Esc closes the top one, Tab stays inside it.
document.addEventListener(
  "keydown",
  (e) => {
    const top = topModal();
    if (!top || document.querySelector(".dlg-overlay, .cost-overlay")) return; // app dialogs handle their own keys
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      top.requestClose();
      return;
    }
    trapTab(top.root, e);
  },
  true,
);

/** Make a card/row act like a button: focusable, Enter/Space activate it, announced as a button. */
export function clickable<T extends HTMLElement>(node: T, onActivate: () => void, label?: string): T {
  node.setAttribute("role", "button");
  node.tabIndex = 0;
  if (label) node.setAttribute("aria-label", label);
  node.onclick = onActivate;
  node.addEventListener("keydown", (e) => {
    if (e.target !== node) return; // keys on a button inside the card belong to that button
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
  });
  return node;
}

let live: HTMLElement | null = null;
/** Read `text` out to screen readers without moving focus. */
export function announce(text: string) {
  if (!live) {
    live = document.createElement("div");
    live.className = "sr-only";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    document.body.append(live);
  }
  live.textContent = "";
  // a tick later, so the same text twice is still read
  window.setTimeout(() => {
    if (live) live.textContent = text;
  }, 30);
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * For dialogs built on the fly (confirm, cost card): label it, keep Tab inside, Esc cancels,
 * and put focus back where it was when it closes. Returns the cleanup function.
 */
export function holdFocus(overlay: HTMLElement, box: HTMLElement, label: string, onEscape: () => void): () => void {
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", label);
  const returnTo = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    if (!overlay.isConnected) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      onEscape();
    } else trapTab(box, e);
  };
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    if (returnTo?.isConnected && !returnTo.closest("[hidden]")) returnTo.focus({ preventScroll: true });
  };
}
