/**
 * Everything that opens over the video: the menu panel (Channels, History, Saved, Hidden, Sync,
 * API usage, About), full pages (channel explorer, More like this), the ⋯ sheet and the first-time tips.
 * Plus the top bar: feed tabs, time range, categories, and ‹ › buttons for rows that don't fit.
 */
import { catLabel } from "./categories";
import { pickCategories } from "./catpicker";
import { bindFilterBar, renderFilterBar } from "./filters";
import { videoCats } from "./rank";
import { act, persist, state } from "./store";
import { renderChannelsPanel } from "./channels";
import { renderUsagePanel } from "./usage";
import { openSimilar } from "./similar";
import { renderHistory } from "./history";
import { renderSorting } from "./sorting";
import { clickable, modal } from "./a11y";
import { ago, btn, el } from "./dom";
import { els, thumb } from "./view";
import { playback, pool } from "./player";
import {
  app,
  channelsCtx,
  exitList,
  exploreCurrent,
  feed,
  hideChannel,
  onFeedChange,
  playList,
  renderMeta,
  renderSave,
  resetFeed,
  savedShort,
} from "./feed";
import { setRate } from "./controls";
import { maybeAutoFull } from "./fullscreen";
import { renderAbout, renderSyncPanel } from "./settings";
import { toast } from "./ui";
import type { Short, Tab } from "./types";

// ---------- overlays ----------
const pageModal = modal(els.page, { label: "Page", onRequestClose: () => closePage(), focus: () => els.pageClose });
const panelModal = modal(els.panel, {
  label: "Menu",
  onRequestClose: () => closePanel(),
  focus: () => els.ptabs.querySelector<HTMLElement>("button.on"),
});
const sheetModal = modal(els.moreSheet, { label: "More options", onRequestClose: () => sheetModal.close() });
const tipsModal = modal(els.tips, { label: "Quick tips", onRequestClose: () => closeTips(), focus: () => els.tipsOk });

/** Full-screen page over the feed (channel page, More like this). */
export function openPage(title: string, render: (body: HTMLElement) => void) {
  if (playback.playing) pool.pause();
  panelModal.close();
  sheetModal.close();
  els.pageTitle.textContent = title;
  els.page.setAttribute("aria-label", title);
  els.pageBody.replaceChildren();
  els.pageBody.scrollTop = 0;
  pageModal.open();
  render(els.pageBody);
}
export function closePage() {
  pageModal.close();
}

/** A list starts playing: get every overlay out of the way. */
export function closeOverlaysForPlayback() {
  pageModal.close();
  panelModal.close();
  sheetModal.close();
}

// ---------- menu panel ----------
let panelTab = "history";
export const currentPanelTab = () => panelTab;

export function openPanel(tab = panelTab) {
  panelTab = tab;
  if (playback.playing) pool.pause();
  renderPanel();
  panelModal.open();
}
export function closePanel() {
  panelModal.close();
  onFeedChange(); // skip the current Short if its channel was removed/hidden while the menu was open
}

export function renderPanel() {
  els.ptabs.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    const on = b.dataset.p === panelTab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const body = els.panelBody;
  body.replaceChildren();

  if (panelTab === "channels") renderChannelsPanel(body, channelsCtx());
  else if (panelTab === "history") renderHistory(body, app, feed.byId, () => openPanel("history"));
  else if (panelTab === "saved") renderSaved(body);
  else if (panelTab === "hidden") renderHidden(body);
  else if (panelTab === "sorting") renderSorting(body, app, () => openPanel("sorting"));
  else if (panelTab === "api") renderUsagePanel(body, feed.ds, ago);
  else if (panelTab === "sync") renderSyncPanel(body);
  else
    renderAbout(body, {
      showTips: () => {
        closePanel();
        tipsModal.open();
      },
    });
}

function renderSaved(body: HTMLElement) {
  const items = state.saved.map(savedShort).filter((s): s is Short => !!s);
  if (!items.length) {
    body.append(el("p", "", "No saved Shorts yet. Tap ♡ or double-tap a video to save it."));
    return;
  }
  body.append(btn("▶ Play all saved", () => playList("Saved", items, 0, () => openPanel("saved")), "btn primary"));
  const grid = el("div", "grid");
  items.forEach((s, i) => {
    const title = `${feed.ds.channels[s.ch]?.n ?? ""} · ${s.t}`;
    const card = clickable(el("div", "card"), () => playList("Saved", items, i, () => openPanel("saved")), `Play ${title}`);
    const img = el("img");
    img.loading = "lazy";
    img.alt = "";
    thumb(img, s.id);
    const x = btn(
      "✕",
      () => {
        act({ t: "unsave", id: s.id });
        renderPanel();
        renderSave();
      },
      "x",
    );
    x.title = "Remove from saved";
    x.setAttribute("aria-label", `Remove ${s.t} from saved`);
    x.addEventListener("click", (e) => e.stopPropagation());
    card.append(img, el("div", "cap", title), x);
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

function bindSheet() {
  els.moreBtn.onclick = () => {
    if (feed.cur) {
      renderSpeedRow();
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
    const a = (e.target as HTMLElement).closest("button")?.dataset.a;
    if (e.target !== els.moreSheet && !a) return;
    sheetModal.close();
    const cur = feed.cur;
    if (!cur) return;
    if (a === "similar") openSimilar(app, cur);
    else if (a === "channel") exploreCurrent();
    else if (a === "fixcat") fixCategory(cur);
    else if (a === "hide") hideChannel();
    else if (a === "open") window.open(`https://www.youtube.com/shorts/${cur.id}`, "_blank", "noopener");
  });
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
  scrollArrows(els.tabs);
  scrollArrows(els.chips);
  scrollArrows(els.ptabs);
  els.pageClose.onclick = closePage;
  els.page.addEventListener("click", (e) => {
    if (e.target === els.page) closePage();
  });
  els.ctxBack.onclick = exitList;
  els.menuBtn.onclick = () => openPanel();
  els.closePanel.onclick = closePanel;
  els.panel.addEventListener("click", (e) => {
    if (e.target === els.panel) closePanel();
  });
  els.ptabs.addEventListener("click", (e) => {
    const p = (e.target as HTMLElement).closest("button")?.dataset.p;
    if (p) openPanel(p);
  });
  els.tipsOk.onclick = closeTips;
  els.chName.addEventListener("click", (e) => {
    e.preventDefault();
    exploreCurrent();
  });
  els.chThumb.addEventListener("click", exploreCurrent);
}
