/**
 * Menu → Activity: everything that happened, in one place, newest first.
 *  - Changes: what you did to your data on any device (added/edited/deleted videos, notes, saves, lists…).
 *    Recorded as it happens and synced, so the phone's changes show up on the laptop too.
 *  - Watching: your watch history.   - Sync: how saving to the cloud went (this device).
 *  - API: YouTube API units spent.   - Problems: anything that went wrong (a failed save, an app error).
 * Filter by kind, search the words, and export what you see as a spreadsheet file.
 */
import { ago, btn, el, nowSec } from "./dom";
import { cloudLine } from "./cloud";
import { localLog } from "./locallog";
import { state } from "./store";
import * as sync from "./sync";
import type { Short } from "./types";

type Cat = "changes" | "watch" | "sync" | "api" | "problems";
interface Row {
  at: number; // unix seconds
  cat: Cat;
  icon: string;
  text: string;
  sub?: string;
  device?: "phone" | "computer";
  bad?: boolean;
}

const ICONS: Record<string, string> = { video: "🎬", note: "📝", save: "♡", channel: "📺", list: "📋", category: "🏷️", backup: "🗄️" };
const CATS: [Cat | "all", string][] = [
  ["all", "All"],
  ["changes", "Changes"],
  ["watch", "Watching"],
  ["sync", "Sync"],
  ["api", "API"],
  ["problems", "Problems"],
];
const PAGE = 100;

const view = { cat: "all" as Cat | "all", q: "", shown: PAGE };

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (at: number) => {
  const d = new Date(at * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayKey = (at: number) => {
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
function dayLabel(at: number, now: number) {
  const k = dayKey(at);
  if (k === dayKey(now)) return "Today";
  if (k === dayKey(now - 86400)) return "Yesterday";
  return new Date(at * 1000).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: new Date(at * 1000).getFullYear() === new Date(now * 1000).getFullYear() ? undefined : "numeric",
  });
}

/** Every line from every source, newest first. */
export function activityRows(byId: Map<string, Short>): Row[] {
  const rows: Row[] = [];
  const title = (id: string) => byId.get(id)?.t || state.manual.find((m) => m.id === id.replace(/^fb/, ""))?.t || "";
  for (const e of state.activity) {
    const t = e.k === "save" && e.v ? title(e.v) : "";
    rows.push({
      at: e.at,
      cat: "changes",
      icon: ICONS[e.k] ?? "•",
      text: t ? `${e.x}: “${t.slice(0, 90)}”` : e.x,
      device: e.d,
    });
  }
  for (const h of state.hist) {
    const t = byId.get(h.id)?.t || h.x?.t || "a video";
    rows.push({
      at: h.at,
      cat: "watch",
      icon: "▶",
      text: `Watched “${t.slice(0, 90)}”`,
      sub: `${Math.round((h.f ?? 0) * 100)}% watched${h.x?.n ? ` · ${h.x.n}` : ""}`,
    });
  }
  for (const a of state.apiLog) rows.push({ at: a.at, cat: "api", icon: "🔑", text: `Used ${a.units} YouTube API units`, sub: a.what });
  for (const e of localLog()) {
    const sys = e.k !== "sync";
    rows.push({
      at: e.at,
      cat: e.k === "sync" ? "sync" : "problems",
      icon: e.k === "sync" ? (e.ok ? "☁️" : "⚠️") : e.k === "error" ? "🐞" : "💾",
      text: e.x,
      bad: !e.ok,
      sub: sys ? "this device" : undefined,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

const matches = (r: Row, cat: Cat | "all", q: string) =>
  (cat === "all" || r.cat === cat || (cat === "problems" && r.bad)) && (!q || `${r.text} ${r.sub ?? ""}`.toLowerCase().includes(q));

function csv(rows: Row[]) {
  const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [
    "Time,Type,Device,What,Details",
    ...rows.map((r) => [new Date(r.at * 1000).toISOString(), r.cat, r.device ?? "", r.text, r.sub ?? ""].map(cell).join(",")),
  ].join("\n");
}

function download(name: string, text: string) {
  const a = el("a");
  a.href = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function renderActivity(body: HTMLElement, rerender: () => void, byId: Map<string, Short>) {
  body.append(
    el(
      "p",
      "ch-note",
      "Everything that happened, newest first: your changes on every device, what you watched, how saving to the cloud went, and anything that went wrong.",
    ),
  );
  body.append(cloudLine());

  const all = activityRows(byId);
  const counts = new Map<Cat | "all", number>([["all", all.length]]);
  for (const r of all) {
    counts.set(r.cat, (counts.get(r.cat) ?? 0) + 1);
    if (r.bad && r.cat !== "problems") counts.set("problems", (counts.get("problems") ?? 0) + 1);
  }

  // filters
  const chips = el("div", "chips act-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "What to show");
  for (const [k, label] of CATS) {
    const b = btn(
      `${label} · ${counts.get(k) ?? 0}`,
      () => {
        view.cat = k;
        view.shown = PAGE;
        rerender();
      },
      view.cat === k ? "on" : "",
    );
    b.setAttribute("aria-pressed", String(view.cat === k));
    chips.append(b);
  }
  const search = el("input", "ch-search");
  search.type = "search";
  search.placeholder = "Search the log";
  search.setAttribute("aria-label", "Search the activity log");
  search.value = view.q;
  const list = el("div", "act-list");
  list.setAttribute("aria-label", "Activity");

  const draw = () => {
    const q = view.q.trim().toLowerCase();
    const rows = all.filter((r) => matches(r, view.cat, q));
    list.replaceChildren();
    if (!rows.length) {
      list.append(el("p", "ch-note", all.length ? "Nothing matches." : "Nothing yet. Changes you make from now on are written down here."));
      more.hidden = true;
      exportBtn.hidden = true;
      return;
    }
    exportBtn.hidden = false;
    const now = nowSec();
    let day = "";
    for (const r of rows.slice(0, view.shown)) {
      const k = dayKey(r.at);
      if (k !== day) {
        day = k;
        list.append(el("h3", "act-day", dayLabel(r.at, now)));
      }
      const row = el("div", `act-row${r.bad ? " bad" : ""}`);
      const text = el("div", "act-text");
      text.append(el("div", "act-what", r.text));
      const sub = [r.sub, r.device ? (r.device === "phone" ? "📱 phone" : "💻 computer") : ""].filter(Boolean).join(" · ");
      if (sub) text.append(el("div", "act-sub", sub));
      const when = el("time", "act-when", clock(r.at));
      when.title = `${new Date(r.at * 1000).toLocaleString()} (${ago(r.at)})`;
      row.append(el("span", "act-icon", r.icon), text, when);
      list.append(row);
    }
    more.hidden = rows.length <= view.shown;
    more.textContent = `Show ${Math.min(PAGE, rows.length - view.shown)} more (${rows.length - view.shown} left)`;
  };

  const more = btn(
    "Show more",
    () => {
      view.shown += PAGE;
      draw();
    },
    "btn sm",
  );
  const exportBtn = btn(
    "⬇ Export what's shown (CSV)",
    () => {
      const q = view.q.trim().toLowerCase();
      download(`reel-feed-activity-${dayKey(nowSec())}.csv`, csv(all.filter((r) => matches(r, view.cat, q))));
    },
    "btn sm",
  );

  let t = 0;
  search.addEventListener("input", () => {
    view.q = search.value;
    view.shown = PAGE;
    clearTimeout(t);
    t = window.setTimeout(draw, 150);
  });

  body.append(chips, search, list, more, exportBtn);
  draw();

  // The cloud's own trail: every save to the cloud is a version there (kept 30 days)
  if (sync.isConnected()) {
    const box = el("details", "act-cloud");
    box.append(el("summary", "", "Cloud history (every save, last 30 days)"));
    const out = el("div", "act-list");
    box.append(out);
    let loaded = false;
    box.addEventListener("toggle", async () => {
      if (!box.open || loaded) return;
      loaded = true;
      out.replaceChildren(el("p", "ch-note", "Loading…"));
      try {
        const { versions } = await sync.call<{ versions: { sha: string; at: number; msg: string }[] }>("/state/versions");
        out.replaceChildren(
          ...(versions.length
            ? versions.map((v) => {
                const row = el("div", "act-row");
                const text = el("div", "act-text");
                text.append(el("div", "act-what", v.msg || "Sync"));
                const when = el(
                  "time",
                  "act-when",
                  new Date(v.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
                );
                row.append(el("span", "act-icon", "☁️"), text, when);
                return row;
              })
            : [el("p", "ch-note", "No saves yet.")]),
        );
      } catch (e) {
        loaded = false;
        out.replaceChildren(el("p", "ch-note", `Couldn't load it: ${e instanceof Error ? e.message : "no answer from the server"}`));
      }
    });
    body.append(box);
  }
}
