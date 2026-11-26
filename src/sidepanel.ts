/**
 * Wide screens only (≥900px): the panel beside the Shorts video — details, your note, More like this, Up next.
 * Loaded only when the screen is that wide. On a phone these things live behind ⋯ and the note chip.
 */
import { catInfo } from "./categories";
import { noteCurrent } from "./controls";
import { ago, btn, compact, el } from "./dom";
import { app, exploreCurrent, feed, playList, playNow, sideHook } from "./feed";
import { videoCats } from "./rank";
import { similarInLibrary } from "./similar";
import { noteOf, state } from "./store";
import type { Short } from "./types";
import { thumb } from "./view";

const panel = document.getElementById("sidePanel") as HTMLElement;

function strip(items: Short[], open: (s: Short, i: number) => void): HTMLElement {
  const row = el("div", "sp-strip");
  items.forEach((s, i) => {
    const b = el("button", "sp-card");
    b.type = "button";
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    thumb(img, s.id);
    b.append(img, el("span", "sp-card-t", s.t));
    b.onclick = () => open(s, i);
    row.append(b);
  });
  return row;
}

function card(title: string, ...body: HTMLElement[]): HTMLElement {
  const c = el("section", "sp-card-box");
  c.append(el("h2", "sp-h", title), ...body);
  return c;
}

let timer = 0;
function draw() {
  clearTimeout(timer);
  timer = window.setTimeout(paint, 0); // never slow down the video that is starting
}

function paint() {
  const s = feed.cur;
  if (!s) return void panel.replaceChildren();
  const ch = feed.ds.channels[s.ch];
  const parts: HTMLElement[] = [];

  const details = el("div", "sp-details");
  const who = btn(ch?.n ?? "Channel", () => exploreCurrent(), "sp-who");
  who.title = "Explore this channel";
  const bits = s.fb
    ? ["Facebook", `added ${ago(s.p)}`]
    : [`${compact(s.v)} views`, `${compact(s.l)} likes`, `${compact(s.c)} comments`, ago(s.p)];
  const cats = videoCats(s, state).map((c) => catInfo(c)?.short ?? c);
  details.append(el("div", "sp-title", s.t), who, el("div", "sp-meta", bits.join(" · ")));
  if (cats.length) details.append(el("div", "sp-meta", cats.join(" / ")));
  parts.push(card("Details", details));

  const note = noteOf(s.id).trim();
  const noteBox = el("div");
  noteBox.append(
    el("p", "sp-note", note || "No note yet."),
    btn(note ? "✎ Edit note" : "＋ Add note", () => void noteCurrent()),
  );
  parts.push(card("Your note", noteBox));

  const like = similarInLibrary(app, s, 8).map((r) => r.short);
  if (like.length) {
    parts.push(
      card(
        "More like this",
        strip(like, (_, i) => playList("More like this", [s, ...like], i + 1)),
      ),
    );
  }
  const up = feed.queue.slice(0, 6);
  if (up.length) {
    parts.push(
      card(
        "Up next",
        strip(up, (x) => playNow(x)),
      ),
    );
  }
  panel.replaceChildren(...parts);
}

sideHook.refresh = draw;
draw();
