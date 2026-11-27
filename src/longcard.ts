/**
 * One long video as a card: thumbnail, length, title, and a line with the channel (its own button, opens the
 * channel in the app), views and age. The card itself is not a button: tapping the picture or title opens the
 * video, tapping the channel name opens the channel — two separate targets, as on YouTube.
 */
import { el } from "./dom";

export interface LongCardOpts {
  id: string;
  title: string;
  dur: string; // "12:34", or "" when unknown
  channel: string; // channel name, or "" for none
  rest: string; // "1.2K views · 3 days ago"
  thumb(img: HTMLImageElement, id: string): void;
  open(): void;
  openChannel?: () => void; // omitted when the channel is the page you are already on
  extraClass?: string;
}

export function longCardEl(o: LongCardOpts): HTMLElement {
  const card = el("div", `home-long-card${o.extraClass ? ` ${o.extraClass}` : ""}`);
  const main = el("button", "hl-main");
  main.type = "button";
  const box = el("span", "hl-thumb");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  o.thumb(img, o.id);
  box.append(img);
  if (o.dur) box.append(el("span", "hl-dur", o.dur));
  main.append(box, el("span", "hl-title", o.title));
  main.onclick = o.open;
  const meta = el("div", "hl-meta");
  if (o.channel) {
    if (o.openChannel) {
      const ch = el("button", "hl-ch", o.channel);
      ch.type = "button";
      ch.title = "Open the channel";
      ch.onclick = o.openChannel;
      meta.append(ch);
    } else meta.append(el("span", "", o.channel));
    meta.append(document.createTextNode(" · "));
  }
  meta.append(document.createTextNode(o.rest));
  card.append(main, meta);
  return card;
}
