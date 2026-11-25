/**
 * The long-video player page (opened from a card on Home). A 16:9 YouTube player, with
 *  - resume: it starts where you stopped (kept on this device),
 *  - speed 1× / 1.25× / 1.5× / 2× (remembered),
 *  - "Note at 12:34": your note on the video with the time written in; times in the note are tappable,
 *  - ⏮ ⏭ that follow the list it was opened from, an "Up next" card, and Related videos (same topic).
 * When a video ends it stops (or plays the next one, if you switch "Play next automatically" on).
 * It sits over Home, so Back (or Home) returns to Home exactly where you left it.
 * Loaded only when a long video is opened (its own small file).
 */
import { ago, btn, compact, el } from "./dom";
import { lengthLabel } from "./home";
import { loadApi } from "./pool";
import { dismiss, pushLayer } from "./router";
import { similarInLibrary } from "./similar";
import { call } from "./sync";
import { MAX_NOTE, noteOf, writeNote } from "./store";
import type { Dataset, Short } from "./types";
import { confirmDialog, toast } from "./ui";
import { els, thumb } from "./view";

export interface WatchOpen {
  s: Short;
  /** The list it was opened from (⏮ ⏭ and Up next follow it). */
  list: Short[];
  ds: Dataset;
}

// ---------- what is remembered on this device ----------
const POS_KEY = "rf.pos";
const SPEED_KEY = "rf.speed";
const AUTO_KEY = "rf.autoNext";
const SPEEDS = [1, 1.25, 1.5, 2];
const MAX_POS = 300;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked or full: nothing is remembered */
  }
}
type Positions = Record<string, [sec: number, at: number]>;
const savedPos = (id: string) => read<Positions>(POS_KEY, {})[id]?.[0] ?? 0;
function savePos(id: string, sec: number) {
  const all = read<Positions>(POS_KEY, {});
  if (sec < 5) delete all[id];
  else all[id] = [Math.floor(sec), Date.now()];
  const keys = Object.keys(all);
  if (keys.length > MAX_POS) for (const k of keys.sort((a, b) => all[a][1] - all[b][1]).slice(0, keys.length - MAX_POS)) delete all[k];
  write(POS_KEY, all);
}

// ---------- state ----------
let root: HTMLElement | null = null;
let cur: WatchOpen | null = null;
let at = 0; // index in cur.list
let player: any = null;
let playerReady = false;
let timer = 0;
let layerDone: (() => void) | null = null;
let speed = Number(read<number>(SPEED_KEY, 1)) || 1;
let auto = read<boolean>(AUTO_KEY, false);
let token = 0; // a newer load makes an older one stop
let lastState = -1;

const time = (): number => {
  try {
    return playerReady ? Number(player.getCurrentTime()) || 0 : 0;
  } catch {
    return 0;
  }
};
const here = () => cur?.list[at] ?? cur?.s;

// ---------- parts of the page ----------
interface Parts {
  title: HTMLElement;
  meta: HTMLElement;
  desc: HTMLElement;
  host: HTMLElement;
  speeds: HTMLButtonElement[];
  noteBtn: HTMLButtonElement;
  note: HTMLElement;
  next: HTMLElement;
  related: HTMLElement;
  prev: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  auto: HTMLInputElement;
  fail: HTMLElement;
}
let p: Parts | null = null;

function build(): Parts {
  const r = root as HTMLElement;
  r.replaceChildren();
  const top = el("div", "w-top");
  const back = btn("←", () => dismiss(), "icon-btn w-back");
  back.setAttribute("aria-label", "Back to Home");
  top.append(back, el("div", "w-top-t", "Watching"));

  const scroll = el("div", "w-scroll");
  const main = el("div", "w-main");
  const side = el("div", "w-side");

  const box = el("div", "w-player");
  const host = el("div");
  box.append(host);
  const fail = el("div", "w-fail");
  fail.hidden = true;
  box.append(fail);

  const title = el("h1", "w-title");
  const meta = el("div", "w-meta");
  const desc = el("div", "w-desc");
  desc.hidden = true;

  const speedRow = el("div", "w-speeds");
  speedRow.setAttribute("role", "group");
  speedRow.setAttribute("aria-label", "Playback speed");
  const speeds = SPEEDS.map((x) => {
    const b = btn(`${x}×`, () => setSpeed(x), "btn sm w-speed");
    return b;
  });
  speedRow.append(...speeds);

  const noteBtn = btn("📝 Note at 0:00", () => void noteAtTime(), "btn sm w-notebtn");
  const autoLab = el("label", "w-auto");
  const autoBox = el("input");
  autoBox.type = "checkbox";
  autoBox.checked = auto;
  autoBox.onchange = () => {
    auto = autoBox.checked;
    write(AUTO_KEY, auto);
  };
  autoLab.append(autoBox, document.createTextNode(" Play next automatically"));
  const ytLink = el("a", "w-yt", "Open on YouTube ↗");
  ytLink.target = "_blank";
  ytLink.rel = "noopener";
  const tools = el("div", "w-tools");
  tools.append(speedRow, noteBtn);
  const more = el("div", "w-more");
  more.append(autoLab, ytLink);

  const note = el("div", "w-note");
  const next = el("div", "w-next");
  const related = el("div", "w-related");
  main.append(box, title, meta, tools, desc, note, more);
  side.append(next, related);
  scroll.append(main, side);

  const bar = el("div", "w-bar");
  const prev = btn("⏮ Previous", () => step(-1), "w-barbtn");
  const nextBtn = btn("Next ⏭", () => step(1), "w-barbtn");
  const home = btn("⌂ Home", () => dismiss(), "w-barbtn");
  bar.append(prev, home, nextBtn);

  r.append(top, scroll, bar);
  ytLink.dataset.yt = "1";
  return { title, meta, desc, host, speeds, noteBtn, note, next, related, prev, nextBtn, auto: autoBox, fail };
}

// ---------- the player ----------
function setSpeed(x: number) {
  speed = x;
  write(SPEED_KEY, x);
  try {
    if (playerReady) player.setPlaybackRate(x);
  } catch {
    /* the player will take it when it starts */
  }
  paintSpeeds();
}
function paintSpeeds() {
  p?.speeds.forEach((b, i) => {
    b.setAttribute("aria-pressed", String(SPEEDS[i] === speed));
  });
}

function onState(e: { data: number }) {
  lastState = e.data;
  const s = here();
  if (!s) return;
  if (e.data === 1) {
    try {
      player.setPlaybackRate(speed);
    } catch {
      /* ignore */
    }
  } else if (e.data === 2) {
    savePos(s.id, time());
  } else if (e.data === 0) {
    savePos(s.id, 0); // finished: next time it starts from the beginning
    if (auto && at < (cur?.list.length ?? 0) - 1) step(1);
  }
}

async function startPlayer(id: string, start: number) {
  const mine = ++token;
  p!.fail.hidden = true;
  if (player && playerReady) {
    player.loadVideoById({ videoId: id, startSeconds: start });
    return;
  }
  const YT = await loadApi();
  if (mine !== token || !root || root.hidden) return;
  playerReady = false;
  const holder = el("div");
  p!.host.replaceChildren(holder);
  holder.id = `w-yt-${mine}`;
  player = new YT.Player(holder.id, {
    videoId: id,
    width: "100%",
    height: "100%",
    playerVars: { playsinline: 1, rel: 0, start: Math.floor(start), autoplay: 1, modestbranding: 1 },
    events: {
      onReady: () => {
        playerReady = true;
        try {
          player.setPlaybackRate(speed);
        } catch {
          /* ignore */
        }
      },
      onStateChange: onState,
      onError: () => {
        const s = here();
        if (!p || !s) return;
        p.fail.hidden = false;
        p.fail.replaceChildren(el("p", "", "This video can't be played here (its owner turned embedding off, or it was removed)."));
        const a = el("a", "btn primary", "Watch on YouTube ↗");
        a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(s.id)}`;
        a.target = "_blank";
        a.rel = "noopener";
        p.fail.append(a);
      },
    },
  });
}

function destroyPlayer() {
  token++;
  try {
    player?.destroy();
  } catch {
    /* already gone */
  }
  player = null;
  playerReady = false;
}

// ---------- notes ----------
const STAMP = /(\[(?:\d+:)?\d+:\d\d\])/;
function seek(label: string) {
  const parts = label.slice(1, -1).split(":").map(Number);
  const sec = parts.reduce((a, n) => a * 60 + n, 0);
  try {
    if (playerReady) {
      player.seekTo(sec, true);
      player.playVideo();
    }
  } catch {
    /* ignore */
  }
}

function paintNote() {
  const s = here();
  if (!p || !s) return;
  const text = noteOf(s.id);
  p.note.replaceChildren();
  p.note.hidden = !text;
  if (!text) return;
  p.note.append(el("div", "w-note-h", "Your note"));
  for (const line of text.split("\n")) {
    const row = el("div", "w-note-l");
    for (const piece of line.split(STAMP)) {
      if (STAMP.test(piece)) {
        const b = btn(piece, () => seek(piece), "w-stamp");
        b.setAttribute("aria-label", `Jump to ${piece.slice(1, -1)}`);
        row.append(b);
      } else row.append(document.createTextNode(piece));
    }
    p.note.append(row);
  }
}

async function noteAtTime() {
  const s = here();
  if (!s) return;
  const t = time();
  const wasPlaying = lastState === 1;
  if (wasPlaying) {
    try {
      player.pauseVideo();
    } catch {
      /* ignore */
    }
  }
  const before = noteOf(s.id);
  const stamp = `[${lengthLabel(t)}] `;
  const box = el("div", "note-sheet");
  box.append(el("div", "note-vid", s.t));
  const area = el("textarea", "note-area");
  area.rows = 8;
  area.maxLength = MAX_NOTE;
  area.value = before ? `${before.replace(/\s+$/, "")}\n${stamp}` : stamp;
  area.setAttribute("aria-label", "Your note on this video");
  area.dataset.ownEnter = "1";
  box.append(area, el("div", "ch-note", "Saved when you tap Save. Times like [12:34] become tappable."));
  const ok = await confirmDialog({
    title: `📝 Note at ${lengthLabel(t)}`,
    extra: box,
    confirm: "Save",
    cancel: "Cancel",
    variant: "sheet",
    onOpen: () => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    },
  });
  if (ok) {
    const text = area.value.trim();
    // only the time and nothing else written: not a note
    if (text !== before.trim() && text !== stamp.trim()) {
      writeNote(s.id, text, s.t);
      toast(text ? "Note saved" : "Note deleted");
      paintNote();
    }
  }
  if (wasPlaying) {
    try {
      player.playVideo();
    } catch {
      /* ignore */
    }
  }
}

// ---------- the description (from YouTube, fetched when the page opens; 1 API unit, cached for a day) ----------
const descCache = new Map<string, string>();
async function loadDesc(id: string) {
  const box = p?.desc;
  if (!box) return;
  box.hidden = true;
  box.replaceChildren();
  let text = descCache.get(id);
  if (text === undefined) {
    try {
      text = (await call<{ desc: string }>(`/video-info?id=${encodeURIComponent(id)}`)).desc ?? "";
      descCache.set(id, text);
    } catch {
      return; // no connection to the server: the page just has no description
    }
  }
  if (!text.trim() || here()?.id !== id || !p) return;
  const body = el("div", "w-desc-t clamped", text.trim());
  const more = btn(
    "Show more",
    () => {
      const open = body.classList.toggle("clamped");
      more.textContent = open ? "Show more" : "Show less";
      more.setAttribute("aria-expanded", String(!open));
    },
    "w-desc-more",
  );
  more.setAttribute("aria-expanded", "false");
  p.desc.append(body, more);
  p.desc.hidden = false;
}

// ---------- cards: Up next and Related ----------
function card(s: Short, ds: Dataset, open: () => void): HTMLElement {
  const b = el("button", "home-long-card w-card");
  b.type = "button";
  const thumbBox = el("span", "hl-thumb");
  const img = el("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  thumb(img, s.id);
  thumbBox.append(img);
  if (s.d) thumbBox.append(el("span", "hl-dur", lengthLabel(s.d)));
  const meta = [ds.channels[s.ch]?.n, `${compact(s.v)} views`, ago(s.p)].filter(Boolean).join(" · ");
  b.append(thumbBox, el("span", "hl-title", s.t), el("span", "hl-meta", meta));
  b.onclick = open;
  return b;
}

function paintLists() {
  if (!p || !cur) return;
  const { list, ds } = cur;
  const s = list[at];
  p.prev.disabled = at <= 0;
  p.nextBtn.disabled = at >= list.length - 1;
  p.next.replaceChildren();
  const up = list[at + 1];
  if (up) {
    p.next.append(
      el("h2", "home-h", "Up next"),
      card(up, ds, () => step(1)),
    );
  }
  p.related.replaceChildren();
  const rel = similarInLibrary({ ds }, s, 12).filter((r) => r.short.id !== up?.id);
  if (rel.length) {
    p.related.append(el("h2", "home-h", "Related videos"));
    rel.forEach((r) => {
      p!.related.append(card(r.short, ds, () => jumpTo(r.short)));
    });
  }
}

// ---------- moving between videos ----------
function step(d: number) {
  if (!cur) return;
  const i = at + d;
  if (i < 0 || i >= cur.list.length) return;
  show(i);
}
/** A related video: it becomes the current one, and the list continues from the related videos after it. */
function jumpTo(s: Short) {
  if (!cur) return;
  const i = cur.list.findIndex((x) => x.id === s.id);
  if (i >= 0) return show(i);
  cur = { ...cur, list: [...cur.list.slice(0, at + 1), s, ...cur.list.slice(at + 1)] };
  show(at + 1);
}

function show(i: number) {
  if (!cur || !p) return;
  const old = here();
  if (old && playerReady) savePos(old.id, time());
  at = i;
  const s = cur.list[i];
  const ch = cur.ds.channels[s.ch];
  p.title.textContent = s.t;
  p.meta.textContent = [ch?.n, `${compact(s.v)} views`, ago(s.p), s.d ? lengthLabel(s.d) : ""].filter(Boolean).join(" · ");
  const yt = root?.querySelector<HTMLAnchorElement>("a[data-yt]");
  if (yt) yt.href = `https://www.youtube.com/watch?v=${encodeURIComponent(s.id)}`;
  paintSpeeds();
  paintNote();
  paintLists();
  void loadDesc(s.id);
  p.noteBtn.textContent = "📝 Note at 0:00";
  root?.querySelector(".w-scroll")?.scrollTo({ top: 0 });
  const pos = savedPos(s.id);
  const resume = pos > 5 && (!s.d || pos < s.d - 15);
  void startPlayer(s.id, resume ? pos : 0);
  if (resume) {
    toast(`Resuming at ${lengthLabel(pos)}`, {
      label: "Start over",
      run: () => {
        try {
          player.seekTo(0, true);
        } catch {
          /* ignore */
        }
      },
    });
  }
}

// ---------- opening and closing ----------
export const isWatching = () => !!root && !root.hidden;

export function openWatch(o: WatchOpen) {
  root ??= document.getElementById("watch") as HTMLElement;
  const opening = root.hidden;
  cur = { ...o };
  const i = o.list.findIndex((x) => x.id === o.s.id);
  if (i < 0) cur.list = [o.s, ...o.list];
  if (opening) {
    p = build();
    root.hidden = false;
    els.tabbar.hidden = true; // Home sits underneath: its bar and controls are out of reach until you are back
    els.home.inert = true;
    layerDone = pushLayer(hide);
    timer = window.setInterval(tick, 1000);
  }
  show(Math.max(i, 0));
}

let ticks = 0;
function tick() {
  const s = here();
  if (!p || !s || !playerReady) return;
  const t = time();
  p.noteBtn.textContent = `📝 Note at ${lengthLabel(t)}`;
  if (lastState === 1 && ++ticks % 5 === 0) savePos(s.id, t);
}

/** Closes the page (Back already took its history step). */
function hide() {
  const s = here();
  if (s && playerReady) savePos(s.id, time());
  clearInterval(timer);
  destroyPlayer();
  if (root) {
    root.hidden = true;
    root.replaceChildren();
  }
  p = null;
  cur = null;
  lastState = -1;
  layerDone = null;
  els.home.inert = false;
  els.tabbar.hidden = els.home.hidden; // the bar belongs to Home
}

/** Closes it from code (not by Back). */
export function closeWatch() {
  if (!isWatching()) return;
  const done = layerDone;
  hide();
  done?.();
}
