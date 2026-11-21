/**
 * The video players (a pool of YouTube players so the next Short is ready before you swipe),
 * the "how long did you watch" clock used for learning, and data saver.
 */
import { PlayerPool } from "./pool";
import { state } from "./store";
import { isSlowNetwork } from "./data";
import { els, showSpinner } from "./view";
import { nowSec } from "./dom";

export const playback = {
  playing: false,
  /** How the current Short was watched (turned into a learning signal when you move on). */
  watch: { playMs: 0, since: 0, maxT: 0, loops: 0, shownAt: 0, skipped: 0 },
  /** Smaller thumbnails and less preloading on slow connections. */
  dataSaver: false,
};

export function resetWatch() {
  playback.playing = false;
  playback.watch = { playMs: 0, since: 0, maxT: 0, loops: 0, shownAt: nowSec(), skipped: 0 };
}

export function computeDataSaver() {
  return state.dataSaver === "on" || (state.dataSaver === "auto" && isSlowNetwork());
}
export function poolSize() {
  const c = (navigator as any).connection;
  if (playback.dataSaver && c && ["slow-2g", "2g"].includes(c.effectiveType)) return 1; // no preloading at all
  return playback.dataSaver ? 2 : 3;
}

/** Filled in by the feed: what to do when a video can't play (skip it) and when it starts. */
export const playerHooks = { onUnplayable: (_code: number) => {}, onPlaying: () => {} };

export function stopClock() {
  const w = playback.watch;
  if (playback.playing && w.since) w.playMs += performance.now() - w.since;
  w.since = 0;
}

playback.dataSaver = computeDataSaver();
export const pool = new PlayerPool(
  els.players,
  {
    onPlaying() {
      playback.playing = true;
      playback.watch.since = performance.now();
      els.poster.classList.add("gone");
      els.centerIcon.className = "center-icon";
      showSpinner(false);
      playerHooks.onPlaying();
    },
    onPaused() {
      stopClock();
      playback.playing = false;
    },
    onBuffering() {
      showSpinner(true);
    },
    onEnded() {
      // Loop like Shorts do. A replay is a strong "I like this" signal.
      stopClock();
      playback.watch.loops++;
      playback.watch.maxT = pool.duration();
      pool.restart();
    },
    onError(code) {
      playerHooks.onUnplayable(code);
    },
  },
  poolSize(),
);
