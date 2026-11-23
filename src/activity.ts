/**
 * Menu → Activity: everything that happened, in one place, newest first.
 *  - Changes: what you did to your data on any device (added/edited/deleted videos, notes, saves, lists…).
 *    Recorded as it happens and synced, so the phone's changes show up on the laptop too.
 *  - Watching: your watch history.   - Sync: how saving to the cloud went (this device).
 *  - API: YouTube API units spent.   - Problems: anything that went wrong (a failed save, an app error).
 * A summary and a 7-day chart on top; each line shows the video's picture, what it was, who made it,
 * its views and categories, a label for what happened, and opens the video when you tap it. A batch
 * ("Added 60 videos at once") expands into the videos in it. Filter by kind, search, export as CSV.
 */
import type { AppApi } from "./app";
import { clickable } from "./a11y";
import { catLabel } from "./categories";
import { cloudLine } from "./cloud";
import { ago, btn, compact, el, nowSec } from "./dom";
import { localLog } from "./locallog";
import { type ActivityEntry, state } from "./store";
import * as sync from "./sync";
import type { Short } from "./types";
import { thumb } from "./view";

type Cat = "changes" | "watch" | "sync" | "api" | "problems";
type Tone = "accent" | "danger" | "success" | "muted";
interface Row {
  at: number; // unix seconds
  cat: Cat;
  icon: string; // shown when there's no picture
  label: string; // what kind of event: "Added", "Note", "Watched", "Problem"…
  tone: Tone;
  text: string;
  sub?: string;
  device?: "phone" | "computer";
  bad?: boolean;
  vid?: string; // the video it's about (a feed id): its picture, and tapping opens it
  ids?: string[]; // a batch: the videos in it
  progress?: number; // 0..1 of a watched video
}

const KIND_ICON: Record<string, string> = { video: "🎬", note: "📝", save: "♡", channel: "📺", list: "📋", category: "🏷️", backup: "🗄️" };
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
  const sameYear = new Date(at * 1000).getFullYear() === new Date(now * 1000).getFullYear();
  return new Date(at * 1000).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

/** What kind of event a change is, in one or two words, and how loudly to show it. */
function look(e: ActivityEntry): { label: string; tone: Tone } {
  const x = e.x;
  if (/^Deleted/.test(x)) return { label: e.k === "note" ? "Note removed" : "Deleted", tone: "danger" };
  if (e.k === "video")
    return { label: e.ids ? `Added ${e.ids.length}` : /^Added/.test(x) ? "Added" : "Edited", tone: /^Added/.test(x) ? "accent" : "muted" };
  if (e.k === "note") return { label: "Note", tone: "accent" };
  if (e.k === "save") return { label: /^Took/.test(x) ? "Unsaved" : "Saved", tone: "muted" };
  if (e.k === "channel") return { label: /^Hid/.test(x) ? "Hidden" : "Shown", tone: "muted" };
  if (e.k === "list") return { label: "List", tone: "muted" };
  if (e.k === "topic") return { label: "Topic", tone: "accent" };
  if (e.k === "category") return { label: "Category", tone: "muted" };
  return { label: "Backup", tone: "muted" };
}

/** Who made it, its views, categories and lists: the second line under a video. */
function detailOf(s: Short, app: AppApi): string {
  const maker = s.fb?.by ? (state.fbPages.find((p) => p.key === s.fb!.by)?.name ?? "") : (app.ds.channels[s.ch]?.n ?? "");
  const lists = (s.fb?.lists ?? []).map((id) => state.lists.find((l) => l.id === id)?.name).filter(Boolean);
  return [maker, s.v ? `${compact(s.v)} views` : "", s.k.slice(0, 2).map(catLabel).join(", "), lists.length ? `in ${lists.join(", ")}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** Every line from every source, newest first. */
export function activityRows(byId: Map<string, Short>, app?: AppApi): Row[] {
  const rows: Row[] = [];
  for (const e of state.activity) {
    const s = e.v ? byId.get(e.v) : undefined;
    const t = s && e.k === "save" ? `${e.x}: “${s.t.slice(0, 90)}”` : e.x;
    const { label, tone } = look(e);
    rows.push({
      at: e.at,
      cat: "changes",
      icon: KIND_ICON[e.k] ?? "•",
      label,
      tone,
      text: t,
      sub: s && app ? detailOf(s, app) : undefined,
      device: e.d,
      vid: s ? s.id : undefined,
      ids: e.ids,
    });
  }
  for (const h of state.hist) {
    const s = byId.get(h.id);
    const t = s?.t || h.x?.t || "a video";
    rows.push({
      at: h.at,
      cat: "watch",
      icon: "▶",
      label: "Watched",
      tone: "muted",
      text: `Watched “${t.slice(0, 90)}”`,
      sub: [`${Math.round((h.f ?? 0) * 100)}% watched`, h.x?.n ?? (s && app ? app.ds.channels[s.ch]?.n : "")].filter(Boolean).join(" · "),
      vid: s ? s.id : h.id,
      progress: h.f ?? 0,
    });
  }
  for (const a of state.apiLog)
    rows.push({ at: a.at, cat: "api", icon: "🔑", label: "API", tone: "muted", text: `Used ${a.units} YouTube API units`, sub: a.what });
  for (const e of localLog()) {
    const sys = e.k !== "sync";
    rows.push({
      at: e.at,
      cat: e.k === "sync" ? "sync" : "problems",
      icon: e.k === "sync" ? (e.ok ? "☁️" : "⚠️") : e.k === "error" ? "🐞" : "💾",
      label: e.ok ? "Sync" : "Problem",
      tone: e.ok ? "success" : "danger",
      text: e.x,
      bad: !e.ok,
      sub: sys ? "this device" : undefined,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

/** Shows or hides a button (the hidden attribute alone loses to the button's own display style). */
const show = (b: HTMLElement, on: boolean) => {
  b.hidden = !on;
  b.style.display = on ? "" : "none";
};

const matches = (r: Row, cat: Cat | "all", q: string) =>
  (cat === "all" || r.cat === cat || (cat === "problems" && r.bad)) &&
  (!q || `${r.text} ${r.sub ?? ""} ${r.label}`.toLowerCase().includes(q));

function csv(rows: Row[]) {
  const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [
    "Time,Type,Label,Device,What,Details",
    ...rows.map((r) => [new Date(r.at * 1000).toISOString(), r.cat, r.label, r.device ?? "", r.text, r.sub ?? ""].map(cell).join(",")),
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

/** The week at a glance: two numbers and a bar for each of the last 7 days. */
function summary(): HTMLElement {
  const now = nowSec();
  const box = el("div", "act-summary");
  const days = Array.from({ length: 7 }, (_, i) => now - (6 - i) * 86400);
  const per = days.map((d) => state.activity.filter((e) => dayKey(e.at) === dayKey(d)).length);
  const week = state.activity.filter((e) => e.at >= now - 7 * 86400);
  const added = week.reduce((n, e) => n + (e.k === "video" && /^Added/.test(e.x) && !/page/.test(e.x) ? (e.ids?.length ?? 1) : 0), 0);
  const noted = week.filter((e) => e.k === "note" && /^Wrote/.test(e.x)).length;
  const stat = (n: number, label: string) => {
    const s = el("div", "act-stat");
    s.append(el("div", "act-stat-n", n.toLocaleString()), el("div", "act-stat-l", label));
    return s;
  };
  const stats = el("div", "act-stats");
  stats.append(stat(week.length, "changes this week"), stat(added, "videos added"), stat(noted, "notes written"));
  const max = Math.max(1, ...per);
  const chart = el("div", "act-bars");
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", `Changes per day, last 7 days: ${per.join(", ")}`);
  days.forEach((d, i) => {
    const col = el("div", "act-bar");
    const bar = el("div", i === 6 ? "act-fill today" : "act-fill");
    bar.style.height = `${Math.max(4, Math.round((per[i] / max) * 100))}%`;
    bar.title = `${per[i]} change${per[i] === 1 ? "" : "s"} · ${new Date(d * 1000).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}`;
    col.append(bar, el("span", "act-bar-l", new Date(d * 1000).toLocaleDateString(undefined, { weekday: "narrow" })));
    chart.append(col);
  });
  box.append(stats, chart);
  return box;
}

export function renderActivity(body: HTMLElement, rerender: () => void, byId: Map<string, Short>, app?: AppApi) {
  body.append(cloudLine());
  body.append(summary());

  const all = activityRows(byId, app);
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

  /** A small picture box: the video's thumbnail, or the event's icon. */
  const picture = (r: { vid?: string; icon: string; tone: Tone }) => {
    const box = el("div", `act-pic tone-${r.tone}`);
    if (r.vid && byId.has(r.vid)) {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      thumb(img, r.vid);
      box.append(img);
    } else box.append(el("span", "", r.icon));
    return box;
  };

  const open = (id: string) => {
    const s = byId.get(id);
    if (s && app) app.playList("Activity", [s], 0, rerender);
  };

  const draw = () => {
    const q = view.q.trim().toLowerCase();
    const rows = all.filter((r) => matches(r, view.cat, q));
    list.replaceChildren();
    if (!rows.length) {
      list.append(el("p", "ch-note", all.length ? "Nothing matches." : "Nothing yet. Changes you make from now on are written down here."));
      show(more, false);
      show(exportBtn, false);
      return;
    }
    show(exportBtn, true);
    const now = nowSec();
    const shownRows = rows.slice(0, view.shown);
    let day = "";
    for (const r of shownRows) {
      const k = dayKey(r.at);
      if (k !== day) {
        day = k;
        const n = rows.filter((x) => dayKey(x.at) === k).length;
        const h = el("h3", "act-day");
        h.append(el("span", "", dayLabel(r.at, now)), el("span", "act-day-n", `${n}`));
        list.append(h);
      }
      const row = el("div", `act-row${r.bad ? " bad" : ""}`);
      const text = el("div", "act-text");
      const top = el("div", "act-top");
      top.append(el("span", `act-badge tone-${r.tone}`, r.label));
      const when = el("time", "act-when", clock(r.at));
      when.title = `${new Date(r.at * 1000).toLocaleString()} (${ago(r.at)})`;
      top.append(when);
      text.append(top, el("div", "act-what", r.text));
      const sub = [r.sub, r.device ? (r.device === "phone" ? "📱 phone" : "💻 computer") : ""].filter(Boolean).join(" · ");
      if (sub) text.append(el("div", "act-sub", sub));
      if (r.progress !== undefined) {
        const bar = el("div", "act-progress");
        const fill = el("div", "act-progress-fill");
        fill.style.width = `${Math.round(Math.min(1, r.progress) * 100)}%`;
        bar.append(fill);
        text.append(bar);
      }
      row.append(picture(r), text);
      const canOpen = !!(r.vid && byId.has(r.vid) && app);
      if (canOpen) {
        row.classList.add("act-tap");
        clickable(row, () => open(r.vid!));
      }

      // a batch: the videos in it, one tap away
      if (r.ids?.length) {
        const toggle = btn(
          `Show the ${r.ids.length} videos`,
          (b) => {
            const wasOpen = !inner.hidden;
            inner.hidden = wasOpen;
            b.textContent = wasOpen ? `Show the ${r.ids!.length} videos` : "Hide the videos";
            b.setAttribute("aria-expanded", String(!wasOpen));
          },
          "act-more",
        );
        toggle.setAttribute("aria-expanded", "false");
        const inner = el("div", "act-batch");
        inner.hidden = true;
        for (const id of r.ids) {
          const s = byId.get(id);
          const mini = el("div", "act-mini");
          mini.append(picture({ vid: id, icon: "🎬", tone: "accent" }));
          const t = el("div", "act-text");
          t.append(el("div", "act-what", s?.t || "(no longer in your library)"));
          if (s && app) t.append(el("div", "act-sub", detailOf(s, app)));
          mini.append(t);
          if (s && app) {
            mini.classList.add("act-tap");
            clickable(mini, () => open(id));
          }
          inner.append(mini);
        }
        text.append(toggle);
        row.append(inner);
      }
      list.append(row);
    }
    const left = rows.length - view.shown;
    show(more, left > 0);
    if (left > 0) more.textContent = `Show ${Math.min(PAGE, left)} more (${left} left)`;
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
                const pic = el("div", "act-pic tone-success");
                pic.append(el("span", "", "☁️"));
                row.append(pic, text, when);
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
