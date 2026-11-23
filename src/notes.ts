/**
 * Notes on videos: the note sheet (opens from the amber note chip on every video) and the Notes page
 * in the Menu. One note per video, any Short or Facebook video; it syncs with your other devices.
 * Loaded only when used (its own small file).
 */
import { ago, btn, el, fmtTime } from "./dom";
import { feed, playList, renderNote, savedShort } from "./feed";
import { playback, pool } from "./player";
import { MAX_NOTE, noteOf, state, writeNote } from "./store";
import type { Short } from "./types";
import { confirmDialog, toast } from "./ui";

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("Couldn't copy — select the text and copy it");
  }
}

/**
 * The note sheet for one video. Closing it in any way (Save, Close, Esc, tapping outside) keeps what
 * you wrote — a note is never thrown away by accident. Delete is its own button, with Undo.
 */
export async function editNote(id: string, title: string): Promise<void> {
  const current = feed.cur?.id === id;
  const wasPlaying = current && playback.playing;
  if (wasPlaying) pool.pause(); // so you can write without the video running on
  const before = noteOf(id);

  const box = el("div", "note-sheet");
  box.append(el("div", "note-vid", title || "This video"));
  const area = el("textarea", "note-area");
  area.rows = 8;
  area.maxLength = MAX_NOTE;
  area.value = before;
  area.placeholder = "Write what you noticed: the hook, what to copy, an idea for our reel, a thing to try…";
  area.setAttribute("aria-label", "Your note on this video");
  area.dataset.ownEnter = "1"; // Enter makes a new line here
  const count = el("span", "ch-note note-count");
  const upd = () => {
    count.textContent = `${area.value.length} / ${MAX_NOTE}`;
  };
  area.addEventListener("input", upd);
  upd();

  const tools = el("div", "note-tools");
  if (current) {
    tools.append(
      btn("⏱ Add time", () => {
        const stamp = `[${fmtTime(pool.time())}] `;
        const a = area.selectionStart ?? area.value.length;
        const b = area.selectionEnd ?? a;
        area.value = area.value.slice(0, a) + stamp + area.value.slice(b);
        area.setSelectionRange(a + stamp.length, a + stamp.length);
        area.focus();
        upd();
      }),
    );
  }
  tools.append(
    btn("Copy", () => void copyText(area.value, "Note copied")),
    btn(
      "Delete note",
      () => {
        area.value = "";
        upd();
        area.focus();
      },
      "btn sm danger",
    ),
  );
  box.append(area, el("div", "note-foot"), tools);
  box.querySelector(".note-foot")!.append(count, el("span", "ch-note", "Saved when you close this."));

  await confirmDialog({ title: "📝 Note", extra: box, confirm: "Save", cancel: "Close", variant: "sheet", onOpen: () => area.focus() });

  const text = area.value.trim();
  if (text !== before.trim()) {
    writeNote(id, text, title);
    toast(
      text ? "Note saved" : "Note deleted",
      before && !text
        ? {
            label: "Undo",
            run: () => {
              writeNote(id, before, title);
              renderNote();
            },
          }
        : undefined,
    );
  }
  renderNote();
  if (wasPlaying && feed.cur?.id === id) pool.play();
}

// ---------- the Notes page ----------
const filter = { q: "" };

/** All your notes (Menu → Notes). `rerender` draws the page again after a change. */
export function renderNotesPage(body: HTMLElement, rerender: () => void) {
  const all = Object.entries(state.notes).sort((a, b) => b[1].at - a[1].at);
  body.append(
    el(
      "p",
      "ch-note",
      "Your notes on videos, newest first. They sync with your other devices. Open any video and tap the amber 📝 button (or press N) to write one.",
    ),
  );
  if (!all.length) {
    const empty = el("div", "notes-empty");
    empty.append(
      el("div", "notes-empty-ico", "📝"),
      el("p", "", "No notes yet."),
      el("p", "ch-note", "Play a video and tap “＋ Add note” above its title."),
    );
    body.append(empty);
    return;
  }

  const search = el("input", "ch-search");
  search.type = "search";
  search.placeholder = "Search your notes";
  search.setAttribute("aria-label", "Search your notes");
  search.value = filter.q;
  const copyAll = btn("Copy all notes", () => {
    const text = all.map(([, n]) => `${n.ti || "Video"}\n${n.x}`).join("\n\n———\n\n");
    void copyText(text, `Copied ${all.length} notes`);
  });
  const list = el("div", "notes-list");
  body.append(search, copyAll, list);

  const draw = () => {
    filter.q = search.value;
    const q = search.value.trim().toLowerCase();
    const rows = all.filter(([, n]) => !q || `${n.ti} ${n.x}`.toLowerCase().includes(q));
    const playable: { id: string; s: Short }[] = [];
    for (const [id] of rows) {
      const s = savedShort(id);
      if (s) playable.push({ id, s });
    }
    list.replaceChildren();
    if (!rows.length) list.append(el("p", "ch-note", "No note matches that."));
    for (const [id, n] of rows) {
      const card = el("article", "note-card");
      card.append(el("div", "note-card-title", n.ti || savedShort(id)?.t || "Video"));
      card.append(el("div", "note-card-text", n.x));
      card.append(el("div", "ch-note", `Updated ${ago(n.at)}`));
      const actions = el("div", "note-card-actions");
      const at = playable.findIndex((p) => p.id === id);
      if (at >= 0)
        actions.append(
          btn("▶ Play", () =>
            playList(
              "Notes",
              playable.map((p) => p.s),
              at,
              rerender,
            ),
          ),
        );
      actions.append(
        btn("✎ Edit", async () => {
          await editNote(id, n.ti);
          rerender();
        }),
        btn("Copy", () => void copyText(`${n.ti || "Video"}\n${n.x}`, "Note copied")),
        btn(
          "Delete",
          () => {
            const old = { ...n };
            writeNote(id, "", old.ti);
            renderNote();
            rerender();
            toast("Note deleted", {
              label: "Undo",
              run: () => {
                writeNote(id, old.x, old.ti);
                renderNote();
                rerender();
              },
            });
          },
          "btn sm danger",
        ),
      );
      card.append(actions);
      list.append(card);
    }
  };
  search.addEventListener("input", draw);
  draw();
}
