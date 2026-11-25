/**
 * Entry point: wires the parts together and starts the app.
 *
 *   feed.ts       which Short is on screen, next/previous, temporary lists, newer data
 *   player.ts     the YouTube player pool, watch clock, data saver
 *   controls.ts   play/pause, skip, progress bar, speed, sound, save, share, refresh
 *   gestures.ts   swipe / tap / hold / wheel / keyboard on the video
 *   panels.ts     menu panel, pages, ⋯ sheet, tips, top bar
 *   settings.ts   About + Sync panels
 *   fullscreen.ts, network.ts, view.ts (page elements), dom.ts (helpers), a11y.ts (focus, labels)
 */
import "./style.css";
import { installErrorCatcher } from "./errors";
installErrorCatcher(); // first: anything that breaks from here on is caught and reported

import { loadApi } from "./pool";
import { onOtherTab, onSaveFailed, startVisit, state } from "./store";
import { initCloudDot, onConnectRequest } from "./cloud";
import { addLocalLog } from "./locallog";
import * as sync from "./sync";
import { dailyBackup } from "./backup";
import { initChannels } from "./channels";
import { checkForUpdate, loadInitial, onNetworkChange } from "./data";
import { toast } from "./ui";
import { warnIfTokenExpiring } from "./health";
import { btn, nowSec } from "./dom";
import { banner, els, showEmpty } from "./view";
import { pool } from "./player";
import {
  channelsCtx,
  feed,
  latestVersion,
  next,
  offerData,
  onFeedChange,
  playNow,
  refreshManual,
  renderSave,
  savedShort,
  setData,
  updatePeeks,
} from "./feed";
import { initControls, renderMute } from "./controls";
import { initGestures } from "./gestures";
import { initFullscreen } from "./fullscreen";
import { currentPanelTab, initPanels, openPanel, renderControls, renderPanel, showTipsIfNew } from "./panels";
import { applyNetwork } from "./network";
import { applyCurrent, go, startRouter } from "./router";
import { initHome, openOn, showHome } from "./home";
import { playLinked, showRoute } from "./routes";
import { startExtBridge } from "./extbridge";
import { openBulkAdd } from "./manual"; // Facebook videos you added: the Add dialog, the Added page, a page's screen

/** Background sync brought changes from another device. */
function onSyncUpdate() {
  refreshManual();
  renderSave();
  onFeedChange();
  // Don't rebuild the Channels/History panels on background syncs — it would wipe what you're typing.
  const tab = currentPanelTab();
  if (!els.panel.hidden && !["channels", "history"].includes(tab) && (tab !== "sync" || sync.isConnected())) renderPanel();
}

async function boot() {
  const addAtStart = addLinksOf(location.hash); // read before the router rewrites the address
  initControls();
  initGestures();
  initFullscreen();
  initPanels();
  initHome();
  renderControls();
  renderMute();
  startVisit(Math.floor(nowSec()));
  loadApi(); // start loading the YouTube player right away
  pool.setRate(state.rate ?? 1);
  pool.setVolume(state.volume ?? 100);
  sync.startSync(onSyncUpdate);
  onOtherTab(onSyncUpdate); // another Reel Feed tab saved something: show it here too
  // the device refused to save (storage full or blocked): say so instead of losing changes quietly
  onSaveFailed(() => {
    addLocalLog("system", false, "The browser refused to save your changes (its storage is full or blocked)");
    banner(
      "⚠️ This browser can't save your changes right now (its storage is full or blocked). Free some space or open Menu → Backups; changes since may be lost when you close the app.",
      () => banner(null),
    );
  });
  // where your data stands: a dot on the Menu button, and a warning if sync isn't connected when you change something
  onConnectRequest(() => openPanel("sync"));
  sync.onUnprotected(() =>
    // just after the normal confirmation ("Added ✓"), not instead of it
    window.setTimeout(() => toast("⚠️ Not backed up: sync isn't connected", { label: "Connect", run: () => openPanel("sync") }, 9000), 2800),
  );
  initCloudDot();
  const opened = startRouter(showRoute); // the address the app was opened on (shared link, refresh)
  let wantShort = opened.k === "feed" ? opened.v : undefined;
  onNetworkChange(() => applyNetwork());

  const t0 = performance.now();
  const first = await loadInitial(
    (full, sameVersion) => {
      // Full library arrived after the starter
      if (sameVersion) {
        setData(full, true);
        updatePeeks();
      } else offerData(full);
      // a linked Short that wasn't in the quick starter library
      if (wantShort && !playLinked(wantShort)) toast("That Short isn't in the library any more");
      wantShort = undefined;
    },
    (msg) => toast(msg),
  );
  if (!first) {
    showEmpty(
      navigator.onLine
        ? "Couldn't load Shorts — the connection is very weak.<br><br>"
        : "You're offline and nothing is saved on this device yet.<br>Connect once and the app will work offline afterwards.<br><br>",
    );
    // no inline onclick (blocked by the security policy) — a real listener instead
    els.empty.append(btn("Try again", () => location.reload(), "btn primary"));
    return;
  }
  setData(first.ds, false);
  initChannels(channelsCtx());
  const linked = !!wantShort;
  // the app opens on Home (or, by your choice on this device, straight into the Shorts feed); a link to one Short or
  // a hand-over from the browser extension always goes to the feed
  const startHome =
    !linked && !addAtStart.length && (opened.k === "home" || opened.k === "watch" || (opened.k === "feed" && openOn() === "home"));
  if (startHome) {
    if (opened.k !== "home" && opened.k !== "watch") go({ k: "home" }, { replace: true });
    showHome();
    if (opened.k === "watch") applyCurrent(); // a link to a long video: Home under it, the video on top
  } else if (wantShort && playLinked(wantShort)) wantShort = undefined;
  else {
    next();
    if (wantShort && first.source !== "starter") {
      toast("That Short isn't in the library any more");
      wantShort = undefined;
    }
  }
  document.documentElement.classList.remove("boot-home");
  if (opened.k !== "feed" && !startHome) applyCurrent(); // opened on a menu page / channel / More like this
  if (addAtStart.length) void openBulkAdd(addAtStart); // opened from the browser extension
  startExtBridge(); // tells the extension which Facebook videos you already have (and answers its hello)
  window.addEventListener("hashchange", openAddLink);
  console.info(`First video in ${Math.round(performance.now() - t0)} ms (from ${first.source})`);

  showTipsIfNew();
  window.setTimeout(() => void dailyBackup(), 30000); // after the first sync, so the backup has your latest data
  window.setTimeout(warnIfTokenExpiring, 5000); // early warning before the GitHub token expires
  applyNetwork();

  // Continue where you left off
  const last = state.hist[0];
  if (!linked && last && nowSec() - last.at < 24 * 3600 && last.f < 0.9 && last.id !== feed.cur?.id) {
    const s = savedShort(last.id);
    if (s) toast(`Continue “${s.t.slice(0, 40)}${s.t.length > 40 ? "…" : ""}”?`, { label: "Resume", run: () => playNow(s) }, 7000);
  }

  // Newer data? Check now (if we started from the saved copy), when you come back, and every 10 minutes.
  if (first.source === "saved") checkForUpdate(latestVersion(), offerData);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate(latestVersion(), offerData);
  });
  setInterval(() => {
    if (document.visibilityState === "visible") checkForUpdate(latestVersion(), offerData);
  }, 10 * 60_000);
}

/** "#add=id,id,…" (from the browser extension, or a shared link): add those Facebook videos. */
function addLinksOf(hash: string): string[] {
  const m = /^#add=(.+)$/.exec(hash);
  if (!m) return [];
  let raw = m[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  return raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((x) => (/^\d+$/.test(x) ? `https://www.facebook.com/reel/${x}/` : x))
    .filter((x) => /^https:\/\/([\w-]+\.)?(facebook\.com|fb\.watch)\//i.test(x));
}

/** The app is already open and the address changes to "#add=…". */
function openAddLink() {
  const links = addLinksOf(location.hash);
  if (!location.hash.startsWith("#add=")) return;
  history.replaceState(history.state, "", location.pathname + location.search);
  if (links.length) void openBulkAdd(links);
}

// Keep the app on the device (opens instantly, works offline). Only in the built site.
// Updates: check for a new app version when the app opens, when you come back to it, and every
// 30 minutes. When a new version takes over: reload right away if you just opened the app,
// otherwise show "New version — tap to update" (never interrupts a video by itself).
function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: "none" })
      .then((reg) => {
        const check = () => reg.update().catch(() => {});
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") check();
        });
        setInterval(check, 30 * 60_000);
      })
      .catch(() => {});
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return; // first install — nothing to update
    const reload = () => {
      reloading = true;
      location.reload();
    };
    if (performance.now() < 10_000) reload();
    else banner("🆕 New version of the app — tap to update", reload);
  });
}

registerServiceWorker();
boot();
