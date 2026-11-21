/**
 * API usage page (Menu ☰ → API): where the YouTube Data API quota goes.
 * Sources: refresh history in shorts.json (written by scripts/fetch.ts) and
 * channel lookups logged by the app (synced in user-state.json).
 */
import { COST, getQuota, setBudget, type QuotaStatus } from "./quota";
import { state } from "./store";
import * as sync from "./sync";
import type { Dataset, UsageRun } from "./types";
import { el, num as n } from "./dom";

const DAILY_LIMIT = 10_000;
const QUOTA_CONSOLE = "https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas";

// YouTube's quota day runs midnight-to-midnight Pacific time.
const pacificDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
const dayKey = (sec: number) => pacificDay.format(new Date(sec * 1000));
const pacificHour = (ms: number) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));

/** Next midnight Pacific, as a timestamp (handles daylight saving). */
function nextReset(): number {
  const [y, m, d] = dayKey(Date.now() / 1000)
    .split("-")
    .map(Number);
  for (const utcHour of [7, 8]) {
    const t = Date.UTC(y, m - 1, d + 1, utcHour);
    if (pacificHour(t) === 0) return t;
  }
  return Date.UTC(y, m - 1, d + 1, 8);
}

function table(head: string[], rows: (string | number)[][], numericFrom = 1) {
  const t = el("table", "u-table");
  const tr = el("tr");
  head.forEach((h, i) => {
    tr.append(el("th", i >= numericFrom ? "num" : "", h));
  });
  t.append(tr);
  for (const r of rows) {
    const row = el("tr");
    r.forEach((c, i) => {
      row.append(el("td", i >= numericFrom ? "num" : "", typeof c === "number" ? n(c) : c));
    });
    t.append(row);
  }
  return t;
}

function runDetail(r: UsageRun) {
  const bits = [
    `RSS ${r.rssOk}${r.rssFailed ? ` (+${r.rssFailed} failed)` : ""}`,
    `${r.playlistChecks} playlist check${r.playlistChecks === 1 ? "" : "s"}`,
    `${n(r.statsRefreshed)} stats`,
    `${r.newShorts} new`,
  ];
  if (r.deep) bits.unshift("deep");
  return bits.join(" · ");
}

/** What the automatic refreshes need per day: average run × 6, plus the biggest run of the week as headroom. */
function refreshNeed(runs: UsageRun[]) {
  const week = runs.filter((r) => r.where === "github" && r.at > Date.now() / 1000 - 7 * 86400);
  if (!week.length) return 0;
  const avg = week.reduce((s, r) => s + r.units, 0) / week.length;
  const biggest = Math.max(...week.map((r) => r.units));
  return Math.round(avg * 6 + biggest);
}

async function renderBudget(box: HTMLElement, runs: UsageRun[]) {
  box.replaceChildren(el("h3", "u-h", "Your discovery budget"));
  if (!sync.isConnected()) {
    box.append(el("p", "u-note", "Log in under Sync to see and set your discovery budget (searches, channel previews, lookups)."));
    return;
  }
  box.append(el("p", "u-note", "Loading…"));
  const q = await getQuota(true);
  box.replaceChildren(el("h3", "u-h", "Your discovery budget"));
  if (!q) {
    box.append(el("p", "u-note", "Couldn't reach the sync server."));
    return;
  }
  drawBudget(box, q, runs);
}

function drawBudget(box: HTMLElement, q: QuotaStatus, runs: UsageRun[]) {
  const left = Math.max(0, q.budget - q.used);
  const pct = Math.min(100, (q.used / q.budget) * 100);
  const level = pct >= 80 ? "red" : pct >= 50 ? "yellow" : "green";

  box.append(
    el(
      "p",
      "u-note",
      "Paid actions you start — YouTube searches, channel previews and lookups — come out of this daily budget. " +
        "The sync server refuses anything over it, so a mistake can never drain your quota.",
    ),
  );

  const card = el("div", `u-meter-card lvl-${level}`);
  const meter = el("div", "cost-meter");
  const used = el("div", "cost-add");
  used.style.width = `${pct}%`;
  meter.append(used);
  card.append(
    el("div", "u-of", `${n(q.used)} of ${n(q.budget)} used today (${Math.round(pct)}%)`),
    meter,
    el(
      "div",
      "u-sub",
      `${n(left)} left · room for ~${Math.floor(left / COST.search)} YouTube searches or ~${Math.floor(left / COST.preview)} channel previews`,
    ),
  );
  box.append(card);

  // split of the whole 10,000
  const need = refreshNeed(runs);
  const okReserve = !need || need <= q.reserve;
  box.append(
    table(
      ["Daily quota (10,000)", "Units"],
      [
        ["🛡️ Reserved for automatic refreshes", q.reserve],
        ["🔍 Your discovery budget", q.budget],
        ["Unused safety margin", Math.max(0, q.limit - q.reserve - q.budget)],
      ],
    ),
  );
  box.append(
    el(
      "p",
      `u-note${okReserve ? "" : " warn"}`,
      need
        ? okReserve
          ? `Refreshes protected ✓ — they need about ${n(need)} units/day, ${n(q.reserve)} are reserved.`
          : `⚠️ Refreshes need about ${n(need)} units/day but only ${n(q.reserve)} are reserved. Keep your budget lower so refreshes don't run out.`
        : `Refreshes protected ✓ — ${n(q.reserve)} units/day are reserved for them.`,
    ),
  );

  if (q.savedWeek)
    box.append(
      el("p", "u-note good", `💚 Caching saved you ${n(q.savedWeek)} units in the last 7 days (repeat searches and previews were free).`),
    );

  // change budget
  const form = el("form", "u-budget-form");
  const input = el("input") as HTMLInputElement;
  input.type = "number";
  input.min = "100";
  input.max = String(q.maxBudget);
  input.step = "1"; // any whole number
  input.value = String(q.budget);
  input.setAttribute("aria-label", "Daily discovery budget");
  const save = el("button", "btn sm", "Save budget");
  save.type = "submit";
  form.append(el("span", "u-note", "Daily budget:"), input, save);
  const msg = el("p", "u-note", `Between 100 and ${n(q.maxBudget)}. Lower = more careful. 1,000 ≈ 9 searches/day; 3,000 ≈ 29.`);
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const nq = await setBudget(Number(input.value));
      box.replaceChildren(el("h3", "u-h", "Your discovery budget"));
      drawBudget(box, nq, runs);
      const done = el("p", "u-note good", "Budget saved ✓ — applies on all your devices.");
      box.append(done);
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : "Couldn't save";
      save.disabled = false;
    }
  };
  box.append(form, msg);

  box.append(el("h3", "u-h", "Spend wisely"));
  const tips = el("ul", "u-tips");
  for (const t of [
    "Use “More like this → In your feed” first — it's free and often enough.",
    "Paste a channel's @handle or link instead of searching its name (3 units vs ~106).",
    "Use specific search words: “pricing psychology customers” beats “business”.",
    "Repeating a search within 7 days, or reopening a channel preview within 24 hours, costs 0.",
    "Watching, saving, hiding, syncing and editing channels never use the quota.",
  ])
    tips.append(el("li", "", t));
  box.append(tips);
}

export function renderUsagePanel(body: HTMLElement, ds: Dataset, ago: (sec: number) => string) {
  // The live site only contains GitHub's runs; a local copy only contains runs made on the PC.
  const runs = ds.usage ?? [];
  const lookups = state.apiLog ?? [];
  const today = dayKey(Date.now() / 1000);

  const todayRuns = runs.filter((r) => dayKey(r.at) === today);
  const todayLookups = lookups.filter((u) => dayKey(u.at) === today);
  const refreshUnits = todayRuns.reduce((s, r) => s + r.units, 0);
  const lookupUnits = todayLookups.reduce((s, u) => s + u.units, 0);
  const total = refreshUnits + lookupUnits;
  const pct = Math.round((total / DAILY_LIMIT) * 1000) / 10;

  // ---- today
  const hero = el("div", "u-hero");
  hero.append(
    el("div", "u-big", `${n(total)}`),
    el("div", "u-of", `of ${n(DAILY_LIMIT)} units used today (${pct}%)`),
    el(
      "div",
      "u-sub",
      `${n(DAILY_LIMIT - total)} left · resets ${new Date(nextReset()).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} your time (midnight Pacific)`,
    ),
  );
  body.append(hero);

  // ---- budget split (filled in once the sync server answers)
  const budgetBox = el("div", "u-budget");
  body.append(budgetBox);
  renderBudget(budgetBox, runs);

  // ---- where it went today
  const sum = (k: keyof UsageRun["by"]) => todayRuns.reduce((s, r) => s + (r.by?.[k] ?? 0), 0);
  body.append(el("h3", "u-h", "Where today's units went"));
  body.append(
    table(
      ["What", "Units"],
      [
        [`Checking for new Shorts (${todayRuns.length} refresh${todayRuns.length === 1 ? "" : "es"})`, sum("playlist")],
        ["Updating views / likes", sum("stats")],
        ["Channel names, avatars, subscribers", sum("channelInfo") + sum("resolve")],
        [`Your searches, previews & lookups (${todayLookups.length})`, lookupUnits],
        ["Total", total],
      ],
    ),
  );

  // ---- last 7 days
  const days: string[] = [];
  for (let i = 0; i < 7; i++) days.push(dayKey(Date.now() / 1000 - i * 86400));
  const perDay = days.map((d) => {
    const rr = runs.filter((r) => dayKey(r.at) === d);
    const lu = lookups.filter((u) => dayKey(u.at) === d).reduce((s, u) => s + u.units, 0);
    const ru = rr.reduce((s, r) => s + r.units, 0);
    return [d === today ? `${d} (today)` : d, rr.length, ru, lu, ru + lu] as (string | number)[];
  });
  body.append(el("h3", "u-h", "Last 7 days (Pacific dates)"));
  body.append(table(["Day", "Refreshes", "Refresh units", "Lookup units", "Total"], perDay));

  const recent7 = runs.filter((r) => r.at > Date.now() / 1000 - 7 * 86400 && r.ok);
  if (recent7.length) {
    const avg = Math.round(recent7.reduce((s, r) => s + r.units, 0) / recent7.length);
    body.append(
      el(
        "p",
        "u-note",
        `Average refresh: ~${n(avg)} units. With 6 scheduled refreshes a day that's ~${n(avg * 6)} units/day (${Math.round((avg * 6) / 100)}% of the limit), plus any refreshes your channel edits trigger.`,
      ),
    );
  }

  // ---- recent refreshes
  body.append(el("h3", "u-h", "Recent refreshes"));
  if (!runs.length) body.append(el("p", "u-note", "No refresh history yet — it appears after the next refresh."));
  else {
    body.append(
      table(
        ["When", "Units", "Details"],
        runs
          .slice(0, 15)
          .map((r) => [`${r.ok ? "" : "✗ failed · "}${ago(r.at)}${r.where === "local" ? " (PC)" : ""}`, r.units, runDetail(r)]),
        1,
      ),
    );
  }

  // ---- recent lookups
  body.append(el("h3", "u-h", "Your recent paid actions"));
  if (!lookups.length)
    body.append(el("p", "u-note", "None yet. Searches, channel previews and lookups you make will be listed here with their cost."));
  else
    body.append(
      table(
        ["When", "Units", "What"],
        lookups.slice(0, 10).map((u) => [ago(u.at), u.units, u.what]),
        1,
      ),
    );

  // ---- how it's spent
  body.append(el("h3", "u-h", "What costs what"));
  body.append(
    table(
      ["Action", "Cost"],
      [
        ["Checking a channel's RSS feed for new uploads", "free"],
        ["Reading a channel's Shorts list (only when RSS shows something new, or weekly)", "1 per 50 Shorts"],
        ["Updating views/likes (new Shorts every run, < 60 days daily, older weekly)", "1 per 50 Shorts"],
        ["Channel names/avatars/subscribers (each refresh)", "1 per 50 channels"],
        ["More like this → In your feed", "free"],
        ["More like this → On YouTube (new search; repeats within 7 days free)", "~103"],
        ["Open a channel that isn't in your list (free again for 24 h)", "~10"],
        ["Add channel: look up a @handle or link", "2–3"],
        ["Add channel: search by name (only when you tap Search)", "~106"],
        ["Watching, saving, syncing, removing channels", "free"],
      ],
      1,
    ),
  );

  const note = el("p", "u-note");
  note.append("These numbers are the app's own count. Google's count is the official one: ");
  const a = el("a", "", "Google Cloud → YouTube Data API → Quotas") as HTMLAnchorElement;
  a.href = QUOTA_CONSOLE;
  a.target = "_blank";
  a.rel = "noopener";
  note.append(a, ". Refreshes run on your PC with npm run fetch also use quota but aren't listed here.");
  body.append(note);
}
