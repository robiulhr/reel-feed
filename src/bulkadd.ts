/**
 * Add many Facebook videos at once: paste links (one per line, or a whole message with links in it),
 * or come from the browser extension (the app opened at "#add=…"). Each link is looked up like a
 * single add; ones you already added are left out. Each video shows its title and caption and has
 * its own categories and lists (starting from the guess); "For all selected" sets them on many.
 * Loaded only when used (its own small file).
 */
import { type CatId, catLabel, detectLang, isCat } from "./categories";
import { catChooser } from "./catpicker";
import { btn, compact, el, nowSec } from "./dom";
import { fbIdFromLink, fbThumbUrl } from "./fbdata";
import { refreshManual } from "./feed";
import { listLabel, LISTS_EVENT } from "./lists";
import { type FbMeta, lookupFb, savePage } from "./manual";
import { act, fbShortId, type ManualVideo, state } from "./store";
import { confirmDialog, toast } from "./ui";

const MAX = 60;
const AT_ONCE = 3; // lookups running together (each asks Facebook a few times)

/** Facebook links in any text (a list, a message, the extension's hand-over). */
export function linksIn(text: string): string[] {
  const found = text.match(/https?:\/\/(?:[\w-]+\.)?(?:facebook\.com|fb\.com|fb\.watch)\/[^\s"'<>,]+/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of found) {
    const id = fbIdFromLink(l);
    const k =
      id ??
      l
        .replace(/[?#].*$/, "")
        .replace(/\/$/, "")
        .toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/** The caption without the title it starts with (the title is shown above it). */
function descOf(m: FbMeta): string {
  const cap = (m.caption ?? "").trim();
  const t = (m.title ?? "").trim();
  return (t && cap.startsWith(t) ? cap.slice(t.length) : cap).trim();
}

interface Row {
  link: string;
  state: "wait" | "ok" | "dup" | "err";
  meta?: FbMeta;
  id?: string;
  error?: string;
  pick: boolean;
  cats: CatId[];
  lists: Set<string>;
  open: boolean; // its own categories & lists editor is showing
  el: HTMLElement;
}

/** Toggle chips for your lists. */
function listChips(on: Set<string>, label: string, onChange: (id: string, now: boolean) => void): HTMLElement {
  const row = el("div", "catpick-chips");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", label);
  for (const l of state.lists) {
    const b = btn(
      listLabel(l),
      () => {
        if (on.has(l.id)) on.delete(l.id);
        else on.add(l.id);
        b.classList.toggle("on", on.has(l.id));
        b.setAttribute("aria-pressed", String(on.has(l.id)));
        onChange(l.id, on.has(l.id));
      },
      "chip",
    );
    b.classList.toggle("on", on.has(l.id));
    b.setAttribute("aria-pressed", String(on.has(l.id)));
    row.append(b);
  }
  if (!state.lists.length) row.append(el("span", "ch-note", "No lists yet"));
  return row;
}

export async function fbBulkDialog(initial: string[] = []): Promise<boolean> {
  const box = el("div", "fbadd fbbulk");
  const area = el("textarea", "ch-search fb-note");
  area.rows = 4;
  area.placeholder = "Paste Facebook video links — one per line, or a whole message with links in it";
  area.setAttribute("aria-label", "Facebook video links");
  area.dataset.ownEnter = "1";
  area.value = initial.join("\n");
  const lookBtn = btn("Look them up", () => void start(), "btn sm primary");
  const status = el("p", "ch-note fb-status");
  status.setAttribute("aria-live", "polite");

  const tools = el("div", "fbbulk-tools");
  tools.append(
    btn("Select all", () => setAll(true)),
    btn("Select none", () => setAll(false)),
  );
  tools.hidden = true;
  const list = el("div", "fbbulk-list");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Videos to add");

  // For all selected: what you pick here is put on every ticked video straight away (each video can
  // still be changed on its own afterwards). Videos still loading take it when they arrive.
  const allBox = el("details", "fbbulk-all");
  allBox.hidden = true;
  let allCats: CatId[] = [];
  const allLists = new Set<string>();
  const allNote = el("p", "ch-note");
  allNote.setAttribute("aria-live", "polite");
  const sayApplied = () => {
    const n = rows.filter(addable).length;
    allNote.textContent = `Put on ${n} selected video${n === 1 ? "" : "s"}.`;
  };
  const allChooser = catChooser({
    current: [],
    emptyLabel: "Nothing picked",
    onChange: (c) => {
      allCats = c;
      if (!c.length) return; // unticking everything leaves the videos as they are
      for (const r of rows.filter(addable)) {
        r.cats = [...c];
        draw(r);
      }
      update();
      sayApplied();
    },
  });
  allBox.append(
    el("summary", "fbf-label", "Set categories & lists for all selected"),
    el(
      "p",
      "ch-note",
      "Pick here and it goes on every ticked video right away (categories replace theirs; lists are added or taken off). You can still change any video on its own.",
    ),
    allChooser.box,
    listChips(allLists, "Lists for all selected", (id, on) => {
      for (const r of rows.filter(addable)) {
        if (on) r.lists.add(id);
        else r.lists.delete(id);
        draw(r);
      }
      update();
      sayApplied();
    }),
    allNote,
  );

  box.append(area, lookBtn, status, tools, allBox, list);

  let rows: Row[] = [];
  let saveBtn: HTMLButtonElement | null = null;
  let run = 0;

  const addable = (r: Row) => r.pick && (r.state === "ok" || (r.state === "err" && !!r.id));

  function update() {
    const go = rows.filter(addable);
    const noCat = go.filter((r) => !r.cats.length).length;
    const waiting = rows.filter((r) => r.state === "wait").length;
    const dups = rows.filter((r) => r.state === "dup").length;
    const bits = [
      waiting ? `Looking up ${waiting}…` : "",
      rows.length ? `${go.length} selected of ${rows.length}` : "",
      dups ? `${dups} already added` : "",
      noCat ? `${noCat} need a category` : "",
    ].filter(Boolean);
    status.textContent = bits.join(" · ");
    if (saveBtn) {
      saveBtn.disabled = !go.length || noCat > 0 || waiting > 0;
      saveBtn.textContent = go.length ? `Add ${go.length}` : "Add";
    }
  }

  function setAll(on: boolean) {
    for (const r of rows) if (r.state !== "dup" && r.state !== "wait") r.pick = on && (r.state === "ok" || !!r.id);
    for (const r of rows) draw(r);
    update();
  }

  function draw(r: Row) {
    const m = r.meta;
    const row = r.el;
    const had = r.state === "dup" ? state.manual.find((x) => x.id === r.id) : undefined;
    const title = m?.title || had?.t || (r.state === "wait" ? "Looking it up…" : r.link);
    row.className = `fbbulk-row st-${r.state}${r.pick ? " on" : ""}`;
    const check = el("input") as HTMLInputElement;
    check.type = "checkbox";
    check.checked = r.pick;
    check.disabled = r.state === "dup" || r.state === "wait" || (r.state === "err" && !r.id);
    check.setAttribute("aria-label", `Add ${title}`);
    check.onchange = () => {
      r.pick = check.checked;
      row.classList.toggle("on", r.pick);
      update();
    };
    const img = el("img") as HTMLImageElement;
    img.alt = "";
    img.loading = "lazy";
    if (r.id) img.src = fbThumbUrl(fbShortId(r.id));
    img.onerror = () => img.removeAttribute("src");
    const info = el("div", "fbbulk-info");
    info.append(el("div", "fbbulk-title", title));
    const desc = m ? descOf(m) : "";
    if (desc) info.append(el("div", "fbbulk-desc", desc));
    const sub =
      r.state === "dup"
        ? "Already added"
        : r.state === "err"
          ? `${r.error ?? "Couldn't look it up"}${r.id ? " — it can still be added" : ""}`
          : r.state === "ok" && m
            ? [m.page?.name, m.views ? `${compact(m.views)} views` : "", m.reactions ? `${compact(m.reactions)} reactions` : ""]
                .filter(Boolean)
                .join(" · ")
            : "";
    if (sub) info.append(el("div", "ch-note", sub));
    const label = el("label", "fbbulk-pick");
    label.append(check, img, info);
    row.replaceChildren(label);
    const watch = r.id ? watchBtn(r, title) : null;
    if (r.state !== "ok" && !(r.state === "err" && r.id)) {
      if (!watch) return;
      const t = el("div", "fbbulk-tags");
      t.append(watch);
      row.append(t);
      if (watching === r) row.append(playerOf(r));
      return;
    }

    // its own categories and lists
    const tags = el("div", "fbbulk-tags");
    if (watch) tags.append(watch);
    const names = [...r.cats.map(catLabel), ...state.lists.filter((l) => r.lists.has(l.id)).map(listLabel)];
    tags.append(el("span", r.cats.length ? "ch-note" : "ch-note fbbulk-warn", names.length ? names.join(" · ") : "No category yet"));
    const edit = btn(r.open ? "Done" : "✎ Categories & lists", () => {
      r.open = !r.open;
      draw(r);
    });
    edit.setAttribute("aria-expanded", String(r.open));
    edit.setAttribute("aria-label", `${r.open ? "Done with" : "Change"} categories and lists for ${title}`);
    tags.append(edit);
    row.append(tags);
    if (watching === r) row.append(playerOf(r));
    if (r.open) {
      const ed = el("div", "fbbulk-edit");
      const cc = catChooser({
        current: r.cats,
        emptyLabel: "Pick at least one",
        onChange: (c) => {
          r.cats = c;
          update();
        },
      });
      ed.append(
        cc.box,
        el("div", "fbf-label", "Lists"),
        listChips(r.lists, `Lists for ${title}`, () => {}),
      );
      row.append(ed);
    }
  }

  // Watch one right here (Facebook's own embedded player), one at a time
  let watching: Row | null = null;
  function watchBtn(r: Row, title: string) {
    const b = btn(watching === r ? "■ Stop" : "▶ Watch", () => {
      const was = watching;
      watching = watching === r ? null : r;
      if (was && was !== r) draw(was);
      draw(r);
      if (watching === r) r.el.querySelector(".fbbulk-player")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    b.setAttribute("aria-label", `${watching === r ? "Stop" : "Watch"} ${title}`);
    b.setAttribute("aria-expanded", String(watching === r));
    return b;
  }
  function playerOf(r: Row): HTMLElement {
    const box = el("div", "fbbulk-player");
    const f = el("iframe");
    const href = r.meta?.url ?? `https://www.facebook.com/reel/${r.id}/`;
    f.src = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(href)}&show_text=false&autoplay=true&width=270`;
    f.title = "Facebook video";
    f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
    f.setAttribute("allowfullscreen", "");
    box.append(f);
    return box;
  }

  async function lookOne(r: Row, n: number) {
    const res = await lookupFb(r.link);
    if (n !== run) return;
    if ("error" in res) {
      r.state = "err";
      r.error = res.error;
      r.pick = !!r.id;
    } else {
      r.meta = res;
      r.id = res.id;
      r.cats = (res.cats ?? []).filter((c): c is CatId => isCat(c)); // its guess; change it if you like
      const dup = state.manual.some((x) => x.id === res.id) || rows.some((o) => o !== r && o.id === res.id && o.state === "ok");
      r.state = dup ? "dup" : "ok";
      r.pick = !dup;
      if (!dup) {
        // what was picked "for all selected" while it was loading goes on it too
        if (allCats.length) r.cats = [...allCats];
        for (const id of allLists) r.lists.add(id);
      }
    }
    draw(r);
    update();
  }

  async function start() {
    const links = linksIn(area.value);
    const n = ++run;
    list.replaceChildren();
    if (!links.length) {
      rows = [];
      status.textContent = "No Facebook links found — paste links like facebook.com/reel/…";
      update();
      return;
    }
    const extra = links.length - MAX;
    rows = links.slice(0, MAX).map((link) => {
      const id = fbIdFromLink(link) ?? undefined;
      const dup = !!id && state.manual.some((x) => x.id === id);
      return {
        link,
        id,
        state: dup ? "dup" : "wait",
        pick: false,
        cats: [],
        lists: new Set(),
        open: false,
        el: el("div", "fbbulk-row"),
      } as Row;
    });
    for (const r of rows) {
      draw(r);
      list.append(r.el);
    }
    tools.hidden = false;
    allBox.hidden = false;
    update();
    if (extra > 0) toast(`Only the first ${MAX} links — add the other ${extra} next time`);
    const queue = rows.filter((r) => r.state === "wait");
    const worker = async () => {
      for (let r = queue.shift(); r && n === run; r = queue.shift()) await lookOne(r, n);
    };
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
  }

  const ok = await confirmDialog({
    title: "Add several Facebook videos",
    extra: box,
    confirm: "Add",
    variant: "sheet",
    onOpen: (yes) => {
      saveBtn = yes;
      update();
      if (initial.length) void start();
      else area.focus();
    },
  });
  run++; // stop lookups still running
  const go = rows.filter(addable).filter((r) => r.cats.length);
  if (!ok || !go.length) return false;

  const now = Math.floor(nowSec());
  let added = 0;
  go.forEach((r, i) => {
    const id = r.id!;
    if (state.manual.some((x) => x.id === id)) return;
    const m = r.meta;
    const by = m?.page ? savePage(m.page.name, m.page.path ? `https://www.facebook.com${m.page.path}` : "") : "";
    const v: ManualVideo = {
      id,
      url: m?.url ?? r.link.split("?")[0],
      t: m?.title ?? "",
      note: "",
      by,
      cats: r.cats,
      lists: state.lists.filter((l) => r.lists.has(l.id)).map((l) => l.id),
      lg: detectLang(`${m?.title ?? ""} ${m?.caption ?? ""}`),
      at: now - i, // keeps the order you saw them in (newest first)
      v: m?.views ?? 0,
      l: m?.reactions ?? 0,
    };
    act({ t: "manAdd", v });
    added++;
  });
  refreshManual();
  window.dispatchEvent(new Event(LISTS_EVENT));
  const skipped = rows.filter((r) => r.state === "dup").length;
  toast(`Added ${added} ✓${skipped ? ` — ${skipped} you had already` : ""}. They're on the Added page.`);
  return added > 0;
}
