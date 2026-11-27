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
import { ago, btn, compact, el, nowSec } from "./dom";
import { lengthLabel } from "./home";
import { loadApi } from "./pool";
import { openChannel, openChannelOf } from "./explore";
import { longCardEl } from "./longcard";
import { app, feed } from "./feed";
import { dismiss, go, shareLink } from "./router";
import { similarInLibrary } from "./similar";
import { call } from "./sync";
import { act, MAX_NOTE, noteOf, state, writeNote } from "./store";
import type { Dataset, Short } from "./types";
import { confirmDialog, infoDialog, toast } from "./ui";
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
let speed = Number(read<number>(SPEED_KEY, 1)) || 1;
let auto = read<boolean>(AUTO_KEY, false);
let token = 0; // a newer load makes an older one stop
let lastState = -1;
let startedAt = 0; // when the current video was opened (unix seconds)

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
  chan: HTMLElement;
  comments: HTMLElement;
  saveBtn: HTMLButtonElement;
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
  const chan = el("div", "w-chan");
  chan.hidden = true;
  const comments = el("div", "w-comments");
  comments.hidden = true;

  const speedRow = el("div", "w-speeds");
  speedRow.setAttribute("role", "group");
  speedRow.setAttribute("aria-label", "Playback speed");
  const speeds = SPEEDS.map((x) => {
    const b = btn(`${x}×`, () => setSpeed(x), "btn sm w-speed");
    return b;
  });
  speedRow.append(...speeds);

  const noteBtn = btn("📝 Note at 0:00", () => void noteAtTime(), "btn sm w-notebtn");
  const saveBtn = btn("♡ Save", () => toggleSave(), "btn sm w-save");
  const topicBtn = btn("📚 Topic", () => void topicOf(), "btn sm");
  const shareBtn = btn("⤴ Share", () => shareIt(), "btn sm");
  const moreBtn = btn("⋯", () => void moreMenu(), "btn sm w-more-btn");
  moreBtn.setAttribute("aria-label", "More");
  saveBtn.setAttribute("aria-pressed", "false");
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
  const acts = el("div", "w-acts");
  acts.append(saveBtn, topicBtn, shareBtn, moreBtn);
  tools.append(speedRow, noteBtn);
  const more = el("div", "w-more");
  more.append(autoLab, ytLink);

  const note = el("div", "w-note");
  const next = el("div", "w-next");
  const related = el("div", "w-related");
  main.append(box, title, meta, chan, acts, tools, desc, comments, note, more);
  side.append(next, related);
  scroll.append(main, side);

  const bar = el("div", "w-bar");
  const prev = btn("⏮ Previous", () => step(-1), "w-barbtn");
  const nextBtn = btn("Next ⏭", () => step(1), "w-barbtn");
  const home = btn("⌂ Home", () => dismiss(), "w-barbtn");
  bar.append(prev, home, nextBtn);

  r.append(top, scroll, bar);
  ytLink.dataset.yt = "1";
  return { title, meta, desc, chan, comments, saveBtn, host, speeds, noteBtn, note, next, related, prev, nextBtn, auto: autoBox, fail };
}

// ---------- save, topic, share, more ----------
/** A copy the Saved list, topics and playlists can resolve: the channel number is the one in the Shorts library. */
function remember(s: Short): Short {
  const name = cur?.ds.channels[s.ch];
  const i = name ? feed.ds.channels.findIndex((c) => c.h === name.h) : -1;
  const copy = i >= 0 && i !== s.ch ? { ...s, ch: i } : s;
  if (!feed.byId.has(copy.id)) feed.byId.set(copy.id, copy);
  return copy;
}
function paintSave() {
  const s = here();
  if (!p || !s) return;
  const on = state.saved.includes(s.id);
  p.saveBtn.textContent = on ? "♥ Saved" : "♡ Save";
  p.saveBtn.setAttribute("aria-pressed", String(on));
  p.saveBtn.classList.toggle("on", on);
}
function toggleSave() {
  const s = here();
  if (!s) return;
  if (state.saved.includes(s.id)) {
    const i = state.saved.indexOf(s.id);
    act({ t: "unsave", id: s.id });
    toast("Removed from saved", {
      label: "Undo",
      run: () => {
        act({ t: "save", id: s.id, i });
        paintSave();
      },
    });
  } else {
    remember(s);
    act({ t: "save", id: s.id });
    toast("Saved");
  }
  paintSave();
}
async function topicOf() {
  const s = here();
  if (!s) return;
  try {
    const m = await import("./topics");
    await m.pickTopic(remember(s));
  } catch {
    toast("Couldn't open topics — check your connection and try again");
  }
}
const ytUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
async function sendLink(url: string, title: string) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    const input = Object.assign(document.createElement("input"), { value: url, readOnly: true });
    input.setAttribute("aria-label", "Link to this video");
    input.onfocus = () => input.select();
    infoDialog("Copy this link", input);
  }
}
function shareIt() {
  const s = here();
  if (!s) return;
  const box = el("div", "share-opts");
  const option = (title: string, hint: string, url: string) => {
    const b = el("button", "share-opt");
    b.type = "button";
    b.append(el("strong", "", title), el("span", "", hint));
    b.onclick = () => {
      for (const x of document.querySelectorAll<HTMLButtonElement>(".dlg-overlay button")) if (x.textContent === "Close") x.click();
      void sendLink(url, s.t);
    };
    return b;
  };
  box.append(
    option("Ecomgy link", "Opens in the app for people with the password.", new URL(shareLink(s.id).replace("/v/", "/w/")).href),
    option("Original YouTube link", "The video's own page. Works for anyone, no password.", ytUrl(s.id)),
  );
  void infoDialog("Share this video", box);
}
async function moreMenu() {
  const s = here();
  if (!s) return;
  const box = el("div", "share-opts");
  const row = (title: string, run: () => void) => {
    const b = el("button", "share-opt");
    b.type = "button";
    b.append(el("strong", "", title));
    b.onclick = () => {
      for (const x of document.querySelectorAll<HTMLButtonElement>(".dlg-overlay button")) if (x.textContent === "Close") x.click();
      setTimeout(run, 160); // after the dialog has closed
    };
    return b;
  };
  box.append(
    row("➕ Add to a playlist", () => {
      void import("./playlists").then((m) => m.pickPlaylist(remember(s)));
    }),
    row("Open on YouTube ↗", () => {
      window.open(ytUrl(s.id), "_blank", "noopener");
    }),
    row("Copy YouTube link", () => {
      void navigator.clipboard.writeText(ytUrl(s.id)).then(
        () => toast("Link copied"),
        () => toast("Couldn't copy"),
      );
    }),
  );
  void infoDialog("More", box);
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

// ---------- times in the description: tap one to jump there ----------
const TIME = /((?:\d{1,2}:)?\d{1,2}:\d{2})/g;
function withStamps(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(TIME)) {
    const i = m.index ?? 0;
    if (i > last) out.push(document.createTextNode(text.slice(last, i)));
    out.push(btn(m[1], () => seek(`[${m[1]}]`), "w-ts"));
    last = i + m[1].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}
/** Lines that start with a time are the video's chapters. */
function chaptersOf(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:[-•–]\s*)?((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–:]?\s*(.+)$/.exec(line);
    if (m) out.push([m[1], m[2].trim().slice(0, 80)]);
  }
  return out;
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

// ---------- about the video (from YouTube, fetched when the page opens; 2 API units, cached for a day) ----------
interface Info {
  desc: string;
  ch: { id: string; n: string; img: string; subs: number | null } | null;
  v: number | null;
  l: number | null;
  c: number | null;
  p: string;
  tags: string[];
}
interface Comment {
  a: string;
  img: string;
  t: string;
  l: number;
  p: string;
  r: number;
}
const infoCache = new Map<string, Info>();
const dateLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
const ytPath = (path: string) => `https://www.youtube.com/${path}`;

async function loadInfo(id: string) {
  if (!p) return;
  for (const b of [p.desc, p.comments]) {
    b.hidden = true;
    b.replaceChildren();
  }
  let info = infoCache.get(id);
  if (!info) {
    try {
      info = await call<Info>(`/video-info?id=${encodeURIComponent(id)}`);
      infoCache.set(id, info);
    } catch {
      return; // no connection to the server: the page just shows what the library knows
    }
  }
  if (here()?.id !== id || !p) return;
  const lib = here() && cur ? cur.ds.channels[here()!.ch] : undefined;
  if (info.ch)
    paintChannel({
      id: info.ch.id,
      n: info.ch.n,
      h: lib?.id === info.ch.id ? lib.h : "",
      img: info.ch.img || lib?.thumb || "",
      subs: info.ch.subs,
    });
  paintDesc(info);
  paintComments(id, info);
}

interface Who {
  id: string;
  n: string;
  h: string;
  img: string;
  subs: number | null;
}
/** The channel row: picture and name open the channel in the app (all its videos); ↗ opens it on YouTube. */
function paintChannel(c: Who) {
  if (!p || !c.n) return;
  const row = p.chan;
  row.replaceChildren();
  const go = btn("", () => openWho(c), "w-chan-go");
  go.title = "Open the channel";
  if (c.img) {
    const img = el("img", "w-chan-img");
    img.alt = "";
    img.src = c.img;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    go.append(img);
  }
  const txt = el("div", "w-chan-t");
  txt.append(el("div", "w-chan-n", c.n), el("div", "w-chan-s", c.subs ? `${compact(c.subs)} subscribers` : ""));
  go.append(txt);
  const yt = el("a", "btn sm w-chan-open", "↗");
  yt.title = "Open the channel on YouTube";
  yt.setAttribute("aria-label", "Open the channel on YouTube");
  yt.href = c.id ? ytPath(`channel/${encodeURIComponent(c.id)}`) : ytPath(`@${encodeURIComponent(c.h.replace(/^@/, ""))}`);
  yt.target = "_blank";
  yt.rel = "noopener";
  row.append(go, yt);
  row.hidden = false;
}
function openWho(c: Who) {
  try {
    player?.pauseVideo?.();
  } catch {
    /* ignore */
  }
  openChannel(app, { info: { id: c.id, name: c.n, handle: c.h, thumb: c.img, subs: c.subs ?? 0, suggestedCats: [] } });
}

function paintDesc(info: Info) {
  if (!p) return;
  const box = p.desc;
  const stats = [
    info.v != null ? `${compact(info.v)} views` : "",
    info.p ? dateLabel(info.p) : "",
    info.l != null ? `👍 ${compact(info.l)}` : "",
  ].filter(Boolean);
  if (stats.length) box.append(el("div", "w-desc-stats", stats.join("  ·  ")));
  const text = info.desc.trim();
  if (text) {
    const body = el("div", "w-desc-t clamped");
    body.append(...withStamps(text));
    const chapters = chaptersOf(text);
    if (chapters.length >= 3) {
      const list = el("div", "w-chapters");
      list.append(el("div", "w-chapters-h", "Chapters"));
      for (const [t, name] of chapters) list.append(btn(`${t}  ${name}`, () => seek(`[${t}]`), "w-chapter"));
      box.append(list);
    }
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
    box.append(body, more);
  }
  if (info.tags.length) box.append(el("div", "w-desc-tags", info.tags.map((t) => `#${t.replace(/\s+/g, "")}`).join(" ")));
  box.hidden = !box.childElementCount;
}

/** Comments are read-only and loaded only when you open them (1 more API unit, cached for a day). */
function paintComments(id: string, info: Info) {
  if (!p || info.c === 0) return;
  const box = p.comments;
  const head = btn(info.c != null ? `💬 Comments · ${compact(info.c)}` : "💬 Comments", () => void open(), "w-comments-h");
  head.setAttribute("aria-expanded", "false");
  const list = el("div", "w-comments-l");
  list.hidden = true;
  box.append(head, list);
  box.hidden = false;
  let loaded = false;
  async function open() {
    const show = list.hidden;
    list.hidden = !show;
    head.setAttribute("aria-expanded", String(show));
    if (!show || loaded) return;
    loaded = true;
    list.append(el("div", "w-comment-note", "Loading…"));
    try {
      const r = await call<{ items: Comment[]; off: boolean }>(`/video-comments?id=${encodeURIComponent(id)}`);
      if (here()?.id !== id) return;
      list.replaceChildren();
      if (!r.items.length) list.append(el("div", "w-comment-note", r.off ? "Comments are turned off for this video." : "No comments yet."));
      for (const c of r.items) list.append(commentRow(c));
      const all = el("a", "w-comment-note w-comment-all", "See all comments on YouTube ↗");
      all.href = ytUrl(id);
      all.target = "_blank";
      all.rel = "noopener";
      list.append(all);
    } catch {
      loaded = false;
      list.replaceChildren(el("div", "w-comment-note", "Couldn't load the comments — try again."));
    }
  }
}

function commentRow(c: Comment): HTMLElement {
  const row = el("div", "w-comment");
  const img = el("img", "w-comment-img");
  img.alt = "";
  img.src = c.img;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  const body = el("div", "w-comment-b");
  const when = c.p ? dateLabel(c.p) : "";
  body.append(
    el("div", "w-comment-a", [c.a, when].filter(Boolean).join(" · ")),
    el("div", "w-comment-t", c.t),
    el(
      "div",
      "w-comment-m",
      [c.l ? `👍 ${compact(c.l)}` : "", c.r ? `${compact(c.r)} ${c.r === 1 ? "reply" : "replies"}` : ""].filter(Boolean).join("  ·  "),
    ),
  );
  row.append(img, body);
  return row;
}

// ---------- cards: Up next and Related ----------
function card(s: Short, ds: Dataset, open: () => void): HTMLElement {
  const ch = ds.channels[s.ch];
  return longCardEl({
    id: s.id,
    title: s.t,
    dur: s.d ? lengthLabel(s.d) : "",
    channel: ch?.n ?? "",
    rest: `${compact(s.v)} views · ${ago(s.p)}`,
    thumb,
    open,
    openChannel: ch ? () => openChannelOf(app, ch) : undefined,
    extraClass: "w-card",
  });
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

/** What you watched goes into History, like a Short does (with enough to rebuild it later). */
function logWatch(s: Short | undefined, sec: number) {
  if (!s || !cur || state.histPaused || sec < 10) return;
  const ch = cur.ds.channels[s.ch];
  act({
    t: "watch",
    item: {
      id: s.id,
      at: startedAt || nowSec(),
      f: s.d ? Math.min(1, Math.round((sec / s.d) * 100) / 100) : 0,
      ...(ch ? { x: { t: s.t, n: ch.n, h: ch.h, c: ch.id, d: s.d || undefined } } : {}),
    },
  });
}

function show(i: number) {
  if (!cur || !p) return;
  const old = here();
  if (old && playerReady) {
    savePos(old.id, time());
    logWatch(old, time());
  }
  startedAt = nowSec();
  at = i;
  const s = cur.list[i];
  if (root) root.dataset.vid = s.id;
  go({ k: "watch", v: s.id }, { replace: true }); // (a no-op when this is the address already)
  const ch = cur.ds.channels[s.ch];
  p.title.textContent = s.t;
  p.meta.textContent = [ch?.n, `${compact(s.v)} views`, ago(s.p), s.d ? lengthLabel(s.d) : ""].filter(Boolean).join(" · ");
  const yt = root?.querySelector<HTMLAnchorElement>("a[data-yt]");
  if (yt) yt.href = `https://www.youtube.com/watch?v=${encodeURIComponent(s.id)}`;
  paintSpeeds();
  paintNote();
  paintSave();
  paintLists();
  if (ch)
    paintChannel({ id: ch.id, n: ch.n, h: ch.h, img: ch.thumb, subs: ch.subs }); // from the library now; YouTube's numbers replace it when they arrive
  else p.chan.hidden = true;
  void loadInfo(s.id);
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
    go({ k: "watch", v: o.s.id }); // its own address (/w/ID): Back returns to Home, and a link opens it
    timer = window.setInterval(tick, 1000);
    document.addEventListener("keydown", keys);
  }
  show(Math.max(i, 0));
}

/** Keyboard, like YouTube: space/K play-pause, J/L ±10 s, ←/→ ±5 s, F full screen, M mute, 0–9 jump, Shift+N/P next/previous. */
function keys(e: KeyboardEvent) {
  if (!playerReady || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, select, [contenteditable]")) return;
  if (t?.closest("button, a") && (e.key === " " || e.key === "Enter")) return; // those press the focused button
  if (!els.page.hidden || !els.panel.hidden) return; // a page or the Menu is above the player
  const k = e.key.toLowerCase();
  const jump = (d: number) => player.seekTo(Math.max(0, time() + d), true);
  try {
    if (k === " " || k === "k") player.getPlayerState() === 1 ? player.pauseVideo() : player.playVideo();
    else if (k === "j") jump(-10);
    else if (k === "l") jump(10);
    else if (k === "arrowleft") jump(-5);
    else if (k === "arrowright") jump(5);
    else if (k === "m") player.isMuted() ? player.unMute() : player.mute();
    else if (k === "f") void root?.querySelector(".w-player")?.requestFullscreen?.();
    else if (k === "n" && e.shiftKey) step(1);
    else if (k === "p" && e.shiftKey) step(-1);
    else if (/^[0-9]$/.test(k) && here()?.d) player.seekTo((here()!.d! * Number(k)) / 10, true);
    else return;
  } catch {
    return;
  }
  e.preventDefault();
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
  if (s && playerReady) {
    savePos(s.id, time());
    logWatch(s, time());
  }
  clearInterval(timer);
  document.removeEventListener("keydown", keys);
  destroyPlayer();
  if (root) {
    root.hidden = true;
    root.replaceChildren();
  }
  p = null;
  cur = null;
  lastState = -1;
  els.home.inert = false;
  els.tabbar.hidden = els.home.hidden; // the bar belongs to Home
}

/** Closes the page when the address has already moved (Back). */
export function hideWatch() {
  if (isWatching()) hide();
}
