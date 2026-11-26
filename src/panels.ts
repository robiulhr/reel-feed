/**
 * Everything that opens over the video: the menu panel (Channels, History, Saved, Hidden, Sync,
 * API usage, About), full pages (channel explorer, More like this), the ⋯ sheet and the first-time tips.
 * Plus the top bar: feed tabs, time range, categories, and ‹ › buttons for rows that don't fit.
 */
import { type CatId, catInfo, catLabel, GROUPS, type GroupId, groupCats, groupInfo, groupOf, type Lang } from "./categories";
import { pickCategories } from "./catpicker";
import { bindFilterBar, LANG_OPTS, renderFilterBar, WINS } from "./filters";
import { videoCats } from "./rank";
import { act, persist, state } from "./store";
import { renderChannelsPanel, showFacebook } from "./channels";
import { renderUsagePanel } from "./usage";
import { openSimilar } from "./similar";
import { renderHistory } from "./history";
import { renderSorting } from "./sorting";
import { clickable, modal } from "./a11y";
import { ago, btn, el, nowSec } from "./dom";
import { els, thumb } from "./view";
import { playback, pool } from "./player";
import {
  app,
  channelsCtx,
  exploreCurrent,
  feed,
  hideChannel,
  leaveList,
  onFeedChange,
  playList,
  renderMeta,
  renderSave,
  resetFeed,
  savedShort,
} from "./feed";
import { setRate } from "./controls";
import { maybeAutoFull } from "./fullscreen";
import { renderAbout, renderBackups, renderSyncPanel } from "./settings";
import { undoable } from "./backup";
import { toast } from "./ui";
import { LISTS_EVENT, listById, listLabel, pickLists } from "./lists";
import { fbPageOf } from "./fbdata";
import { deleteManual, fbVideoDialog, openBulkAdd, openOnFacebook, renderAdded } from "./manual";
import { shortInList } from "./rank";
import type { Short, Tab, Win } from "./types";
import { PAGE_TITLES, renderHome, renderNav } from "./menuhome";
import { dismiss, go, pushLayer, type Route, toPath } from "./router";

// ---------- overlays ----------
// ✕, Esc and tapping outside are the same as Back (router.dismiss); the router then closes it.
const pageModal = modal(els.page, { label: "Page", onRequestClose: () => dismiss(), focus: () => els.pageClose });
const panelModal = modal(els.panel, {
  label: "Menu",
  onRequestClose: () => dismiss(),
  focus: () => els.panelTitle,
});
const sheetModal = layered(modal(els.moreSheet, { label: "More options", onRequestClose: () => sheetModal.close() }));
const tipsModal = layered(modal(els.tips, { label: "Quick tips", onRequestClose: () => closeTips(), focus: () => els.tipsOk }), () =>
  closeTips(),
);

/** A sheet that Back closes: opening it adds a Back step, closing it takes the step out again. */
function layered<M extends { open(): void; close(): void; isOpen(): boolean }>(m: M, onBack = () => m.close()): M {
  const open = m.open.bind(m);
  const close = m.close.bind(m);
  let closed: (() => void) | null = null;
  m.open = () => {
    if (!m.isOpen()) closed = pushLayer(() => (m.isOpen() ? onBack() : undefined));
    open();
  };
  m.close = () => {
    close();
    closed?.();
    closed = null;
  };
  return m;
}

/** The page on screen (its address), so Back only re-draws a page that isn't showing already. */
let shownPage = "";
let pageLayer: (() => void) | null = null; // the Back step of a page that has no address (see openPage)
export const shownPagePath = () => (pageModal.isOpen() ? shownPage : "");

/** Full-screen page over the feed (channel page, More like this). `route` = its address. */
export function openPage(title: string, render: (body: HTMLElement) => void, route?: Route) {
  if (playback.playing) pool.pause();
  panelModal.close();
  sheetModal.close();
  if (route) {
    go(route);
    shownPage = toPath(route);
  } else if (!pageModal.isOpen()) {
    // a page without an address of its own (Search…): Back still closes it, and ✕ takes that Back step out again
    pageLayer = pushLayer(() => {
      pageLayer = null;
      if (pageModal.isOpen()) pageModal.close();
      shownPage = "";
    });
  }
  els.page.classList.toggle("over-watch", document.getElementById("watch")?.hidden === false); // opened from the player page: above it
  els.pageTitle.textContent = title;
  els.page.setAttribute("aria-label", title);
  els.pageBody.replaceChildren();
  els.pageBody.scrollTop = 0;
  pageModal.open();
  render(els.pageBody);
}
/** Closes the page (no history step — the router or a new screen decides that). */
export function closePage() {
  pageModal.close();
  shownPage = "";
  const done = pageLayer;
  pageLayer = null;
  done?.();
}

/** A list starts playing: get every overlay out of the way. */
export function closeOverlaysForPlayback() {
  const w = document.getElementById("watch");
  if (w && !w.hidden) void import("./watch").then((m) => m.hideWatch()); // a Short starts: the player page gives way
  closePage();
  panelModal.close();
  sheetModal.close();
}

// ---------- menu panel ----------
let panelTab = "home"; // the Menu opens on its home screen; each page has a back arrow to it
export const currentPanelTab = () => panelTab;
export const panelOpen = () => panelModal.isOpen();

const wideMenu = () => matchMedia("(min-width: 900px)").matches; // the sections sit in a sidebar, so the Menu opens on one of them

export function openPanel(tab = "home") {
  if (tab === "home" && wideMenu()) tab = "saved";
  if (tab === "added") {
    // the videos you added now live in Channels & pages → Facebook → Videos (old links and the extension still open this address)
    showFacebook("videos");
    tab = "channels";
  }
  const wasOpen = panelModal.isOpen();
  panelTab = tab;
  if (playback.playing) pool.pause();
  closePage();
  go({ k: "panel", tab }, { replace: wasOpen }); // switching tabs doesn't add Back steps
  renderPanel();
  panelModal.open();
}
/** Closes the menu (no history step — see dismiss()). */
export function closePanel() {
  if (!panelModal.isOpen()) return;
  panelModal.close();
  onFeedChange(); // skip the current Short if its channel was removed/hidden while the menu was open
}

/** Counts every draw of the Menu: a page whose code arrives late must not draw into a newer screen (or twice). */
let drawn = 0;

export function renderPanel() {
  const mine = ++drawn;
  els.panelTitle.textContent = PAGE_TITLES[panelTab] ?? "Menu";
  els.panelBack.hidden = panelTab === "home";
  const body = els.panelBody;
  body.replaceChildren();
  body.classList.toggle("mh", panelTab === "home");
  if (wideMenu()) renderNav(document.getElementById("panelNav") as HTMLElement, panelTab, (t) => openPanel(t));
  body.scrollTop = 0;

  if (panelTab === "home") renderHome(body, (t) => openPanel(t));
  else if (panelTab === "channels")
    renderChannelsPanel(body, {
      ...channelsCtx(),
      fb: { renderVideos: renderAdded, addVideo: () => fbVideoDialog(), addSeveral: () => openBulkAdd() },
    });
  else if (panelTab === "history") renderHistory(body, app, feed.byId, () => openPanel("history"));
  else if (panelTab === "saved") renderSaved(body);
  else if (panelTab === "notes")
    void import("./notes").then((m) => {
      if (panelTab === "notes" && mine === drawn) m.renderNotesPage(body, () => openPanel("notes"));
    });
  else if (panelTab === "playlists")
    void import("./playlists").then((m) => {
      if (panelTab === "playlists" && mine === drawn) m.renderPlaylistsPage(body, () => openPanel("playlists"), app);
    });
  else if (panelTab === "topics")
    void import("./topics").then((m) => {
      if (panelTab === "topics" && mine === drawn) m.renderTopicsPage(body, () => openPanel("topics"), app);
    });
  else if (panelTab === "activity")
    void import("./activity").then((m) => {
      if (panelTab === "activity" && mine === drawn) m.renderActivity(body, () => openPanel("activity"), feed.byId, app);
    });
  else if (panelTab === "hidden") renderHidden(body);
  else if (panelTab === "sorting") renderSorting(body, app, () => openPanel("sorting"));
  else if (panelTab === "api") renderUsagePanel(body, feed.ds, ago);
  else if (panelTab === "sync") renderSyncPanel(body);
  else if (panelTab === "backups") renderBackups(body);
  else
    renderAbout(body, {
      showTips: () => {
        closePanel();
        tipsModal.open();
      },
    });
}

/** Saved list filters (kept while the app is open). */
const savedFilter = {
  list: "", // a channel list's id ("" = all)
  src: "" as "" | "yt" | "fb", // where from: YouTube or Facebook videos you added ("" = both)
  group: "" as GroupId | "",
  cat: "" as CatId | "",
  lang: "all" as Lang | "all",
  win: "all" as Win,
  sort: "saved" as "saved" | "views" | "new",
  q: "",
};

function renderSaved(body: HTMLElement) {
  const all = state.saved.map(savedShort).filter((s): s is Short => !!s);
  if (!all.length) {
    body.append(el("p", "", "No saved Shorts yet. Tap ♡ or double-tap a video to save it."));
    return;
  }
  const f = savedFilter;
  const now = nowSec();
  const chName = (s: Short) => feed.ds.channels[s.ch]?.n ?? "";
  // everything except the category, so the chip counts show what each chip would give
  const chH = (s: Short) => feed.ds.channels[s.ch]?.h ?? "";
  const fromHere = (s: Short) => !f.src || (f.src === "fb") === !!s.fb;
  const unlisted = all.filter(
    (s) =>
      fromHere(s) &&
      (f.lang === "all" || s.lg === f.lang) &&
      (f.win === "all" || now - s.p <= Number(f.win) * 86400) &&
      (!f.q || `${s.t} ${chName(s)}`.toLowerCase().includes(f.q.toLowerCase())),
  );
  if (f.list && !listById(f.list)) f.list = "";
  const curList = f.list ? listById(f.list) : undefined;
  const base = curList ? unlisted.filter((s) => shortInList(curList, s, chH(s))) : unlisted;
  const inGroup = (s: Short, g: GroupId) => videoCats(s, state).some((c) => groupOf(c) === g);
  const items = base.filter((s) => (f.cat ? videoCats(s, state).includes(f.cat) : !f.group || inGroup(s, f.group)));
  if (f.sort === "views") items.sort((x, y) => y.v - x.v);
  else if (f.sort === "new") items.sort((x, y) => y.p - x.p);

  // ---- controls
  const head = el("div", "sv-head");
  const search = el("input", "ch-search");
  search.type = "search";
  search.placeholder = "Search saved";
  search.setAttribute("aria-label", "Search saved Shorts");
  search.value = f.q;
  let t: number | undefined;
  search.oninput = () => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      f.q = search.value.trim();
      renderPanel();
      const again = els.panelBody.querySelector<HTMLInputElement>(".sv-head input");
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    }, 250);
  };
  head.append(search);

  const pick = <T extends string>(label: string, opts: [T, string][], value: T, set: (v: T) => void) => {
    const sel = el("select");
    sel.setAttribute("aria-label", label);
    for (const [v, l] of opts) sel.append(new Option(l, v));
    sel.value = value;
    sel.onchange = () => {
      set(sel.value as T);
      renderPanel();
    };
    return sel;
  };
  const row = el("div", "cp-filters sv-filters");
  row.append(
    pick(
      "Sort",
      [
        ["saved", "Recently saved"],
        ["views", "Most viewed"],
        ["new", "Newest"],
      ],
      f.sort,
      (v) => {
        f.sort = v;
      },
    ),
    pick("Time range", WINS, f.win, (v) => {
      f.win = v;
    }),
  );
  const langsHere = new Set(all.map((s) => s.lg));
  if (langsHere.size > 1)
    row.append(
      pick(
        "Language",
        LANG_OPTS.filter(([v]) => v === "all" || langsHere.has(v)),
        f.lang,
        (v) => {
          f.lang = v;
        },
      ),
    );

  // main categories, then (when one is picked) its topics
  const chip = (label: string, on: boolean, run: () => void, extra = "") => {
    const c = btn(label, run, `chip${on ? " on" : ""}${extra}`);
    c.setAttribute("aria-pressed", String(on));
    return c;
  };
  const groups = GROUPS.map((g) => [g, base.filter((s) => inGroup(s, g.id)).length] as const).filter(([, n]) => n);
  const gRow = el("div", "cp-chips sv-chips");
  gRow.setAttribute("role", "group");
  gRow.setAttribute("aria-label", "Main category");
  gRow.append(
    chip(`All · ${base.length}`, !f.group, () => {
      f.group = "";
      f.cat = "";
      renderPanel();
    }),
  );
  for (const [g, n] of groups)
    gRow.append(
      chip(`${g.icon} ${g.label} · ${n}`, f.group === g.id, () => {
        f.group = f.group === g.id ? "" : g.id;
        f.cat = "";
        renderPanel();
      }),
    );
  // your channel lists: Competitors, Inspiration… each one its own Saved list
  const listCounts = state.lists
    .map((l) => [l, unlisted.filter((s) => shortInList(l, s, chH(s))).length] as const)
    .filter(([l, n]) => n || l === curList);
  if (listCounts.length) {
    const lRow = el("div", "cp-chips sv-chips sv-lists");
    lRow.setAttribute("role", "group");
    lRow.setAttribute("aria-label", "Channel list");
    lRow.append(
      chip(`All saved · ${unlisted.length}`, !f.list, () => {
        f.list = "";
        renderPanel();
      }),
    );
    for (const [l, n] of listCounts)
      lRow.append(
        chip(`${listLabel(l)} · ${n}`, f.list === l.id, () => {
          f.list = f.list === l.id ? "" : l.id;
          f.group = "";
          f.cat = "";
          renderPanel();
        }),
      );
    body.append(head, row, lRow, gRow);
  } else body.append(head, row, gRow);
  // YouTube Shorts and Facebook videos you added, apart
  const fbSaved = all.filter((s) => s.fb).length;
  if (fbSaved || f.src) {
    const sRow = el("div", "cp-chips sv-chips sv-src");
    sRow.setAttribute("role", "group");
    sRow.setAttribute("aria-label", "Source");
    const srcChip = (v: typeof f.src, label: string) =>
      chip(label, f.src === v, () => {
        f.src = v;
        renderPanel();
      });
    sRow.append(
      srcChip("", `All · ${all.length}`),
      srcChip("yt", `▶ YouTube · ${all.length - fbSaved}`),
      srcChip("fb", `f Facebook · ${fbSaved}`),
    );
    head.after(sRow);
  }
  if (f.group) {
    const topics = groupCats(f.group)
      .map((c) => [c, base.filter((s) => videoCats(s, state).includes(c)).length] as const)
      .filter(([, n]) => n);
    if (topics.length > 1) {
      const tRow = el("div", "cp-chips sv-chips");
      tRow.setAttribute("role", "group");
      tRow.setAttribute("aria-label", "Topic");
      tRow.append(
        chip(`All ${groupInfo(f.group)?.label ?? ""}`, !f.cat, () => {
          f.cat = "";
          renderPanel();
        }),
      );
      for (const [c, n] of topics)
        tRow.append(
          chip(`${catInfo(c)?.short ?? c} · ${n}`, f.cat === c, () => {
            f.cat = f.cat === c ? "" : c;
            renderPanel();
          }),
        );
      body.append(tRow);
    }
  }

  const filtered = items.length !== all.length;
  const back = () => openPanel("saved");
  body.append(
    btn(
      filtered ? `▶ Play these ${items.length}` : `▶ Play all saved (${all.length})`,
      () => playList("Saved", items, 0, back),
      "btn primary sv-play",
    ),
  );
  if (!items.length) {
    body.append(el("p", "ch-note", "Nothing saved matches these filters."));
    return;
  }
  const grid = el("div", "grid");
  items.forEach((s, i) => {
    const title = `${chName(s)} · ${s.t}`;
    // the play area and ✕ sit side by side (a button inside a button confuses screen readers)
    const card = el("div", "card");
    const play = clickable(el("div", "card-play"), () => playList("Saved", items, i, back), `Play ${title}`);
    const img = el("img");
    img.loading = "lazy";
    img.alt = "";
    thumb(img, s.id);
    const x = btn(
      "✕",
      () => {
        const at = state.saved.indexOf(s.id);
        act({ t: "unsave", id: s.id });
        renderPanel();
        renderSave();
        undoable("Removed from saved", () => {
          act({ t: "save", id: s.id, i: at });
          renderPanel();
          renderSave();
        });
      },
      "x",
    );
    x.title = "Remove from saved";
    x.setAttribute("aria-label", `Remove ${s.t} from saved`);
    play.append(img, el("div", "cap", title));
    card.append(play, x);
    grid.append(card);
  });
  body.append(grid);
}

function renderHidden(body: HTMLElement) {
  if (!state.hidden.length) {
    body.append(el("p", "", "No hidden channels. Use ⋯ → Hide on a video to stop seeing a channel."));
    return;
  }
  for (const h of state.hidden) {
    const ch = feed.ds.channels.find((c) => c.h === h);
    const row = el("div", "row");
    row.append(
      el("span", "", ch ? `${ch.n} (${h})` : h),
      btn(
        "Unhide",
        () => {
          act({ t: "unhide", h });
          renderPanel();
          undoable(`Unhidden ${ch?.n ?? h}`, () => {
            act({ t: "hide", h });
            renderPanel();
          });
        },
        "btn",
      ),
    );
    body.append(row);
  }
}

// ---------- ⋯ sheet ----------
function renderSpeedRow() {
  els.moreSheet.querySelectorAll<HTMLButtonElement>("button[data-r]").forEach((b) => {
    const on = Number(b.dataset.r) === state.rate;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

/** The "When it ends" and "Repeat list" buttons show what is chosen. */
function renderEndRow() {
  for (const b of els.moreSheet.querySelectorAll<HTMLButtonElement>("button[data-m]")) {
    const on = b.dataset.m === state.endMode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  const lr = els.moreSheet.querySelector<HTMLButtonElement>("button[data-lr]");
  if (lr) {
    lr.classList.toggle("on", state.listRepeat);
    lr.setAttribute("aria-pressed", String(state.listRepeat));
  }
}

/**
 * Runs `open` a moment after the ⋯ sheet closed. The sheet closes by going back one step in the history;
 * a dialog that opened just before that step arrived would be closed by it (code already loaded = instant).
 */
const afterSheet = (open: () => Promise<unknown>) => new Promise<void>((r) => setTimeout(r, 160)).then(open);

function bindSheet() {
  els.moreBtn.onclick = () => {
    if (feed.cur) {
      renderSpeedRow();
      renderEndRow();
      renderSheetFor(feed.cur);
      sheetModal.open();
    }
  };
  els.moreSheet.addEventListener("click", (e) => {
    const rateBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-r]");
    if (rateBtn) {
      setRate(Number(rateBtn.dataset.r));
      renderSpeedRow();
      return;
    }
    const modeBtn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-m]");
    if (modeBtn) {
      state.endMode = modeBtn.dataset.m as typeof state.endMode;
      persist();
      renderEndRow();
      toast(
        state.endMode === "loop"
          ? "Each video repeats"
          : state.endMode === "next"
            ? "Plays the next one when a video ends"
            : "Stops when a video ends",
      );
      return;
    }
    if ((e.target as HTMLElement).closest("button[data-lr]")) {
      state.listRepeat = !state.listRepeat;
      if (state.listRepeat) state.endMode = "next"; // repeating a list means going from one to the next
      persist();
      renderEndRow();
      toast(state.listRepeat ? "Lists start again at the end" : "Lists stop at the end");
      return;
    }
    const a = (e.target as HTMLElement).closest("button")?.dataset.a;
    if (e.target !== els.moreSheet && !a) return;
    sheetModal.close();
    const cur = feed.cur;
    if (!cur) return;
    if (a === "similar") openSimilar(app, cur);
    else if (a === "channel") exploreCurrent();
    else if (a === "fixcat") cur.fb ? void editAdded(cur) : fixCategory(cur);
    else if (a === "fbadd") void fbVideoDialog();
    else if (a === "fbpage") {
      const p = fbPageOf(state, cur, feed.ds.channels[cur.ch]?.h ?? "");
      if (p?.url) openOnFacebook(p.url);
    } else if (a === "fbdel") {
      const m = state.manual.find((x) => `fb${x.id}` === cur.id);
      if (m) deleteManual(m, () => {});
    } else if (a === "lists") listCurrentChannel(cur);
    else if (a === "sleep") void afterSheet(() => import("./sleep").then((m) => m.openSleep()));
    else if (a === "playlist") void afterSheet(() => import("./playlists").then((m) => m.pickPlaylist(cur)));
    else if (a === "hide") hideChannel();
    else if (a === "open")
      cur.fb ? openOnFacebook(cur.fb.url) : window.open(`https://www.youtube.com/shorts/${cur.id}`, "_blank", "noopener");
  });
}

/** The ⋯ sheet's buttons for the video on screen (a Facebook video you added has its own). */
function renderSheetFor(s: Short) {
  const b = (a: string) => els.moreSheet.querySelector<HTMLButtonElement>(`button[data-a="${a}"]`);
  const fb = !!s.fb;
  const page = fbPageOf(state, s, feed.ds.channels[s.ch]?.h ?? "");
  const open = b("open");
  if (open) open.textContent = fb ? "↗ Open video on Facebook" : "↗ Open on YouTube";
  const fix = b("fixcat");
  if (fix) fix.textContent = fb ? "✎ Edit this video (title, note, categories…)" : "🏷 Wrong category?";
  const pageBtn = b("fbpage");
  if (pageBtn) pageBtn.hidden = !page?.url;
  const del = b("fbdel");
  if (del) del.hidden = !fb;
  const similar = b("similar");
  if (similar) similar.hidden = fb; // "More like this" searches YouTube
  const ch = b("channel");
  if (ch) ch.textContent = feed.ds.channels[s.ch]?.st === "fb" ? "👤 This page's videos" : "👤 Explore this channel";
  const lists = b("lists");
  if (lists) lists.textContent = feed.ds.channels[s.ch]?.st === "fb" ? "📋 Add page to a list" : "📋 Add channel to a list";
  // a video with no page set: nothing to list or hide
  const noPage = feed.ds.channels[s.ch]?.h === "fb:";
  if (lists) lists.hidden = noPage;
  const hide = b("hide");
  if (hide) hide.hidden = noPage;
}

async function editAdded(s: Short) {
  const m = state.manual.find((x) => `fb${x.id}` === s.id);
  if (m) await fbVideoDialog({ edit: m });
}

// ---------- tips ----------
function closeTips() {
  maybeAutoFull(); // "Got it" is a tap — a good moment to go full screen
  tipsModal.close();
  state.tipsSeen = true;
  persist();
}
export function showTipsIfNew() {
  if (!state.tipsSeen) tipsModal.open();
}

// ---------- channel lists ----------
function listCurrentChannel(s: Short) {
  const ch = feed.ds.channels[s.ch];
  if (ch) void pickLists(ch.h, ch.n);
}

/** Lists changed: the chips show the new lists, and a list's feed shows its channels now. */
function afterListsChange() {
  renderFilterBar();
  if (state.list) resetFeed();
}

// ---------- "Wrong category?" ----------
async function fixCategory(s: Short) {
  const auto = s.k;
  const fixed = !!state.catFix[s.id];
  const cats = await pickCategories({
    title: "Categories for this Short",
    current: videoCats(s, state),
    note: `Sorted automatically as: ${auto.map(catLabel).join(", ") || "nothing"}${s.g ? " (a guess from the channel)" : ""}.${fixed ? " You changed it before." : ""}`,
    allowEmpty: true,
    emptyLabel: "Nothing picked — Save goes back to automatic sorting",
  });
  if (!cats) return;
  act({ t: "catFix", id: s.id, cats: cats.join() === auto.join() ? [] : cats });
  renderMeta();
  toast(cats.length ? `Saved: ${cats.map(catLabel).join(", ")}` : "Back to automatic sorting");
}

// ---------- top bar: tabs, time range, language, categories ----------
export function renderControls() {
  const mark = (b: HTMLButtonElement, on: boolean) => {
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  };
  els.tabs.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    mark(b, b.dataset.tab === state.tab);
  });
  renderFilterBar();
}

function bindTopBar() {
  bindFilterBar();
  els.tabs.setAttribute("aria-label", "Feed");
  els.tabs.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest("button")?.dataset.tab as Tab | undefined;
    if (!tab || tab === state.tab) return;
    state.tab = tab;
    persist();
    renderControls();
    resetFeed();
  });
}

/** ‹ › buttons for rows that don't fit (tabs, categories, menu tabs). Keyboard users just Tab along the row. */
function scrollArrows(row: HTMLElement) {
  const wrap = el("div", "scroll-wrap");
  row.replaceWith(wrap);
  wrap.append(row);
  const mk = (cls: string, label: string, dir: number) => {
    const b = el("button", `scroll-arrow ${cls}`, label);
    b.type = "button";
    b.tabIndex = -1;
    b.setAttribute("aria-hidden", "true");
    b.onclick = (e) => {
      e.stopPropagation();
      row.scrollBy({ left: dir * row.clientWidth * 0.7 });
    };
    wrap.append(b);
    return b;
  };
  const left = mk("left", "‹", -1);
  const right = mk("right", "›", 1);
  const update = () => {
    const max = row.scrollWidth - row.clientWidth;
    left.hidden = row.scrollLeft <= 4;
    right.hidden = max <= 4 || row.scrollLeft >= max - 4;
  };
  row.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(row);
  // keep the selected / focused item in view
  row.addEventListener("click", (e) =>
    (e.target as HTMLElement).closest("button")?.scrollIntoView({ inline: "nearest", block: "nearest" }),
  );
  row.addEventListener("focusin", (e) => (e.target as HTMLElement).scrollIntoView({ inline: "nearest", block: "nearest" }));
  update();
}

export function initPanels() {
  bindTopBar();
  bindSheet();
  window.addEventListener(LISTS_EVENT, afterListsChange);
  scrollArrows(els.tabs);
  scrollArrows(els.chips);
  els.pageClose.onclick = dismiss;
  els.page.addEventListener("click", (e) => {
    if (e.target === els.page) dismiss();
  });
  els.ctxBack.onclick = leaveList;
  els.menuBtn.onclick = () => openPanel();
  els.closePanel.onclick = dismiss;
  els.panel.addEventListener("click", (e) => {
    if (e.target === els.panel) dismiss();
  });
  els.panelBack.onclick = () => openPanel("home");
  els.tipsOk.onclick = closeTips;
  els.chName.addEventListener("click", (e) => {
    e.preventDefault();
    exploreCurrent();
  });
  els.chThumb.addEventListener("click", exploreCurrent);
}
