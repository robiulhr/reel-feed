/**
 * Watch history (Menu ☰ → History): every Short you watched, newest first, grouped by day,
 * with how much you watched. Search, replay, remove, clear, pause. Synced across devices.
 */
import type { AppApi } from "./app";
import { act, persist, state, type HistItem } from "./store";
import { confirmDialog } from "./ui";
import type { Short } from "./types";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

let query = "";

function dayLabel(sec: number) {
  const d = new Date(sec * 1000);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

function watchedLabel(f: number) {
  if (f >= 0.9) return "✓ Watched";
  if (f < 0.15) return "Skipped";
  return `${Math.round(f * 100)}% watched`;
}

/** Turn history entries into playable Shorts (library ones, or rebuilt from saved title/channel). */
export function historyShorts(app: AppApi, byId: Map<string, Short>, items: HistItem[]): Short[] {
  const out: Short[] = [];
  for (const h of items) {
    const s = byId.get(h.id);
    if (s) { out.push(s); continue; }
    if (!h.x) continue;
    const ch = app.ensureChannel({ id: h.x.c, name: h.x.n, handle: h.x.h, thumb: "", subs: 0 });
    const made: Short = { id: h.id, ch, t: h.x.t, p: 0, v: 0, l: 0, c: 0, o: 0, e: 0, tr: 0, r: 0 };
    byId.set(h.id, made);
    out.push(made);
  }
  return out;
}

export function renderHistory(body: HTMLElement, app: AppApi, byId: Map<string, Short>, rerender: () => void) {
  const head = el("div", "h-head");
  const search = el("input", "ch-search") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Search your history…";
  search.value = query;
  const pause = el("button", "btn sm", state.histPaused ? "▶ Resume history" : "⏸ Pause history");
  pause.onclick = () => { state.histPaused = !state.histPaused; persist(); rerender(); };
  const clear = el("button", "btn sm danger", "Clear all");
  clear.onclick = async () => {
    if (!state.hist.length) return;
    const ok = await confirmDialog({
      title: "Clear your whole watch history?",
      body: "This clears it on all your devices. (Your saved Shorts and what the feed learned stay.)",
      confirm: "Clear history", danger: true,
    });
    if (ok) { act({ t: "histClear" }); rerender(); }
  };
  head.append(search, pause, clear);
  body.append(head);
  if (state.histPaused) body.append(el("p", "ch-note warn", "History is paused on this device — new Shorts you watch aren't recorded."));

  const list = el("div", "h-list");
  body.append(list);

  const draw = () => {
    list.replaceChildren();
    const q = query.trim().toLowerCase();
    const all = state.hist;
    const shown = all.filter((h) => {
      if (!q) return true;
      const s = byId.get(h.id);
      const title = s?.t ?? h.x?.t ?? "";
      const chName = s ? app.ds.channels[s.ch]?.n ?? "" : h.x?.n ?? "";
      return `${title} ${chName}`.toLowerCase().includes(q);
    });
    if (!all.length) { list.append(el("p", "ch-note", "Nothing here yet. Shorts you watch will show up here, newest first.")); return; }
    if (!shown.length) { list.append(el("p", "ch-note", "No matches.")); return; }
    list.append(el("p", "ch-note", `${shown.length} Short${shown.length === 1 ? "" : "s"}`));

    const playable = historyShorts(app, byId, shown);
    let lastDay = "";
    shown.forEach((h) => {
      const s = byId.get(h.id);
      if (!s) return;
      const day = dayLabel(h.at);
      if (day !== lastDay) { list.append(el("div", "h-day", day)); lastDay = day; }
      const row = el("div", "h-row");
      const img = el("img", "h-thumb") as HTMLImageElement;
      img.loading = "lazy";
      img.alt = "";
      app.thumb(img, h.id);
      const txt = el("div", "h-txt");
      txt.append(
        el("div", "h-title", s.t),
        el("div", "ch-note", `${app.ds.channels[s.ch]?.n ?? ""} · ${new Date(h.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`),
        el("div", `h-status${h.f >= 0.9 ? " done" : ""}`, watchedLabel(h.f)),
      );
      const x = el("button", "h-x", "✕");
      x.title = "Remove from history";
      x.onclick = (e) => { e.stopPropagation(); act({ t: "histDel", id: h.id }); draw(); };
      row.onclick = () => app.playList("History", playable, playable.indexOf(s), rerender);
      row.append(img, txt, x);
      list.append(row);
    });
  };
  let t: number | undefined;
  search.oninput = () => { clearTimeout(t); t = window.setTimeout(() => { query = search.value; draw(); }, 120); };
  draw();
}
