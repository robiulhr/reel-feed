/**
 * The Menu's home screen: where everything is, in groups, with a number or a warning on each, and how
 * your data stands (saved to the cloud or not) on top. Each card opens a page; a page has a back arrow
 * here (panels.ts), so there is no row of 12 tabs to scroll through.
 */
import { cloudLine } from "./cloud";
import { el } from "./dom";
import { feed } from "./feed";
import { isGuessed } from "./rank";
import { state } from "./store";

/** The pages, in the order the Menu's back-arrow header names them. */
export const PAGE_TITLES: Record<string, string> = {
  home: "Menu",
  saved: "Saved",
  added: "Added Facebook videos",
  notes: "Notes",
  topics: "Topics",
  playlists: "Playlists",
  history: "Watch history",
  hidden: "Hidden channels",
  channels: "Channels & pages",
  sorting: "Sorting",
  activity: "Activity",
  sync: "Sync",
  backups: "Backups",
  api: "API usage",
  about: "About",
};

interface Item {
  tab: string;
  icon: string;
  label: string;
  note?: string; // the number or short status on the card
  warn?: boolean; // the note needs attention (orange)
}

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
};

function items(): { title: string; cards?: boolean; rows: Item[] }[] {
  const channels = feed.ds.channels.filter((c) => c.st === "active" || c.st === "noShorts").length;
  const pages = feed.ds.channels.filter((c) => c.st === "fb").length; // Facebook pages with videos you added
  const toCheck = feed.ds.videos.filter((s) => feed.ds.channels[s.ch]?.st === "active" && isGuessed(s, state)).length;
  const today = state.activity.filter((e) => e.at >= startOfToday()).length;
  const notes = Object.keys(state.notes).length;
  return [
    {
      title: "Your library",
      cards: true,
      rows: [
        { tab: "saved", icon: "♡", label: "Saved", note: plural(state.saved.length, "video") },
        { tab: "notes", icon: "📝", label: "Notes", note: plural(notes, "note") },
        { tab: "topics", icon: "📚", label: "Topics", note: plural(state.topics.length, "topic") },
        { tab: "playlists", icon: "🎵", label: "Playlists", note: plural(state.playlists.length, "playlist") },
        { tab: "history", icon: "🕘", label: "History", note: `${state.hist.length.toLocaleString()} watched` },
        { tab: "hidden", icon: "🚫", label: "Hidden", note: plural(state.hidden.length, "channel") },
      ],
    },
    {
      title: "Discover",
      rows: [
        {
          tab: "channels",
          icon: "📺",
          label: "Channels & pages",
          note: pages ? `${channels.toLocaleString()} channels · ${plural(pages, "page")}` : plural(channels, "channel"),
        },
        {
          tab: "sorting",
          icon: "🏷️",
          label: "Sorting",
          note: toCheck ? `${toCheck.toLocaleString()} to check` : "all sorted",
          warn: toCheck > 0,
        },
      ],
    },
    {
      title: "Your data",
      rows: [
        { tab: "activity", icon: "🧾", label: "Activity", note: today ? `${today} today` : "nothing today" },
        { tab: "sync", icon: "☁️", label: "Sync" },
        { tab: "backups", icon: "💾", label: "Backups" },
        { tab: "api", icon: "🔑", label: "API usage" },
      ],
    },
    { title: "App", rows: [{ tab: "about", icon: "ℹ️", label: "About" }] },
  ];
}

function card(i: Item, open: (tab: string) => void) {
  const b = el("button", "mh-card");
  b.type = "button";
  b.dataset.p = i.tab;
  b.append(el("span", "mh-icon", i.icon), el("span", "mh-label", i.label));
  if (i.note) b.append(el("span", i.warn ? "mh-note warn" : "mh-note", i.note));
  b.onclick = () => open(i.tab);
  return b;
}

function row(i: Item, open: (tab: string) => void) {
  const b = el("button", "mh-row");
  b.type = "button";
  b.dataset.p = i.tab;
  b.append(el("span", "mh-icon", i.icon), el("span", "mh-label", i.label));
  if (i.note) b.append(el("span", i.warn ? "mh-note warn" : "mh-note", i.note));
  b.append(el("span", "mh-chev", "›"));
  b.onclick = () => open(i.tab);
  return b;
}

/** The section list beside the Menu page on wide screens. */
export function renderNav(nav: HTMLElement, current: string, open: (tab: string) => void) {
  nav.replaceChildren();
  for (const g of items()) {
    nav.append(el("div", "pn-h", g.title));
    for (const i of g.rows) {
      const b = el("button", `pn-item${i.tab === current ? " on" : ""}`);
      b.type = "button";
      b.append(el("span", "mh-icon", i.icon), el("span", "mh-label", i.label));
      if (i.tab === current) b.setAttribute("aria-current", "page");
      b.onclick = () => open(i.tab);
      nav.append(b);
    }
  }
}

export function renderHome(body: HTMLElement, open: (tab: string) => void) {
  body.classList.add("mh");
  body.append(cloudLine());
  for (const g of items()) {
    const sec = el("section", "mh-sec");
    sec.append(el("h3", "mh-title", g.title));
    const wrap = el("div", g.cards ? "mh-grid" : "mh-list");
    for (const i of g.rows) wrap.append(g.cards ? card(i, open) : row(i, open));
    sec.append(wrap);
    body.append(sec);
  }
}
