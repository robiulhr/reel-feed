/**
 * The player for Facebook videos you added: Facebook's embedded video player (its JavaScript SDK),
 * driven by the app's own controls — tap to pause, swipe, sound, the progress bar — like a Short.
 * One player: a Facebook video loads when it comes on screen (no preloading).
 * The SDK is only downloaded the first time a Facebook video plays.
 */
import type { PoolEvents } from "./pool";

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

/** Ready players, by the id of the element they were made in. */
const waiting = new Map<string, (player: any) => void>();
let sdk: Promise<any> | null = null;
export function loadFbSdk(): Promise<any> {
  sdk ??= new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      const FB = window.FB;
      FB.init({ xfbml: false, version: "v21.0" });
      FB.Event.subscribe("xfbml.ready", (msg: any) => {
        if (msg.type === "video") waiting.get(msg.id)?.(msg.instance);
      });
      resolve(FB);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      sdk = null; // try again next time
      reject(new Error("Facebook's player didn't load"));
    };
    document.head.append(s);
  });
  return sdk;
}

export class FbPlayer {
  readonly el = document.createElement("div");
  private player: any = null;
  private url = "";
  private n = 0;
  private subs: { release?: () => void }[] = [];
  private volume = 100;
  private muted = true;
  private started = false;
  active = false;

  constructor(
    container: HTMLElement,
    private ev: PoolEvents,
  ) {
    this.el.className = "fb-slot";
    container.append(this.el);
  }

  /** Make this Facebook video the one on screen and start it. */
  async show(url: string, muted: boolean) {
    this.active = true;
    this.muted = muted;
    this.el.classList.add("on");
    if (url === this.url && this.player) {
      this.applySound();
      this.player.seek(0);
      this.player.play();
      return;
    }
    const n = ++this.n;
    this.release();
    this.url = url;
    this.started = false;
    let FB: any;
    try {
      FB = await loadFbSdk();
    } catch {
      if (n === this.n && this.active) this.ev.onError(-1);
      return;
    }
    if (n !== this.n) return; // another video came on meanwhile
    const id = `fbv-${n}`;
    const w = Math.round(Math.min(this.el.clientWidth || 360, (this.el.clientHeight || 640) * (9 / 16)));
    const box = document.createElement("div");
    box.className = "fb-video";
    box.id = id;
    Object.assign(box.dataset, {
      href: url,
      width: String(Math.max(220, w)),
      showText: "false",
      autoplay: "false",
      allowfullscreen: "false",
    });
    const wrap = document.createElement("div");
    wrap.className = "fb-wrap";
    wrap.append(box);
    this.el.replaceChildren(wrap);
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      if (n === this.n && this.active && !this.player) this.ev.onError(-3);
    }, 15000);
    // Facebook's frame comes without permission to play by itself: phones then won't start it (or stop
    // it when the sound goes on) unless you tap inside it. Give it that permission before it loads.
    const watch = new MutationObserver(() => {
      const f = wrap.querySelector("iframe");
      if (!f) return;
      watch.disconnect();
      if (!/\bautoplay\b/.test(f.getAttribute("allow") ?? "")) {
        f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
        if (f.src) f.setAttribute("src", f.src); // load again with the permission
      }
    });
    watch.observe(wrap, { childList: true, subtree: true });
    waiting.set(id, (p) => {
      clearTimeout(timer);
      waiting.delete(id);
      watch.disconnect();
      if (n !== this.n) return;
      this.player = p;
      p.getIframe?.()?.setAttribute?.("title", "Facebook video player");
      const on = (name: string, fn: () => void) => this.subs.push(p.subscribe(name, () => this.active && n === this.n && fn()));
      // it said it would play but never started: tell the app (it offers Facebook) instead of spinning forever
      const stall = window.setTimeout(() => {
        if (this.active && n === this.n && !this.started) this.ev.onError(-4);
      }, 12000);
      this.subs.push({ release: () => clearTimeout(stall) });
      on("startedPlaying", () => {
        this.started = true;
        this.ev.onPlaying();
      });
      on("paused", () => this.ev.onPaused());
      on("startedBuffering", () => this.ev.onBuffering());
      // Facebook says when buffering ends (YouTube says "playing" again): take the spinner away
      on("finishedBuffering", () => this.started && this.ev.onPlaying());
      on("finishedPlaying", () => this.ev.onEnded());
      on("error", () => this.ev.onError(-2));
      if (!this.active) return;
      this.applySound();
      p.play();
    });
    FB.XFBML.parse(wrap);
  }

  /** Another video came on screen. */
  hide() {
    this.active = false;
    this.el.classList.remove("on");
    this.player?.pause?.();
  }

  private release() {
    for (const s of this.subs) s?.release?.();
    this.subs = [];
    this.player = null;
    this.el.replaceChildren();
  }

  private applySound() {
    const p = this.player;
    if (!p) return;
    if (this.muted) p.mute();
    else {
      p.unmute();
      p.setVolume?.(this.volume / 100);
    }
  }

  play() {
    this.player?.play();
  }
  pause() {
    this.player?.pause();
  }
  mute() {
    this.muted = true;
    this.player?.mute();
  }
  unMute() {
    this.muted = false;
    this.applySound();
  }
  setVolume(v: number) {
    this.volume = v;
    if (!this.muted) this.player?.setVolume?.(v / 100);
  }
  seek(t: number) {
    this.player?.seek(Math.max(0, t));
  }
  time(): number {
    return this.player?.getCurrentPosition?.() ?? 0;
  }
  duration(): number {
    return this.player?.getDuration?.() ?? 0;
  }
}
