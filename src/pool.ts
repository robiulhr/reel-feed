/**
 * A small pool of YouTube players so swiping feels instant:
 * the next Short is loaded (muted, paused on its first frame) while you watch the current one,
 * and the previous one is kept for swiping back. Only the active player is visible and audible.
 *
 * Uses the official YouTube IFrame Player API.
 */

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

  constructor(private container: HTMLElement, private ev: PoolEvents, size: number) {
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

  get size() { return this.slots.length; }

  private makeSlot(i: number): Slot {
    const el = document.createElement("div");
    el.className = "yt-slot";
    const inner = document.createElement("div");
    inner.id = `yt-slot-${i}-${Math.random().toString(36).slice(2, 7)}`;
    el.append(inner);
    this.container.append(el);
    const slot: Slot = { el, player: null, ready: Promise.resolve(), id: null, primed: false, preloading: false, failed: null, used: 0 };
    slot.ready = loadApi().then((YT) => new Promise<void>((resolve) => {
      this.YT = YT;
      slot.player = new YT.Player(inner.id, {
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 0, mute: 1, playsinline: 1, controls: 0, rel: 0,
          modestbranding: 1, iv_load_policy: 3, fs: 0, disablekb: 1,
        },
        events: {
          onReady: () => resolve(),
          onStateChange: (e: any) => this.onState(slot, e.data),
          onError: (e: any) => this.onError(slot, e.data),
        },
      });
    }));
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
    if (state === S.PLAYING) this.ev.onPlaying();
    else if (state === S.PAUSED) this.ev.onPaused();
    else if (state === S.BUFFERING) this.ev.onBuffering();
    else if (state === S.ENDED) this.ev.onEnded();
  }

  private onError(slot: Slot, code: number) {
    if (slot === this.active) this.ev.onError(code);
    else { slot.failed = code; slot.preloading = false; }
  }

  private pick(exclude: Slot[]): Slot {
    return [...this.slots].filter((s) => !exclude.includes(s)).sort((a, b) => a.used - b.used)[0] ?? this.slots[0];
  }

  /** Is this Short already loaded and waiting on its first frame? */
  isPrimed(id: string) {
    return this.slots.some((s) => s.id === id && s.primed);
  }

  /** Make `id` the visible, playing video. Instant if it was preloaded. */
  async show(id: string, muted: boolean) {
    let slot = this.slots.find((s) => s.id === id && s.failed === null);
    const failed = this.slots.find((s) => s.id === id && s.failed !== null);
    if (failed) { this.ev.onError(failed.failed!); return; }
    const prev = this.active;
    if (!slot) slot = this.pick(prev ? [prev] : []);
    this.active = slot;
    slot.used = performance.now();
    for (const s of this.slots) s.el.classList.toggle("on", s === slot);
    if (prev && prev !== slot) prev.player?.pauseVideo?.();

    await slot.ready;
    if (this.active !== slot) return; // swiped again meanwhile
    if (muted) slot.player.mute(); else slot.player.unMute();
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
    if (!id || this.slots.length < 2) return;
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

  private get p() { return this.active?.player; }
  play() { this.p?.playVideo?.(); }
  pause() { this.p?.pauseVideo?.(); }
  mute() { this.p?.mute?.(); }
  unMute() { this.p?.unMute?.(); }
  restart() { this.p?.seekTo?.(0, true); this.p?.playVideo?.(); }
  time(): number { return this.p?.getCurrentTime?.() ?? 0; }
  duration(): number { return this.p?.getDuration?.() ?? 0; }
}
