/**
 * What each address shows (router.ts keeps the address and Back in step; this makes the screen match).
 * Runs when Back/Forward moves to another address, and once at start-up for the address the app was
 * opened on (a shared link, a refresh on /saved, …).
 */
import { openChannel } from "./explore";
import { isHome, openLongById, openShortsFeed, showHome } from "./home";
import { openSimilar } from "./similar";
import { app, exitList, exitListQuiet, feed, playNow, savedShort } from "./feed";
import { closePage, closePanel, currentPanelTab, openPanel, panelOpen, shownPagePath } from "./panels";
import { type Route, setFeed, toPath } from "./router";
import { toast } from "./ui";

export function showRoute(r: Route, e: { list?: boolean }) {
  // the long-video page is open and the address moved elsewhere (Back): close it
  const w = document.getElementById("watch");
  if (w && !w.hidden && (r.k !== "watch" || w.dataset.vid !== r.v)) {
    if (r.k !== "watch") void import("./watch").then((m) => m.hideWatch());
  }
  if (r.k === "watch") {
    if (!isHome()) {
      closePage();
      closePanel();
      showHome();
    }
    if (!(w && !w.hidden && w.dataset.vid === r.v)) void openLongById(r.v);
    return;
  }

  // Left a list (a channel's Shorts, History, …): the screen it came from comes back below.
  if (!e.list && feed.ctx) {
    if (r.k === "home")
      exitListQuiet(); // nothing may start playing behind Home
    else exitList(false);
  }

  if (r.k === "home") {
    closePage();
    closePanel();
    showHome();
    return;
  }
  if (r.k === "feed") {
    closePage();
    closePanel();
    if (isHome()) openShortsFeed(); // Back/Forward from Home to the feed: the feed carries on where it was
    setFeed(feed.cur?.id);
    return;
  }
  if (r.k === "panel") {
    if (!panelOpen() || currentPanelTab() !== r.tab) openPanel(r.tab);
    else closePage();
    return;
  }
  if (shownPagePath() === toPath(r)) return; // already showing
  if (r.k === "channel") {
    const h = r.h.toLowerCase();
    const i = feed.ds.channels.findIndex((c) => c.h.toLowerCase().replace(/^@/, "") === h || c.id === r.h);
    if (i >= 0) return openChannel(app, { chIndex: i });
    toast("That channel isn't in the list");
  } else {
    const s = feed.byId.get(r.id) ?? savedShort(r.id);
    if (s) return openSimilar(app, s);
    toast("That Short isn't in the library");
  }
  closePage();
  closePanel();
  setFeed(feed.cur?.id);
}

/**
 * Opened from a link to one Short (/v/ID): play it first, then the feed carries on.
 * Returns false if it isn't in this library (yet — the full library may still be loading).
 */
export function playLinked(id: string): boolean {
  const s = feed.byId.get(id) ?? savedShort(id);
  if (!s) return false;
  if (feed.cur?.id !== s.id) playNow(s);
  return true;
}
