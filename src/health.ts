/**
 * Health check (Menu → About → Health) + early warning before the GitHub token expires.
 * The sync server learns the token's expiry date from GitHub itself (response header).
 */
import * as sync from "./sync";
import { toast } from "./ui";
import { el } from "./dom";

export interface Health {
  ok: boolean;
  tokenExpires: string | null;
  errorsLast7d: number;
  now: number;
}

const WARN_DAYS = 30;
const DAY = 86400_000;

export async function getHealth(): Promise<Health | null> {
  if (!sync.isConnected()) return null;
  try {
    return await sync.call<Health>("/health");
  } catch {
    return null;
  }
}

export function daysLeft(exp: string | null) {
  if (!exp) return null;
  const t = Date.parse(exp.replace(/ UTC$/, "Z").replace(" ", "T"));
  return Number.isFinite(t) ? Math.floor((t - Date.now()) / DAY) : null;
}

export async function renderHealth(box: HTMLElement) {
  box.replaceChildren(el("h3", "u-h", "Health"));
  if (!sync.isAvailable()) {
    box.append(el("p", "u-note", "No sync server set up for this copy of the site."));
    return;
  }
  if (!sync.isConnected()) {
    box.append(el("p", "u-note", "Log in under Sync to see the server's health."));
    return;
  }
  const loading = el("p", "u-note", "Checking…");
  box.append(loading);
  const h = await getHealth();
  loading.remove();
  const st = sync.status();
  const rows: [string, string, "good" | "warn" | "bad" | ""][] = [];
  rows.push(h ? ["Sync server", "Reachable ✓", "good"] : ["Sync server", "Not reachable right now", "bad"]);
  rows.push(["Last sync", st.lastSync ? new Date(st.lastSync).toLocaleString() : "not yet", st.lastError ? "warn" : ""]);
  if (st.pending) rows.push(["Waiting to upload", `${st.pending} change${st.pending === 1 ? "" : "s"}`, "warn"]);
  if (h) {
    const d = daysLeft(h.tokenExpires);
    if (d === null) rows.push(["GitHub token", "No expiry date reported", ""]);
    else if (d < 0) rows.push(["GitHub token", `EXPIRED ${-d} day${d === -1 ? "" : "s"} ago — sync and channel edits stop working`, "bad"]);
    else
      rows.push([
        "GitHub token",
        `Expires ${new Date(Date.now() + d * DAY).toLocaleDateString()} (in ${d} days)`,
        d < WARN_DAYS ? "warn" : "good",
      ]);
    rows.push(["App problems (7 days)", h.errorsLast7d ? `${h.errorsLast7d} reported` : "None ✓", h.errorsLast7d ? "warn" : "good"]);
  }
  const t = el("table", "u-table");
  for (const [k, v, cls] of rows) {
    const tr = el("tr");
    tr.append(el("td", "", k), el("td", `h-val ${cls}`, v));
    t.append(tr);
  }
  box.append(t);
  const d = h ? daysLeft(h.tokenExpires) : null;
  if (d !== null && d < WARN_DAYS) {
    box.append(
      el(
        "p",
        "u-note warn",
        "To renew: github.com/settings/personal-access-tokens → the token in use → Regenerate (same settings), then in the worker folder run: npx wrangler secret put GITHUB_TOKEN",
      ),
    );
  }
}

/** Once a day, if the token expires within 30 days (or already has), say so. */
export async function warnIfTokenExpiring() {
  const KEY = "ecomgy-reel-feed.tokenWarned";
  try {
    if (Date.now() - Number(localStorage.getItem(KEY) ?? 0) < DAY) return;
  } catch {
    /* ignore */
  }
  const h = await getHealth();
  const d = h ? daysLeft(h.tokenExpires) : null;
  if (d === null || d >= WARN_DAYS) return;
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  toast(
    d < 0
      ? "⚠️ The GitHub token has expired — sync and channel edits are stopped. See Menu → About → Health."
      : `⚠️ The GitHub token expires in ${d} days. Renew it before then — see Menu → About → Health.`,
    undefined,
    9000,
  );
}
