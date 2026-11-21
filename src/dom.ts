/** Small shared helpers for building the UI and formatting numbers/times (used by every panel). */

/** Create an element with an optional class and text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A real <button type="button">; the click handler gets the button (handy for busy()). */
export function btn(label: string, onClick: (b: HTMLButtonElement) => unknown, cls = "btn sm"): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = () => onClick(b);
  return b;
}

/** A paragraph of plain text. */
export const para = (text: string, cls = "") => el("p", cls, text);

/** 1,234,567 */
export const num = (x: number) => x.toLocaleString("en-US");

const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
/** 1.2M */
export const compact = (x: number) => compactFmt.format(x);

export const nowSec = () => Date.now() / 1000;

/** "5m ago", "3d ago" … from a unix time in seconds. */
export function ago(sec: number, now = nowSec()) {
  const d = now - sec;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)}d ago`;
  if (d < 86400 * 365) return `${Math.round(d / (86400 * 30))}mo ago`;
  return `${Math.round(d / (86400 * 365))}y ago`;
}

/** 1:05 */
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Element by id (the page's fixed layout in index.html). */
export const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
