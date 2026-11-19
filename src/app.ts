/** What the feature modules (explore, similar) can ask the main app to do. */
import type { Dataset, Short } from "./types";

export interface ExternalChannelInfo {
  id: string; name: string; handle: string; thumb: string; subs: number; suggestedCat?: string;
}

export interface AppApi {
  ds: Dataset;
  toast(msg: string, action?: { label: string; run: () => void }): void;
  ago(sec: number): string;
  fmt(n: number): string;
  thumb(img: HTMLImageElement, id: string): void;
  /** Full-screen page over the feed (channel page, More like this). */
  openPage(title: string, render: (body: HTMLElement) => void): void;
  closePage(): void;
  /** Swipe through a list of Shorts; "← Back" returns to the main feed and then calls onBack. */
  playList(title: string, items: Short[], start: number, onBack?: () => void): void;
  /** Index in ds.channels for a channel (adds a temporary "external" entry if it isn't in your list). */
  ensureChannel(info: ExternalChannelInfo): number;
  onFeedChange(): void;
}
