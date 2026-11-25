/**
 * Playlists (Menu → Playlists): videos in an order you decide, played one after another. "🎵 Add to a
 * playlist" in a video's ⋯ sheet puts the video on screen into one; the playlist page orders them
 * (▲ ▼), removes them and plays them with Repeat list and Shuffle. Loaded only when used.
 */
import type { AppApi } from "./app";
import { ago, btn, el } from "./dom";
import { playList, savedShort } from "./feed";
import { moved, type Playlist, playOrder, playlistById } from "./playlistdata";
import { act, persist, state } from "./store";
import { newId } from "./topicdata";
import type { Short } from "./types";
import { confirmDialog, toast } from "./ui";

const now = () => Math.floor(Date.now() / 1000);
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

// ---------- changes ----------
function createPlaylist(name: string, first?: Short): string {
  const id = newId();
  const t = now();
  act({ t: "plNew", p: { id, name: name.trim().slice(0, 100), ids: first ? [first.id] : [], at: t, up: t } });
  return id;
}
const setOrder = (pl: Playlist, ids: string[], name = pl.name) => act({ t: "plSet", id: pl.id, name, ids, up: now() }, { quiet: true });

/** The playlist's videos that are in your library right now (the others are shown as missing). */
const shortsOf = (pl: Playlist) => pl.ids.map((id) => savedShort(id)).filter((s): s is Short => !!s);

/** Plays a playlist from `start` (a position in its list): one after another, shuffled when Shuffle is on. */
export function playPlaylist(pl: Playlist, start = 0, back?: () => void) {
  const all = shortsOf(pl);
  if (!all.length) {
    toast("Nothing in this playlist can play yet");
    return;
  }
  const first = savedShort(pl.ids[start]) ?? all[0];
  const order = state.shuffle
    ? [
        first,
        ...playOrder(
          all.filter((s) => s.id !== first.id),
          true,
        ),
      ]
    : all;
  const at = state.shuffle
    ? 0
    : Math.max(
        0,
        order.findIndex((s) => s.id === first.id),
      );
  state.endMode = "next"; // a playlist plays one after another
  persist();
  playList(pl.name, order, at, back);
}

// ---------- the page ----------
const view = { open: "" };

/** Menu → Playlists. `rerender` draws the page again after a change. */
export function renderPlaylistsPage(body: HTMLElement, rerender: () => void, app: AppApi) {
  const pl = view.open ? playlistById(state.playlists, view.open) : undefined;
  if (!pl) view.open = "";
  if (pl) renderDetail(body, rerender, app, pl);
  else renderList(body, rerender);
}

function renderList(body: HTMLElement, rerender: () => void) {
  body.append(
    el(
      "p",
      "ch-note",
      "Videos in the order you decide, played one after another — for example Quran tilawat for sleep. Add videos from a video's ⋯ menu → 🎵 Add to a playlist.",
    ),
  );
  const form = el("form", "ch-add-form");
  const input = el("input", "ch-search");
  input.type = "text";
  input.placeholder = "A new playlist, like “Tilawat for sleep”";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Name of a new playlist");
  input.dataset.ownEnter = "1";
  const go = btn("＋ Create", () => {}, "btn sm primary");
  go.type = "submit";
  form.append(input, go);
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    view.open = createPlaylist(name);
    rerender();
  };
  body.append(form);
  if (!state.playlists.length) {
    const empty = el("div", "notes-empty");
    empty.append(
      el("div", "notes-empty-ico", "🎵"),
      el("p", "", "No playlists yet."),
      el("p", "ch-note", "Create one above, then add videos to it."),
    );
    body.append(empty);
    return;
  }
  const list = el("div", "topic-list");
  for (const p of state.playlists) {
    const card = el("div", "pl-card");
    const open = el("button", "pl-open");
    open.type = "button";
    open.append(el("span", "pl-name", p.name), el("span", "ch-note", `${plural(p.ids.length, "video")} · updated ${ago(p.up)}`));
    open.onclick = () => {
      view.open = p.id;
      rerender();
    };
    const play = btn("▶ Play", () => playPlaylist(p, 0, rerender), "btn sm primary");
    play.setAttribute("aria-label", `Play ${p.name}`);
    play.disabled = !p.ids.length;
    card.append(open, play);
    list.append(card);
  }
  body.append(list);
}

function renderDetail(body: HTMLElement, rerender: () => void, app: AppApi, pl: Playlist) {
  body.append(
    btn(
      "← All playlists",
      () => {
        view.open = "";
        rerender();
      },
      "btn sm topic-back",
    ),
  );
  const head = el("div", "topic-head");
  head.append(el("h3", "topic-name", pl.name));
  head.append(
    btn("✎ Rename", async () => {
      const input = el("input", "ch-search");
      input.type = "text";
      input.value = pl.name;
      input.setAttribute("aria-label", "Name of the playlist");
      input.dataset.ownEnter = "1";
      const ok = await confirmDialog({
        title: "Rename this playlist",
        extra: input,
        confirm: "Save",
        cancel: "Cancel",
        onOpen: () => input.select(),
      });
      const name = input.value.trim();
      if (!ok || !name || name === pl.name) return;
      act({ t: "plSet", id: pl.id, name, ids: pl.ids, up: now() });
      rerender();
    }),
  );
  body.append(head);

  const opts = el("div", "chips pl-opts");
  const toggle = (label: string, on: boolean, run: () => void) => {
    const b = btn(label, run, on ? "on" : "");
    b.setAttribute("aria-pressed", String(on));
    return b;
  };
  opts.append(
    toggle("🔁 Repeat playlist", state.listRepeat, () => {
      state.listRepeat = !state.listRepeat;
      if (state.listRepeat) state.endMode = "next";
      persist();
      rerender();
    }),
    toggle("🔀 Shuffle", state.shuffle, () => {
      state.shuffle = !state.shuffle;
      persist();
      rerender();
    }),
  );
  const actions = el("div", "topic-actions");
  actions.append(
    btn(`▶ Play (${shortsOf(pl).length})`, () => playPlaylist(pl, 0, rerender), "btn sm primary"),
    btn("🌙 Sleep timer", () => void import("./sleep").then((m) => m.openSleep())),
    btn(
      "Delete",
      async () => {
        const ok = await confirmDialog({
          title: "Delete this playlist?",
          body: `“${pl.name}” with ${plural(pl.ids.length, "video")}. The videos themselves stay in your library.`,
          confirm: "Delete",
          danger: true,
        });
        if (!ok) return;
        const old = structuredClone(pl);
        act({ t: "plDrop", id: pl.id });
        view.open = "";
        rerender();
        toast("Playlist deleted", {
          label: "Undo",
          run: () => {
            act({ t: "plNew", p: old });
            rerender();
          },
        });
      },
      "btn sm danger",
    ),
  );
  body.append(opts, actions);

  if (!pl.ids.length) {
    body.append(el("p", "ch-note", "Empty. Open a video, tap ⋯ → 🎵 Add to a playlist."));
    return;
  }
  body.append(el("div", "u-h", `Videos · ${pl.ids.length}`));
  const rows = el("div", "pl-rows");
  pl.ids.forEach((id, i) => {
    const s = savedShort(id);
    const row = el("div", "topic-vid");
    const img = el("img") as HTMLImageElement;
    img.alt = "";
    img.loading = "lazy";
    app.thumb(img, id);
    const txt = el("div", "topic-vid-txt");
    txt.append(el("div", "topic-vid-title", `${i + 1}. ${s?.t || "Video"}`));
    if (s) {
      const maker = s.fb ? (state.fbPages.find((p) => p.key === s.fb!.by)?.name ?? "Facebook") : (app.ds.channels[s.ch]?.n ?? "");
      txt.append(el("div", "ch-note", [maker, s.v ? `${app.fmt(s.v)} views` : ""].filter(Boolean).join(" · ")));
    } else txt.append(el("div", "ch-note", "No longer in your library"));
    const acts = el("div", "topic-vid-acts");
    const up = btn("▲", () => {
      setOrder(pl, moved(pl.ids, i, i - 1));
      rerender();
    });
    up.disabled = i === 0;
    up.setAttribute("aria-label", `Move ${s?.t || "this video"} up`);
    const down = btn("▼", () => {
      setOrder(pl, moved(pl.ids, i, i + 1));
      rerender();
    });
    down.disabled = i === pl.ids.length - 1;
    down.setAttribute("aria-label", `Move ${s?.t || "this video"} down`);
    const play = btn("▶", () => playPlaylist(pl, i, rerender));
    play.disabled = !s;
    play.setAttribute("aria-label", `Play from ${s?.t || "here"}`);
    const remove = btn("✕", () => {
      setOrder(
        pl,
        pl.ids.filter((x) => x !== id),
      );
      rerender();
      toast("Taken out of the playlist", {
        label: "Undo",
        run: () => {
          const cur = playlistById(state.playlists, pl.id);
          if (cur && !cur.ids.includes(id)) {
            const ids = [...cur.ids];
            ids.splice(Math.min(i, ids.length), 0, id);
            setOrder(cur, ids);
          }
          rerender();
        },
      });
    });
    remove.setAttribute("aria-label", `Take ${s?.t || "this video"} out of the playlist`);
    acts.append(play, up, down, remove);
    row.append(img, txt, acts);
    rows.append(row);
  });
  body.append(rows);
}

// ---------- "🎵 Add to a playlist" on a video ----------
/** The sheet that puts the video on screen into playlists (or starts a new one with it). */
export async function pickPlaylist(cur: Short): Promise<void> {
  const box = el("div", "topic-pick");
  box.append(el("div", "note-vid", cur.t || "This video"));
  const body = el("div");
  box.append(body);
  const draw = () => {
    body.replaceChildren();
    if (state.playlists.length) {
      body.append(el("div", "u-h", "Your playlists"));
      const list = el("div", "topic-pick-list");
      for (const p of state.playlists) {
        const inIt = p.ids.includes(cur.id);
        const b = el("button", `topic-pick-row${inIt ? " on" : ""}`);
        b.type = "button";
        b.setAttribute("aria-pressed", String(inIt));
        b.append(
          el("span", "topic-pick-check", inIt ? "✓" : "＋"),
          el("span", "topic-pick-name", p.name),
          el("span", "ch-note", String(p.ids.length)),
        );
        b.onclick = () => {
          if (inIt)
            setOrder(
              p,
              p.ids.filter((x) => x !== cur.id),
            );
          else act({ t: "plAdd", id: p.id, v: cur.id, up: now() });
          draw();
        };
        list.append(b);
      }
      body.append(list);
    }
    body.append(el("div", "u-h", "Start a new playlist with this video"));
    const form = el("form", "ch-add-form");
    const input = el("input", "ch-search");
    input.type = "text";
    input.placeholder = "Name of the playlist";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Name of a new playlist");
    input.dataset.ownEnter = "1";
    const go = btn("＋ Create", () => {}, "btn sm primary");
    go.type = "submit";
    form.append(input, go);
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      createPlaylist(name, cur);
      toast(`Started “${name}”`);
      draw();
    };
    body.append(form);
  };
  draw();
  await confirmDialog({ title: "🎵 Add to a playlist", extra: box, confirm: "Done", cancel: "Close", variant: "sheet" });
}
