/**
 * Quota guard (app side). Before any paid YouTube action the app shows a cost card:
 * what it costs, what's left today, how many more searches that leaves, and free alternatives.
 * Warning levels: green < 50% of the discovery budget, yellow 50–80%, red 80–100% (press & hold),
 * blocked at the budget. The Worker enforces the same budget server-side (the hard lock).
 */
import { act } from "./store";
import * as sync from "./sync";
import { el, num as n } from "./dom";
import { holdFocus } from "./a11y";

export interface QuotaStatus {
  enabled: boolean;
  day: string;
  used: number;
  budget: number;
  reserve: number;
  limit: number;
  maxBudget: number;
  savedWeek: number;
  usedWeek: number;
  recent: { q: string; norm: string; at: number; n: number }[];
}

export const COST = { search: 103, preview: 10, lookup: 3, nameSearch: 106 };

let cached: { at: number; q: QuotaStatus } | null = null;

export async function getQuota(fresh = false): Promise<QuotaStatus | null> {
  if (!sync.isConnected()) return null;
  if (!fresh && cached && Date.now() - cached.at < 20_000) return cached.q;
  try {
    const q = await sync.call<QuotaStatus>("/quota");
    cached = { at: Date.now(), q };
    return q;
  } catch {
    return cached?.q ?? null;
  }
}

/** Update the local numbers after a paid response (the Worker returns fresh used/budget). */
export function noteSpend(units: number, what: string, quota?: { used: number; budget: number }) {
  if (units > 0) act({ t: "api", at: Math.floor(Date.now() / 1000), units, what });
  if (quota && cached) cached.q = { ...cached.q, used: quota.used, budget: quota.budget };
}

export function spendToast(units: number, quota: { used: number; budget: number } | undefined, cachedHit: boolean) {
  if (cachedHit) return "From cache · 0 units used";
  if (!quota) return `Used ${units} units`;
  const left = Math.max(0, quota.budget - quota.used);
  return `Used ${units} units · ${left.toLocaleString("en-US")} of your budget left today`;
}

export const normQuery = (q: string) =>
  [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{M}\p{N}#]+/u)
        .filter((w) => w.length > 1),
    ),
  ]
    .sort()
    .join(" ");

/** A previous search (any device, last 7 days) that's very similar — can be reused for free. */
export function similarPastSearch(q: string, recent: QuotaStatus["recent"]) {
  const a = new Set(normQuery(q).split(" ").filter(Boolean));
  if (!a.size) return null;
  let best: QuotaStatus["recent"][number] | null = null;
  let bestScore = 0;
  for (const r of recent) {
    if (Date.now() / 1000 - r.at > 7 * 86400) continue;
    const b = new Set(r.norm.split(" "));
    const inter = [...a].filter((w) => b.has(w)).length;
    const score = inter / new Set([...a, ...b]).size;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

export function vagueWarning(q: string) {
  const words = normQuery(q)
    .split(" ")
    .filter((w) => w && !w.startsWith("#"));
  if (words.length <= 1) return "One-word searches usually return mixed results. Add 1–2 more words so the 100 units count.";
  return "";
}

// ---------- cost card ----------
export interface CostCardOptions {
  title: string; // e.g. Search YouTube for "pricing psychology"
  cost: number;
  detail?: string;
  warning?: string;
  free?: { label: string; run: () => void }[]; // free alternatives (shown first)
  alwaysAsk?: boolean; // small costs only ask when yellow/red unless this is set
}

/** Resolves true if you confirmed the paid action, false if you cancelled or picked a free option. */
export async function confirmCost(o: CostCardOptions): Promise<boolean> {
  const q = await getQuota(true);
  const budget = q?.budget ?? 3000;
  const used = q?.used ?? 0;
  const after = used + o.cost;
  const level = after > budget ? "blocked" : after / budget >= 0.8 ? "red" : after / budget >= 0.5 ? "yellow" : "green";
  if (level === "green" && !o.alwaysAsk && !o.warning && !o.free?.length) return true;

  return new Promise((resolve) => {
    const overlay = el("div", "cost-overlay");
    const card = el("div", `cost-card lvl-${level}`);
    const release = holdFocus(overlay, card, o.title, () => done(false));
    const done = (v: boolean) => {
      overlay.remove();
      release();
      resolve(v);
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) done(false);
    };

    card.append(el("div", "cost-title", o.title));
    card.append(el("div", "cost-price", `Cost: ~${n(o.cost)} unit${o.cost === 1 ? "" : "s"}`));
    if (o.detail) card.append(el("p", "cost-p", o.detail));

    // meter: used today → after this action
    const meter = el("div", "cost-meter");
    const usedBar = el("div", "cost-used");
    usedBar.style.width = `${Math.min(100, (used / budget) * 100)}%`;
    const addBar = el("div", "cost-add");
    addBar.style.width = `${Math.max(0, Math.min(100 - (used / budget) * 100, (o.cost / budget) * 100))}%`;
    meter.append(usedBar, addBar);
    card.append(
      el("p", "cost-p", `Today: ${n(used)} of your ${n(budget)} discovery budget used (${Math.round((used / budget) * 100)}%)`),
      meter,
    );
    const leftAfter = Math.max(0, budget - after);
    card.append(
      el(
        "p",
        "cost-p",
        level === "blocked"
          ? "This would go over today's budget."
          : `After this: ${n(leftAfter)} left · room for ~${Math.floor(leftAfter / COST.search)} more YouTube searches today`,
      ),
    );
    if (!q) card.append(el("p", "cost-p muted", "Couldn't read today's usage — numbers are estimates."));

    const msg: Record<string, string> = {
      yellow: "⚠️ You've used most of today's discovery budget. Is this one worth it?",
      red: "🔴 Almost out of today's budget. Press and hold to confirm.",
      blocked:
        "⛔ Today's discovery budget is used up. Free options still work; it resets at midnight Pacific. You can raise the budget on the API usage page.",
    };
    if (msg[level]) card.append(el("p", "cost-p strong", msg[level]));
    if (o.warning) card.append(el("p", "cost-p strong", `💡 ${o.warning}`));

    for (const f of o.free ?? []) {
      const tip = el("button", "cost-free", `💡 Free: ${f.label}`);
      tip.type = "button";
      tip.onclick = () => {
        done(false);
        f.run();
      };
      card.append(tip);
    }

    const row = el("div", "cost-actions");
    const cancel = el("button", "btn", "Cancel");
    cancel.onclick = () => done(false);
    row.append(cancel);
    if (level !== "blocked") {
      const go = el("button", "btn primary hold", level === "red" ? `Hold to spend ~${o.cost}` : `Spend ~${o.cost} units`);
      if (level === "red") {
        let t: number | undefined;
        const start = () => {
          go.classList.add("holding");
          t = window.setTimeout(() => done(true), 1000);
        };
        const stop = () => {
          go.classList.remove("holding");
          clearTimeout(t);
        };
        go.onpointerdown = start;
        go.onpointerup = stop;
        go.onpointerleave = stop;
        go.oncontextmenu = (e) => e.preventDefault();
      } else {
        go.onclick = () => done(true);
      }
      row.append(go);
    }
    card.append(row);
    overlay.append(card);
    document.body.append(overlay);
    // start on the safe choice: a free option if there is one, otherwise Cancel
    (card.querySelector<HTMLElement>(".cost-free") ?? card.querySelector<HTMLElement>("button"))?.focus();
  });
}

export async function setBudget(budget: number): Promise<QuotaStatus> {
  const q = await sync.call<QuotaStatus>("/quota", { method: "POST", body: JSON.stringify({ budget }) });
  cached = { at: Date.now(), q };
  return q;
}
