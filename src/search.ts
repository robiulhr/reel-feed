/**
 * Search (the 🔍 button, or press /): one box that searches everything of yours at once — the videos in
 * your library (title, channel or page, categories, your note on it, the topics it's in), your notes
 * and your topics. Words match from the start ("pric" finds "price"); every word you type must match.
 * If your library has nothing, it offers a YouTube search (on request, with the usual cost card).
 * Loaded only when used (its own file).
 */
import type { AppApi } from "./app";
import { btn, el } from "./dom";
import { loadLong } from "./data";
import { longCards, shortGrid } from "./explore";
import { openLongFrom } from "./home";
import { openPanel } from "./panels";
import { openTopicSearch } from "./similar";
import { searchNotes, searchTopics, searchVideos, type Only, wordsOf } from "./searchcore";
import type { Dataset, Short } from "./types";

// ---------- recent searches (this device) ----------
const RECENT_KEY = "ecomgy-reel-feed.recent-searches";
function recent(): string[] {
  try {
    const x = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(x) ? x.filter((s) => typeof s === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}
function remember(q: string) {
  const t = q.trim();
  if (!t) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([t, ...recent().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8)));
  } catch {
    /* storage blocked: no history, search still works */
  }
}
function forgetRecent() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- the page ----------
const view = { q: "", only: "all" as Only, kind: "all" as "all" | "shorts" | "long", shown: 24 };
const KINDS: ["shorts" | "long", string][] = [
  ["shorts", "Shorts"],
  ["long", "Long videos"],
];
const FILTERS: [Only, string][] = [
  ["all", "All"],
  ["saved", "Saved"],
  ["notes", "With notes"],
  ["yt", "YouTube"],
  ["fb", "Facebook"],
];

/** Opens the search page. `openTopic` shows one topic in the Menu. */
export function openSearch(app: AppApi) {
  app.openPage("Search", (body) => renderSearch(body, app));
}

let longDs: Dataset | null = null; // the long videos, loaded when search opens (they are searched too)

function renderSearch(body: HTMLElement, app: AppApi) {
  const input = el("input", "ch-search search-input");
  input.type = "search";
  input.placeholder = "Search videos, notes, topics…";
  input.setAttribute("aria-label", "Search your videos, notes and topics");
  input.autocomplete = "off";
  input.value = view.q;

  const chips = el("div", "chips search-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Only show");
  const out = el("div", "search-out");
  body.append(input, chips, out);

  const drawChips = () => {
    chips.replaceChildren();
    chips.style.display = wordsOf(view.q).length ? "" : "none"; // the filters only matter once you've typed something
    for (const [id, label] of FILTERS) {
      const b = btn(
        label,
        () => {
          view.only = id;
          view.shown = 24;
          draw();
        },
        view.only === id ? "on" : "",
      );
      b.setAttribute("aria-pressed", String(view.only === id));
      chips.append(b);
    }
    for (const [id, label] of KINDS) {
      const b = btn(
        label,
        () => {
          view.kind = view.kind === id ? "all" : id; // tap again to show both
          view.shown = 24;
          draw();
        },
        view.kind === id ? "on" : "",
      );
      b.setAttribute("aria-pressed", String(view.kind === id));
      chips.append(b);
    }
  };

  const draw = () => {
    drawChips();
    out.replaceChildren();
    const q = view.q.trim();
    if (!wordsOf(q).length) {
      const r = recent();
      if (r.length) {
        out.append(el("div", "u-h", "Recent searches"));
        const row = el("div", "search-recent");
        for (const x of r)
          row.append(
            btn(x, () => {
              view.q = input.value = x;
              view.shown = 24;
              draw();
            }),
          );
        row.append(
          btn(
            "Clear",
            () => {
              forgetRecent();
              draw();
            },
            "btn sm",
          ),
        );
        out.append(row);
      }
      out.append(
        el(
          "p",
          "ch-note",
          `Searches the ${app.ds.videos.length.toLocaleString()} videos in your library — titles, channels and pages, categories, your notes and your topics. Words match from the start, so “pric” finds “price”.`,
        ),
      );
      return;
    }

    const topics = searchTopics(q).slice(0, 4);
    const notes = searchNotes(q).slice(0, 4);
    const videos = view.kind === "long" ? [] : searchVideos(app, q, view.only);
    const longs = longDs && view.kind !== "shorts" ? searchVideos({ ds: longDs }, q, view.only) : [];

    if (topics.length) {
      out.append(el("div", "u-h", "Topics"));
      for (const t of topics) {
        const row = el("button", "search-row");
        row.type = "button";
        row.append(
          el("span", "search-row-ico", "📚"),
          el("span", "search-row-txt", t.name),
          el("span", "ch-note", `${t.vids.length} videos · ${t.notes.length} notes`),
        );
        row.onclick = async () => {
          remember(q);
          (await import("./topics")).showTopic(t.id);
          openPanel("topics");
        };
        out.append(row);
      }
    }
    if (notes.length && view.only === "all") {
      out.append(el("div", "u-h", "Notes"));
      for (const [id, n] of notes) {
        const s = app.ds.videos.find((v) => v.id === id) ?? feedShort(app, id);
        const ls = s ? undefined : longDs?.videos.find((v) => v.id === id);
        const row = el("button", "search-row");
        row.type = "button";
        row.append(
          el("span", "search-row-ico", "📝"),
          el("span", "search-row-txt", n.ti || s?.t || ls?.t || "Video"),
          el("span", "search-note", n.x.replace(/\s+/g, " ").slice(0, 120)),
        );
        row.onclick = () => {
          if (!s && ls && longDs) {
            remember(q);
            app.closePage();
            openLongFrom(ls, [ls], longDs);
            return;
          }
          if (!s) return;
          remember(q);
          app.playList("Search", [s], 0, () => openSearch(app));
        };
        out.append(row);
      }
    }

    out.append(el("div", "u-h", `${longs.length ? "Shorts" : "Videos"} · ${videos.length.toLocaleString()}`));
    const drawLongs = () => {
      if (!longs.length || !longDs) return;
      const ds = longDs;
      out.append(el("div", "u-h", `Long videos · ${longs.length.toLocaleString()}`));
      const list = el("div", "cp-videos-l");
      list.append(
        ...longCards(app, longs.slice(0, 24), (s) => {
          remember(q);
          app.closePage();
          openLongFrom(s, longs, ds);
        }),
      );
      out.append(list);
    };
    if (!videos.length && longs.length) {
      out.append(el("p", "ch-note", "No Shorts match — see the long videos below."));
      return drawLongs();
    }
    if (!videos.length) {
      out.append(el("p", "ch-note", `Nothing in your library for “${q}”${view.only === "all" ? "" : " with this filter"}.`));
      if (view.only !== "all")
        out.append(
          btn("Show all", () => {
            view.only = "all";
            draw();
          }),
        );
      out.append(
        btn(
          "🔎 Search YouTube for it",
          () => {
            remember(q);
            openTopicSearch(app, { id: `q${wordsOf(q).join("-").slice(0, 30)}`, name: q, kw: [q] });
          },
          "btn sm primary",
        ),
        el("p", "ch-note", "Searches all of YouTube. It costs about 103 of your daily units; you'll see the cost first."),
      );
      return;
    }
    const shown = videos.slice(0, view.shown);
    const play = (i: number) => {
      remember(q);
      app.playList(`Search: ${q}`, videos, i, () => openSearch(app));
    };
    out.append(btn("▶ Play all", () => play(0), "btn sm primary"));
    out.append(shortGrid(app, shown, play, { showChannel: true }));
    if (videos.length > shown.length)
      out.append(
        btn(
          `Show more (${videos.length - shown.length})`,
          () => {
            view.shown += 24;
            draw();
          },
          "btn sm",
        ),
      );
    drawLongs();
    out.append(
      btn("🔎 Search YouTube instead", () => openTopicSearch(app, { id: `q${wordsOf(q).join("-").slice(0, 30)}`, name: q, kw: [q] })),
    );
  };

  let timer: number | undefined;
  input.addEventListener("input", () => {
    view.q = input.value;
    view.shown = 24;
    clearTimeout(timer);
    timer = window.setTimeout(draw, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      draw();
      remember(input.value);
    }
  });
  draw();
  void loadLong().then((ds) => {
    if (ds && body.isConnected) {
      longDs = ds;
      draw();
    }
  });
  setTimeout(() => input.focus(), 50);
}

const feedShort = (app: AppApi, id: string): Short | undefined => app.ds.videos.find((v) => v.id === id);
