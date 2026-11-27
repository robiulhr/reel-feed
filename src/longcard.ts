/**
 * One long video as a card, laid out like YouTube's: the thumbnail (with its length), and under it the
 * channel picture beside the title and a line with the channel name, views and age. The card itself is not
 * a button: the picture and the title open the video; the channel picture and name open the channel in
 * the app — separate targets, so neither steals the other's tap.
 */
import { el } from "./dom";

export interface LongCardOpts {
  id: string;
  title: string;
  dur: string; // "12:34", or "" when unknown
  channel: string; // channel name, or "" for none
  avatar?: string; // channel picture URL
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
  main.setAttribute("aria-label", [o.dur, o.title].filter(Boolean).join(", "));
  const box = el("span", "hl-thumb");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  o.thumb(img, o.id);
  box.append(img);
  if (o.dur) box.append(el("span", "hl-dur", o.dur));
  main.append(box);
  main.onclick = o.open;

  const info = el("div", "hl-info");
  if (o.channel) {
    const face = el(o.openChannel ? "button" : "span", "hl-avatar");
    if (face instanceof HTMLButtonElement) {
      face.type = "button";
      face.tabIndex = -1; // the name next to it is the keyboard stop for the channel
      face.setAttribute("aria-hidden", "true");
      face.onclick = o.openChannel ?? null;
    }
    if (o.avatar) {
      const pic = el("img");
      pic.alt = "";
      pic.loading = "lazy";
      pic.referrerPolicy = "no-referrer";
      pic.src = o.avatar;
      face.append(pic);
    } else face.textContent = o.channel.trim().charAt(0).toUpperCase();
    info.append(face);
  }
  const txt = el("div", "hl-txt");
  const title = el("button", "hl-title", o.title);
  title.type = "button";
  title.onclick = o.open;
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
  txt.append(title, meta);
  info.append(txt);
  card.append(main, info);
  return card;
}
