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
      this.player.seek(0);
      this.play();
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
      // Not started yet: try once more (muted — browsers always allow that); still nothing → tell the app
      // (it offers Facebook) instead of spinning forever
      const retry = window.setTimeout(() => {
        if (!this.active || n !== this.n || this.started) return;
        p.mute();
        p.play();
      }, 5000);
      const stall = window.setTimeout(() => {
        if (this.active && n === this.n && !this.started) this.ev.onError(-4);
      }, 12000);
      this.subs.push({
        release: () => {
          clearTimeout(retry);
          clearTimeout(stall);
        },
      });
      on("startedPlaying", () => {
        this.started = true;
        this.ev.onPlaying();
        // it (re)started muted; now the sound, if you have it on
        if (this.soundPending && !this.muted) this.soundOn();
        this.soundPending = false;
      });
      on("paused", () => {
        // the browser stopped it because of the sound (no tap on the page yet): play on, muted
        if (!this.muted && performance.now() - this.soundAt < 2500 && performance.now() - this.pausedAt > 1000) {
          this.muted = true;
          p.mute();
          p.play();
          this.ev.onSoundBlocked?.();
          this.offerTapInside();
          return;
        }
        this.ev.onPaused();
      });
      on("startedBuffering", () => this.ev.onBuffering());
      // Facebook says when buffering ends (YouTube says "playing" again): take the spinner away
      on("finishedBuffering", () => this.started && this.ev.onPlaying());
      on("finishedPlaying", () => this.ev.onEnded());
      on("error", () => this.ev.onError(-2));
      if (!this.active) return;
      this.play();
    });
    FB.XFBML.parse(wrap);
  }

  // ---- sound that only a tap inside Facebook's own player can unlock (Android Chrome) ----
  private unlocking = false;
  private unlockTimers: number[] = [];
  private onWindowBlur: (() => void) | null = null;
  private hint: HTMLElement | null = null;

  /**
   * The browser said no to sound that came from the app (a tap on the app doesn't count for Facebook's frame).
   * So for a while the taps go straight to Facebook's player; a tap there is allowed to turn sound on, and the
   * moment the page sees one (the frame takes focus) the sound is asked for again. Stops by itself.
   */
  private offerTapInside() {
    if (this.unlocking || !this.player) return;
    this.unlocking = true;
    this.el.classList.add("unlock");
    this.ev.onTapThrough?.(true);
    const hint = document.createElement("div");
    hint.className = "fb-hint";
    hint.textContent = "🔇 Tap the video for sound";
    this.el.append(hint);
    this.hint = hint;
    this.onWindowBlur = () => {
      if (document.activeElement?.tagName !== "IFRAME") return;
      // the tap went into Facebook's frame: that is the permission, ask for the sound now
      this.unlockTimers.push(
        window.setTimeout(() => {
          if (!this.unlocking) return;
          this.muted = false;
          this.soundOn();
        }, 80),
      );
    };
    window.addEventListener("blur", this.onWindowBlur);
    this.unlockTimers.push(
      window.setInterval(() => {
        if (this.player?.isMuted?.() === false && this.started) this.endUnlock(true);
      }, 500),
      window.setTimeout(() => this.endUnlock(false), 25000),
    );
  }

  private endUnlock(ok: boolean) {
    if (!this.unlocking) return;
    this.unlocking = false;
    for (const t of this.unlockTimers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.unlockTimers = [];
    if (this.onWindowBlur) window.removeEventListener("blur", this.onWindowBlur);
    this.onWindowBlur = null;
    this.hint?.remove();
    this.hint = null;
    this.el.classList.remove("unlock");
    this.ev.onTapThrough?.(false);
    if (ok) {
      this.muted = false;
      this.ev.onSoundUnlocked?.();
    }
  }

  /** Another video came on screen. */
  hide() {
    this.endUnlock(false);
    this.active = false;
    this.el.classList.remove("on");
    this.player?.pause?.();
  }

  private release() {
    this.endUnlock(false);
    for (const s of this.subs) s?.release?.();
    this.subs = [];
    this.player = null;
    this.el.replaceChildren();
  }

  private soundAt = 0; // when the sound was last turned on (a pause right after = the browser said no)
  private pausedAt = 0; // when the app last paused it itself

  private soundOn() {
    const p = this.player;
    if (!p) return;
    this.soundAt = performance.now();
    p.unmute();
    p.setVolume?.(this.volume / 100);
  }

  private applySound() {
    if (this.muted) this.player?.mute();
    else this.soundOn();
  }

  private soundPending = false;

  /** Start (or go on) muted — browsers don't always let a frame start with sound — and turn the
   *  sound back on once it's playing. */
  play() {
    const p = this.player;
    if (!p) return;
    if (!this.muted) {
      this.soundPending = true;
      p.mute();
    }
    p.play();
  }
  pause() {
    this.pausedAt = performance.now();
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
