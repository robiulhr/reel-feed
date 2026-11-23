/**
 * Add many Facebook videos at once: paste links (one per line, or a whole message with links in it),
 * or come from the browser extension (the app opened at "#add=…"). Each link is looked up like a
 * single add; ones you already added are left out. Categories and lists are picked once for all.
 * Loaded only when used (its own small file).
 */
import { type CatId, detectLang, isCat } from "./categories";
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

interface Row {
  link: string;
  state: "wait" | "ok" | "dup" | "err";
  meta?: FbMeta;
  id?: string;
  error?: string;
  pick: boolean;
  el: HTMLElement;
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
  const allBtn = btn("Select all", () => setAll(true));
  const noneBtn = btn("Select none", () => setAll(false));
  tools.append(allBtn, noneBtn);
  tools.hidden = true;
  const list = el("div", "fbbulk-list");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Videos to add");

  const cats = catChooser({
    current: [],
    emptyLabel: "Nothing picked — each video goes in the categories guessed from its caption",
    onChange: () => update(),
  });
  const lists = new Set<string>();
  const listRow = el("div", "catpick-chips");
  listRow.setAttribute("role", "group");
  listRow.setAttribute("aria-label", "Lists for these videos");
  for (const l of state.lists) {
    const b = btn(
      listLabel(l),
      () => {
        if (lists.has(l.id)) lists.delete(l.id);
        else lists.add(l.id);
        b.classList.toggle("on", lists.has(l.id));
        b.setAttribute("aria-pressed", String(lists.has(l.id)));
      },
      "chip",
    );
    b.setAttribute("aria-pressed", "false");
    listRow.append(b);
  }

  box.append(
    area,
    lookBtn,
    status,
    tools,
    list,
    el("div", "fbf-label", "Categories (for all of them)"),
    cats.box,
    el("div", "fbf-label", "Lists (optional, for all of them)"),
    listRow,
  );

  let rows: Row[] = [];
  let saveBtn: HTMLButtonElement | null = null;
  let run = 0;

  /** Categories a row would get: the ones you picked, else its own guess. */
  const catsFor = (r: Row): CatId[] => (cats.picked().length ? cats.picked() : (r.meta?.cats ?? []).filter((c): c is CatId => isCat(c)));
  const addable = (r: Row) => r.pick && (r.state === "ok" || (r.state === "err" && !!r.id));

  function update() {
    const go = rows.filter(addable);
    const noCat = go.filter((r) => !catsFor(r).length).length;
    const waiting = rows.filter((r) => r.state === "wait").length;
    const dups = rows.filter((r) => r.state === "dup").length;
    const bits = [
      waiting ? `Looking up ${waiting}…` : "",
      rows.length ? `${go.length} selected of ${rows.length}` : "",
      dups ? `${dups} already added` : "",
      noCat ? `${noCat} need a category — pick one below` : "",
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
      const dup = state.manual.some((x) => x.id === res.id) || rows.some((o) => o !== r && o.id === res.id && o.state === "ok");
      r.state = dup ? "dup" : "ok";
      r.pick = !dup;
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
      return { link, id, state: dup ? "dup" : "wait", pick: false, el: el("div", "fbbulk-row") } as Row;
    });
    for (const r of rows) {
      draw(r);
      list.append(r.el);
    }
    tools.hidden = false;
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
  const go = rows.filter(addable).filter((r) => catsFor(r).length);
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
      cats: catsFor(r),
      lists: state.lists.filter((l) => lists.has(l.id)).map((l) => l.id),
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
