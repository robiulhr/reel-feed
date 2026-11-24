/**
 * Topics (Menu → Topics): subjects you're researching. A topic holds the videos you pinned, your notes,
 * links and its search words; the app finds more videos about it in your library by itself (free), and
 * can search YouTube on request. "📚 Topic" on any video adds it to a topic, suggesting the ones it fits.
 * Loaded only when used (its own file). The data and its rules are in topicdata.ts.
 */
import type { AppApi } from "./app";
import { ago, btn, el } from "./dom";
import { feed, playList, renderTopic, savedShort } from "./feed";
import { matchInLibrary, openTopicSearch, suggestWords, textSimilarity } from "./similar";
import { act, noteOf, state } from "./store";
import { MAX_TOPIC_NOTE, newId, normKeywords, TOPIC_STATUSES, type Topic, type TopicStatus, topicById } from "./topicdata";
import type { Short } from "./types";
import { confirmDialog, toast } from "./ui";

const now = () => Math.floor(Date.now() / 1000);
const statusLabel = (s: TopicStatus) => TOPIC_STATUSES.find((x) => x.id === s)?.label ?? s;
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
/** What the automatic matching looks for: the name and the search words. */
const topicText = (t: Pick<Topic, "name" | "kw">) => `${t.name} ${t.kw.join(" ")}`;

// ---------- changes ----------
function createTopic(name: string, kw: string[], first?: Short): string {
  const id = newId();
  const t = now();
  act({
    t: "topicNew",
    p: {
      id,
      name: name.trim().slice(0, 120),
      why: "",
      st: "researching",
      kw: normKeywords(kw),
      vids: [],
      no: [],
      notes: [],
      links: [],
      at: t,
      up: t,
    },
  });
  if (first) pin(id, first);
  return id;
}
function edit(t: Topic, patch: Partial<Pick<Topic, "name" | "why" | "st" | "kw">>) {
  const n = { ...t, ...patch };
  act({ t: "topicSet", id: t.id, name: n.name, why: n.why, st: n.st, kw: n.kw, up: now() });
}
const pin = (id: string, s: Short) => act({ t: "topicVid", id, v: s.id, m: "pin", at: now(), ti: s.t });
const unpin = (id: string, v: string) => act({ t: "topicVid", id, v, m: "unpin", at: now() });
const skip = (id: string, v: string) => act({ t: "topicVid", id, v, m: "skip", at: now() });
const unskip = (id: string, v: string) => act({ t: "topicVid", id, v, m: "unskip", at: now() });

/** Videos in your library about this topic that aren't pinned and weren't marked "not about this". */
function found(app: Pick<AppApi, "ds">, t: Topic, limit = 60): Short[] {
  return matchInLibrary(app, topicText(t), new Set([...t.vids.map((v) => v.id), ...t.no]), limit);
}
const pinnedShorts = (t: Topic) => t.vids.map((v) => savedShort(v.id)).filter((s): s is Short => !!s);

function urlOf(s: Short) {
  return s.fb ? s.fb.url : `https://www.youtube.com/shorts/${s.id}`;
}
function briefOf(t: Topic): string {
  const lines = [`TOPIC: ${t.name}`, `Status: ${statusLabel(t.st)}`];
  if (t.why) lines.push(`Why: ${t.why}`);
  if (t.kw.length) lines.push(`Search words: ${t.kw.join(", ")}`);
  if (t.notes.length) lines.push("", "NOTES", ...[...t.notes].reverse().map((n) => `- ${n.x.replace(/\n+/g, " ")}`));
  if (t.links.length) lines.push("", "LINKS", ...t.links.map((l) => `- ${l.u}${l.x ? ` — ${l.x}` : ""}`));
  if (t.vids.length) {
    lines.push("", "VIDEOS");
    t.vids.forEach((v, i) => {
      const s = savedShort(v.id);
      const note = noteOf(v.id).trim();
      lines.push(`${i + 1}. ${s?.t || v.ti || "Video"}${s ? ` — ${urlOf(s)}` : ""}`);
      if (note) lines.push(`   Note: ${note.replace(/\n+/g, " ")}`);
    });
  }
  return lines.join("\n");
}
async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast("Couldn't copy — select the text and copy it");
  }
}

// ---------- shared pieces ----------
function textBox(placeholder: string, label: string, rows = 3) {
  const a = el("textarea", "note-area");
  a.rows = rows;
  a.maxLength = MAX_TOPIC_NOTE;
  a.placeholder = placeholder;
  a.setAttribute("aria-label", label);
  a.dataset.ownEnter = "1";
  return a;
}
function line(placeholder: string, label: string) {
  const i = el("input", "ch-search");
  i.type = "text";
  i.placeholder = placeholder;
  i.autocomplete = "off";
  i.setAttribute("aria-label", label);
  i.dataset.ownEnter = "1";
  return i;
}

/** A video in a topic: picture, title, who/views, your note on it, and buttons. */
function videoRow(app: AppApi, s: Short | undefined, fallback: { id: string; ti: string }, actions: HTMLElement[]) {
  const row = el("div", "topic-vid");
  const img = el("img") as HTMLImageElement;
  img.alt = "";
  img.loading = "lazy";
  app.thumb(img, fallback.id);
  const txt = el("div", "topic-vid-txt");
  txt.append(el("div", "topic-vid-title", s?.t || fallback.ti || "Video"));
  if (s) {
    const maker = s.fb ? (state.fbPages.find((p) => p.key === s.fb!.by)?.name ?? "Facebook") : (app.ds.channels[s.ch]?.n ?? "");
    txt.append(el("div", "ch-note", [maker, s.v ? `${app.fmt(s.v)} views` : ""].filter(Boolean).join(" · ")));
  } else txt.append(el("div", "ch-note", "No longer in your library"));
  const note = noteOf(fallback.id).trim();
  if (note) txt.append(el("div", "topic-vid-note", `📝 ${note.replace(/\s+/g, " ").slice(0, 140)}`));
  const acts = el("div", "topic-vid-acts");
  acts.append(...actions);
  row.append(img, txt, acts);
  return row;
}

// ---------- the page ----------
const view = { open: "", status: "all" as TopicStatus | "all", more: 10 };

/** Opens the Menu's Topics page on this topic (used by Search). */
export function showTopic(id: string) {
  view.open = id;
  view.more = 10;
}

/** Menu → Topics. `rerender` draws the page again after a change. */
export function renderTopicsPage(body: HTMLElement, rerender: () => void, app: AppApi) {
  const t = view.open ? topicById(state.topics, view.open) : undefined;
  if (!t) view.open = "";
  if (t) renderDetail(body, rerender, app, t);
  else renderList(body, rerender, app);
}

function renderList(body: HTMLElement, rerender: () => void, app: AppApi) {
  body.append(
    el(
      "p",
      "ch-note",
      "Subjects you're researching. Pin videos, write notes and keep links; the app also finds more videos about each topic in your library by itself.",
    ),
  );
  const form = el("form", "ch-add-form");
  const input = line("A topic, like “price war” or “Nike’s Jordan deal”", "Name of a new topic");
  const go = btn("＋ Start", () => {}, "btn sm primary");
  go.type = "submit";
  form.append(input, go);
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    view.open = createTopic(name, [name]);
    view.more = 10;
    rerender();
  };
  body.append(form);

  if (!state.topics.length) {
    const empty = el("div", "notes-empty");
    empty.append(
      el("div", "notes-empty-ico", "📚"),
      el("p", "", "No topics yet."),
      el("p", "ch-note", "Type one above, or tap “📚 Topic” on any video to start one from it."),
    );
    body.append(empty);
    return;
  }

  const chips = el("div", "chips topic-chips");
  const count = (s: TopicStatus | "all") => (s === "all" ? state.topics.length : state.topics.filter((t) => t.st === s).length);
  for (const [id, label] of [["all", "All"], ...TOPIC_STATUSES.map((s) => [s.id, s.label])] as [TopicStatus | "all", string][]) {
    const b = btn(
      `${label} · ${count(id)}`,
      () => {
        view.status = id;
        rerender();
      },
      view.status === id ? "on" : "",
    );
    b.setAttribute("aria-pressed", String(view.status === id));
    chips.append(b);
  }
  body.append(chips);

  const list = el("div", "topic-list");
  for (const t of state.topics.filter((x) => view.status === "all" || x.st === view.status)) {
    const card = el("button", "topic-card");
    card.type = "button";
    const top = el("div", "topic-card-top");
    top.append(el("span", "topic-card-name", t.name), el("span", `topic-pill st-${t.st}`, statusLabel(t.st)));
    const more = found(app, t, 99).length;
    const facts = [plural(t.vids.length, "video"), plural(t.notes.length, "note")];
    if (more) facts.push(`${more} more found`);
    card.append(top, el("div", "ch-note", facts.join(" · ")));
    if (t.why) card.append(el("div", "topic-card-why", t.why));
    card.append(el("div", "ch-note", `Updated ${ago(t.up)}`));
    card.onclick = () => {
      view.open = t.id;
      view.more = 10;
      rerender();
    };
    list.append(card);
  }
  if (!list.children.length) list.append(el("p", "ch-note", "No topic with that status."));
  body.append(list);
}

function renderDetail(body: HTMLElement, rerender: () => void, app: AppApi, t: Topic) {
  body.append(
    btn(
      "← All topics",
      () => {
        view.open = "";
        rerender();
      },
      "btn sm topic-back",
    ),
  );
  const head = el("div", "topic-head");
  head.append(el("h3", "topic-name", t.name));
  head.append(btn("✎ Edit", () => void editDialog(t, rerender), "btn sm"));
  body.append(head);

  const status = el("div", "chips topic-chips");
  for (const s of TOPIC_STATUSES) {
    const b = btn(
      s.label,
      () => {
        if (t.st !== s.id) edit(t, { st: s.id });
        rerender();
      },
      t.st === s.id ? "on" : "",
    );
    b.setAttribute("aria-pressed", String(t.st === s.id));
    status.append(b);
  }
  body.append(status);
  body.append(el("p", t.why ? "topic-why" : "ch-note", t.why || "No “why” yet — tap ✎ Edit to note the angle you have in mind."));

  const auto = found(app, t, 60);
  const pinned = pinnedShorts(t);
  const watch = [...pinned, ...auto];
  const actions = el("div", "topic-actions");
  if (watch.length)
    actions.append(
      btn(`▶ Watch (${watch.length})`, () => playList(t.name, watch, 0, rerender), "btn sm primary"),
      btn("🔎 Find on YouTube", () => openTopicSearch(app, t)),
    );
  else actions.append(btn("🔎 Find on YouTube", () => openTopicSearch(app, t), "btn sm primary"));
  actions.append(
    btn("Copy brief", () => void copy(briefOf(t), "Topic copied")),
    btn(
      "Delete",
      async () => {
        const ok = await confirmDialog({
          title: "Delete this topic?",
          body: `“${t.name}” with its ${plural(t.notes.length, "note")} and ${plural(t.vids.length, "pinned video")}. The videos themselves stay in your library.`,
          confirm: "Delete",
          danger: true,
        });
        if (!ok) return;
        const old = structuredClone(t);
        act({ t: "topicDrop", id: t.id });
        view.open = "";
        rerender();
        toast("Topic deleted", {
          label: "Undo",
          run: () => {
            act({ t: "topicNew", p: old });
            rerender();
          },
        });
      },
      "btn sm danger",
    ),
  );
  body.append(actions);

  // ---- search words
  const words = el("section", "topic-sec");
  words.append(el("h4", "u-h", "Search words"));
  const wordRow = el("div", "topic-words");
  const rebuildWords = () => {
    wordRow.replaceChildren();
    for (const w of t.kw) {
      const chip = btn(
        `${w} ✕`,
        () => {
          edit(t, { kw: t.kw.filter((x) => x !== w) });
          rerender();
        },
        "topic-word",
      );
      chip.setAttribute("aria-label", `Remove the search word ${w}`);
      wordRow.append(chip);
    }
    if (!t.kw.length) wordRow.append(el("span", "ch-note", "None — the topic's name is used."));
  };
  rebuildWords();
  const addWord = el("form", "ch-add-form");
  const wi = line("Add a search word or phrase", "Add a search word");
  const wb = btn("Add", () => {}, "btn sm");
  wb.type = "submit";
  addWord.append(wi, wb);
  addWord.onsubmit = (e) => {
    e.preventDefault();
    const more = normKeywords([...t.kw, ...wi.value.split(",")]);
    if (more.join() === t.kw.join()) return;
    edit(t, { kw: more });
    rerender();
  };
  words.append(
    wordRow,
    addWord,
    el("p", "ch-note", "Videos are found by these words (and the topic's name), in titles in your library and in the YouTube search."),
  );
  body.append(words);

  // ---- notes
  const notes = el("section", "topic-sec");
  notes.append(el("h4", "u-h", `Notes · ${t.notes.length}`));
  const area = textBox("Write what you found: an angle, a fact, a hook, a question, a line for the script…", "A new note on this topic");
  const addNote = () => {
    const x = area.value.trim();
    if (!x) return;
    act({ t: "topicNote", id: t.id, n: { i: newId(), x, at: now() } });
    rerender();
  };
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      addNote();
    }
  });
  notes.append(area, btn("＋ Add note", addNote, "btn sm primary"));
  for (const n of t.notes) {
    const card = el("article", "note-card");
    card.append(el("div", "note-card-text", n.x), el("div", "ch-note", `${ago(n.at)}`));
    const acts = el("div", "note-card-actions");
    acts.append(
      btn("✎ Edit", () => {
        const ta = textBox("", "Edit this note", 4);
        ta.value = n.x;
        const save = btn(
          "Save",
          () => {
            act({ t: "topicNote", id: t.id, n: { i: n.i, x: ta.value, at: now() } });
            rerender();
          },
          "btn sm primary",
        );
        card.replaceChildren(ta, save, btn("Cancel", rerender));
        ta.focus();
      }),
      btn("Copy", () => void copy(n.x, "Note copied")),
      btn(
        "Delete",
        () => {
          act({ t: "topicNote", id: t.id, n: { i: n.i, x: "", at: now() } });
          rerender();
          toast("Note deleted", {
            label: "Undo",
            run: () => {
              act({ t: "topicNote", id: t.id, n: { i: n.i, x: n.x, at: now() } });
              rerender();
            },
          });
        },
        "btn sm danger",
      ),
    );
    card.append(acts);
    notes.append(card);
  }
  body.append(notes);

  // ---- pinned videos
  const vids = el("section", "topic-sec");
  vids.append(el("h4", "u-h", `Pinned videos · ${t.vids.length}`));
  if (!t.vids.length)
    vids.append(el("p", "ch-note", "Nothing pinned yet. Pin from the list below, or tap “📚 Topic” while watching a video."));
  t.vids.forEach((v) => {
    const s = savedShort(v.id);
    const at = pinned.findIndex((p) => p.id === v.id);
    vids.append(
      videoRow(app, s, v, [
        ...(at >= 0 ? [btn("▶", () => playList(t.name, pinned, at, rerender), "btn sm")] : []),
        btn(
          "Unpin",
          () => {
            unpin(t.id, v.id);
            rerender();
          },
          "btn sm",
        ),
      ]),
    );
  });
  body.append(vids);

  // ---- found automatically
  const auto2 = el("section", "topic-sec");
  auto2.append(el("h4", "u-h", `Found in your library · ${auto.length}`));
  if (!auto.length)
    auto2.append(el("p", "ch-note", "Nothing else in your library matches these words yet. Add search words, or search YouTube."));
  else
    auto2.append(
      el(
        "p",
        "ch-note",
        "Found by themselves from the search words. ▶ Watch one to see if it fits, then pin it; ✕ means “not about this” and it won't come back.",
      ),
    );
  for (const s of auto.slice(0, view.more)) {
    auto2.append(
      videoRow(app, s, { id: s.id, ti: s.t }, [
        // watch it first: the list plays on from this video, so you can judge whether it fits before pinning
        btn("▶ Watch", () => playList(`${t.name} — found`, auto, auto.indexOf(s), rerender), "btn sm"),
        btn(
          "📌 Pin",
          () => {
            pin(t.id, s);
            rerender();
          },
          "btn sm primary",
        ),
        btn(
          "✕",
          () => {
            skip(t.id, s.id);
            rerender();
            toast("Won't show this one for this topic", {
              label: "Undo",
              run: () => {
                unskip(t.id, s.id);
                rerender();
              },
            });
          },
          "btn sm",
        ),
      ]),
    );
  }
  if (auto.length > view.more)
    auto2.append(
      btn(
        `Show more (${auto.length - view.more})`,
        () => {
          view.more += 20;
          rerender();
        },
        "btn sm",
      ),
    );
  body.append(auto2);

  // ---- links
  const links = el("section", "topic-sec");
  links.append(el("h4", "u-h", `Links · ${t.links.length}`));
  const lf = el("form", "ch-add-form topic-linkform");
  const lu = line("https://… an article, a post, a page", "Address of a link");
  const lx = line("What it is (optional)", "What this link is");
  const lb = btn("Add link", () => {}, "btn sm");
  lb.type = "submit";
  lf.append(lu, lx, lb);
  lf.onsubmit = (e) => {
    e.preventDefault();
    let u = lu.value.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    act({ t: "topicLink", id: t.id, l: { i: newId(), u, x: lx.value.trim(), at: now() } });
    rerender();
  };
  links.append(lf);
  for (const l of t.links) {
    const row = el("div", "topic-link");
    const a = el("a", "topic-link-a", l.x || l.u);
    a.href = l.u;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    row.append(
      a,
      btn(
        "✕",
        () => {
          act({ t: "topicLink", id: t.id, l: { i: l.i, u: "", x: "", at: now() } });
          rerender();
        },
        "btn sm",
      ),
    );
    row.querySelector("button")!.setAttribute("aria-label", "Remove this link");
    links.append(row);
  }
  body.append(links);
}

/** Name, why, status and search words in one dialog. */
async function editDialog(t: Topic, rerender: () => void) {
  const box = el("div", "topic-edit");
  const name = line("Name", "Name of the topic");
  name.value = t.name;
  const why = textBox("Why are you researching this? The angle you have in mind.", "Why this topic", 3);
  why.value = t.why;
  const kw = line("Search words, separated by commas", "Search words");
  kw.value = t.kw.join(", ");
  box.append(name, why, kw);
  const ok = await confirmDialog({
    title: "Edit topic",
    extra: box,
    confirm: "Save",
    cancel: "Cancel",
    variant: "sheet",
    onOpen: () => name.focus(),
  });
  if (!ok) return;
  const n = name.value.trim() || t.name;
  edit(t, { name: n, why: why.value.trim(), kw: normKeywords(kw.value.split(",")) });
  rerender();
}

// ---------- "📚 Topic" on a video ----------
/** The sheet that adds the video on screen to topics. It suggests the ones it fits, or starts a new one from it. */
export async function pickTopic(cur: Short): Promise<void> {
  const app = { ds: feed.ds };
  const box = el("div", "topic-pick");
  const vid = el("div", "note-vid", cur.t || "This video");
  const draw = () => {
    box.replaceChildren(vid);
    const rows = state.topics
      .map((t) => ({ t, in: t.vids.some((v) => v.id === cur.id), sim: textSimilarity(app, cur.t, topicText(t)) }))
      .sort((a, b) => Number(b.in) - Number(a.in) || b.sim - a.sim);
    const fits = rows.filter((r) => !r.in && r.sim >= 0.18).map((r) => r.t.id);
    if (rows.length) {
      box.append(el("div", "u-h", "Your topics"));
      const list = el("div", "topic-pick-list");
      for (const r of rows) {
        const b = el("button", `topic-pick-row${r.in ? " on" : ""}`);
        b.type = "button";
        b.setAttribute("aria-pressed", String(r.in));
        b.append(el("span", "topic-pick-check", r.in ? "✓" : "＋"), el("span", "topic-pick-name", r.t.name));
        if (fits.includes(r.t.id)) b.append(el("span", "topic-pill st-fit", "Looks like it fits"));
        b.onclick = () => {
          if (r.in) unpin(r.t.id, cur.id);
          else pin(r.t.id, cur);
          renderTopic();
          draw();
        };
        list.append(b);
      }
      box.append(list);
    }
    box.append(el("div", "u-h", "Start a new topic from this video"));
    const words = suggestWords(app, cur);
    const form = el("form", "ch-add-form");
    const input = line("Name of the topic", "Name of a new topic");
    input.value = words.slice(0, 3).join(" ");
    const go = btn("＋ Start", () => {}, "btn sm primary");
    go.type = "submit";
    form.append(input, go);
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      createTopic(name, [...new Set([name.toLowerCase(), ...words])], cur);
      toast(`Started “${name}”`);
      renderTopic();
      draw();
    };
    box.append(
      form,
      el(
        "p",
        "ch-note",
        "Search words are taken from the video's title, so the topic starts finding similar videos by itself. You can change them in the topic.",
      ),
    );
  };
  draw();
  await confirmDialog({ title: "📚 Add to a topic", extra: box, confirm: "Done", cancel: "Close", variant: "sheet" });
  renderTopic();
}
