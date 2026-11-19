/* Thin wrapper around the official YouTube IFrame Player API. */

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<any> | null = null;

function loadApi(): Promise<any> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return apiPromise;
}

export interface PlayerEvents {
  onPlaying(): void;
  onPaused(): void;
  onEnded(): void;
  onError(code: number): void;
}

export class ShortsPlayer {
  private p: any = null;
  private ready: Promise<void>;

  constructor(elementId: string, ev: PlayerEvents) {
    this.ready = loadApi().then(
      (YT) =>
        new Promise<void>((resolve) => {
          this.p = new YT.Player(elementId, {
            width: "100%",
            height: "100%",
            playerVars: {
              autoplay: 1, mute: 1, playsinline: 1, controls: 0, rel: 0,
              modestbranding: 1, iv_load_policy: 3, fs: 0, disablekb: 1,
            },
            events: {
              onReady: () => resolve(),
              onStateChange: (e: any) => {
                const S = YT.PlayerState;
                if (e.data === S.PLAYING) ev.onPlaying();
                else if (e.data === S.PAUSED) ev.onPaused();
                else if (e.data === S.ENDED) ev.onEnded();
              },
              onError: (e: any) => ev.onError(e.data),
            },
          });
        }),
    );
  }

  async load(id: string, muted: boolean) {
    await this.ready;
    if (muted) this.p.mute();
    else this.p.unMute();
    this.p.loadVideoById(id);
  }

  play() { this.p?.playVideo(); }
  pause() { this.p?.pauseVideo(); }
  mute() { this.p?.mute(); }
  unMute() { this.p?.unMute(); }
  restart() { this.p?.seekTo(0, true); this.p?.playVideo(); }
  time(): number { return this.p?.getCurrentTime?.() ?? 0; }
  duration(): number { return this.p?.getDuration?.() ?? 0; }
}
