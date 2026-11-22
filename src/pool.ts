/**
 * A small pool of YouTube players so swiping feels instant:
 * the next Short is loaded (muted, paused on its first frame) while you watch the current one,
 * and the previous one is kept for swiping back. Only the active player is visible and audible.
 *
 * Uses the official YouTube IFrame Player API. Facebook videos you added play in a separate
 * Facebook player (fbplayer.ts); the same controls drive whichever one is on screen.
 */
import { FbPlayer } from "./fbplayer";

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<any> | null = null;
export function loadApi(): Promise<any> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    document.head.appendChild(s);
  });
  return apiPromise;
}

export interface PoolEvents {
  onPlaying(): void;
  onPaused(): void;
  onBuffering(): void;
  onEnded(): void;
  onError(code: number): void;
}

interface Slot {
  el: HTMLDivElement;
  player: any;
  ready: Promise<void>;
  id: string | null;
  primed: boolean; // first frame loaded and paused (instant start)
  preloading: boolean;
  failed: number | null; // error code while preloading
  used: number; // for least-recently-used
}

export class PlayerPool {
  private slots: Slot[] = [];
  private active: Slot | null = null;
  private YT: any = null;
  private fbp: FbPlayer | null = null;
  /** A Facebook video is on screen (controls go to the Facebook player). */
  private get fb(): FbPlayer | null {
    return this.fbp?.active ? this.fbp : null;
  }

  constructor(
    private container: HTMLElement,
    private ev: PoolEvents,
    size: number,
  ) {
    for (let i = 0; i < size; i++) this.slots.push(this.makeSlot(i));
  }

  /** Fewer players on slow connections (less data, less memory). */
  resize(size: number) {
    size = Math.max(1, size);
    while (this.slots.length > size) {
      const s = this.slots.find((x) => x !== this.active)!;
      s.player?.destroy?.();
      s.el.remove();
      this.slots.splice(this.slots.indexOf(s), 1);
    }
    while (this.slots.length < size) this.slots.push(this.makeSlot(this.slots.length));
  }

  get size() {
    return this.slots.length;
  }

  private makeSlot(i: number): Slot {
    const el = document.createElement("div");
    el.className = "yt-slot";
    const inner = document.createElement("div");
    inner.id = `yt-slot-${i}-${Math.random().toString(36).slice(2, 7)}`;
    el.append(inner);
    this.container.append(el);
    const slot: Slot = { el, player: null, ready: Promise.resolve(), id: null, primed: false, preloading: false, failed: null, used: 0 };
    slot.ready = loadApi().then(
      (YT) =>
        new Promise<void>((resolve) => {
          this.YT = YT;
          slot.player = new YT.Player(inner.id, {
            width: "100%",
            height: "100%",
            playerVars: {
              autoplay: 0,
              mute: 1,
              playsinline: 1,
              controls: 0,
              rel: 0,
              modestbranding: 1,
              iv_load_policy: 3,
              fs: 0,
              disablekb: 1,
            },
            events: {
              onReady: () => {
                slot.player?.getIframe?.()?.setAttribute("title", "Short video player");
                resolve();
              },
              onStateChange: (e: any) => this.onState(slot, e.data),
              onError: (e: any) => this.onError(slot, e.data),
            },
          });
        }),
    );
    return slot;
  }

  private onState(slot: Slot, state: number) {
    const S = this.YT?.PlayerState ?? { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3 };
    if (slot !== this.active) {
      // Preloading: as soon as it starts, stop on the first frame — it's now ready to start instantly.
      if (slot.preloading && state === S.PLAYING) {
        slot.player.pauseVideo();
        slot.player.seekTo(0, true);
        slot.primed = true;
        slot.preloading = false;
      }
      return;
    }
    if (state === S.PLAYING) {
      // each video starts at normal speed in YouTube's player — keep your chosen speed
      if (slot.player.getPlaybackRate?.() !== this.rate) slot.player.setPlaybackRate?.(this.rate);
      if (slot.player.getVolume?.() !== this.volume) slot.player.setVolume?.(this.volume);
      this.ev.onPlaying();
    } else if (state === S.PAUSED) this.ev.onPaused();
    else if (state === S.BUFFERING) this.ev.onBuffering();
    else if (state === S.ENDED) this.ev.onEnded();
  }

  private onError(slot: Slot, code: number) {
    if (slot === this.active) this.ev.onError(code);
    else {
      slot.failed = code;
      slot.preloading = false;
    }
  }

  private pick(exclude: Slot[]): Slot {
    return [...this.slots].filter((s) => !exclude.includes(s)).sort((a, b) => a.used - b.used)[0] ?? this.slots[0];
  }

  /** Is this Short already loaded and waiting on its first frame? */
  isPrimed(id: string) {
    return this.slots.some((s) => s.id === id && s.primed);
  }

  /** Make `id` the visible, playing video. Instant if it was preloaded. */
  async show(id: string, muted: boolean, fbUrl?: string) {
    if (fbUrl) {
      for (const s of this.slots) s.el.classList.remove("on");
      this.active?.player?.pauseVideo?.();
      this.active = null;
      this.fbp ??= new FbPlayer(this.container, this.ev);
      this.fbp.setVolume(this.volume);
      return this.fbp.show(fbUrl, muted);
    }
    this.fbp?.hide();
    let slot = this.slots.find((s) => s.id === id && s.failed === null);
    const failed = this.slots.find((s) => s.id === id && s.failed !== null);
    if (failed) {
      this.ev.onError(failed.failed!);
      return;
    }
    const prev = this.active;
    if (!slot) slot = this.pick(prev ? [prev] : []);
    this.active = slot;
    slot.used = performance.now();
    for (const s of this.slots) s.el.classList.toggle("on", s === slot);
    if (prev && prev !== slot) prev.player?.pauseVideo?.();

    await slot.ready;
    if (this.active !== slot) return; // swiped again meanwhile
    if (muted) slot.player.mute();
    else slot.player.unMute();
    slot.player.setVolume?.(this.volume);
    if (slot.id === id) {
      // already loaded here (preloaded, or the one you just swiped away from) — start instantly
      slot.preloading = false;
      slot.player.seekTo(0, true);
      slot.player.playVideo();
    } else {
      slot.id = id;
      slot.primed = false;
      slot.failed = null;
      slot.player.loadVideoById(id);
    }
  }

  /** Quietly load a Short in a spare player so it can start instantly later. */
  async preload(id: string | undefined) {
    if (!id || id.startsWith("fb") || this.slots.length < 2) return;
    if (this.slots.some((s) => s.id === id)) return;
    const slot = this.pick(this.active ? [this.active] : []);
    if (slot === this.active) return;
    slot.used = performance.now() - 1; // keep it until used
    slot.id = id;
    slot.primed = false;
    slot.failed = null;
    slot.preloading = true;
    await slot.ready;
    if (slot.id !== id || slot === this.active) return;
    slot.player.mute();
    slot.player.loadVideoById(id);
  }

  private get p() {
    return this.active?.player;
  }
  private rate = 1;
  private volume = 100;
  /** Volume 0–100 for the current and following videos. */
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    this.fbp?.setVolume(this.volume);
    this.p?.setVolume?.(this.volume);
  }
  /** Jump to a time (seconds) in the current video. */
  seek(t: number) {
    if (this.fb) return this.fb.seek(t);
    const d = this.duration();
    this.p?.seekTo?.(Math.max(0, d ? Math.min(t, d - 0.3) : t), true);
  }
  /** Playback speed for the current and following videos (0.25–2). */
  setRate(r: number) {
    this.rate = r;
    this.p?.setPlaybackRate?.(r);
  }
  play() {
    if (this.fb) return this.fb.play();
    this.p?.playVideo?.();
  }
  pause() {
    if (this.fb) return this.fb.pause();
    this.p?.pauseVideo?.();
  }
  mute() {
    if (this.fb) return this.fb.mute();
    this.p?.mute?.();
  }
  unMute() {
    if (this.fb) return this.fb.unMute();
    this.p?.unMute?.();
  }
  restart() {
    if (this.fb) {
      this.fb.seek(0);
      return this.fb.play();
    }
    this.p?.seekTo?.(0, true);
    this.p?.playVideo?.();
  }
  time(): number {
    if (this.fb) return this.fb.time();
    return this.p?.getCurrentTime?.() ?? 0;
  }
  duration(): number {
    if (this.fb) return this.fb.duration();
    return this.p?.getDuration?.() ?? 0;
  }
}
