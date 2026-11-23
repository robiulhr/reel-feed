/**
 * Facebook videos you add by pasting a link: the Add / Edit dialog (filled in from the link by the
 * app's server), the Added page (everything you added — separate from Saved), and a Facebook page's
 * own screen. The videos themselves become Shorts in fbdata.ts.
 */
import { type CatId, detectLang, GROUPS, type GroupId, groupOf, isCat } from "./categories";
import { catChooser } from "./catpicker";
import { clickable } from "./a11y";
import { ago, btn, compact, el, nowSec } from "./dom";
import { fallbackTitle, fbIdFromLink, fbPagePicUrl, fbThumbUrl, pageHref, pageKey } from "./fbdata";
import { app, feed, playList, refreshManual, renderSave } from "./feed";
import { listLabel, LISTS_EVENT, pickLists } from "./lists";
import { setFbPageOpener, shortGrid } from "./explore";
import { BASE } from "./router";
import { act, type FbPage, fbShortId, type ManualVideo, noteOf, state, writeNote } from "./store";
import type { Short } from "./types";
import { confirmDialog, toast } from "./ui";
import { undoable } from "./backup";

/** What the app's server found at a link (worker/src/fb.ts). */
export interface FbMeta {
  id: string;
  url: string;
  title: string;
  caption: string;
  views: number;
  reactions: number;
  page: { name: string; path: string } | null;
  embeddable: boolean;
  cats: CatId[]; // guessed by the app's server from the caption
}

export async function lookupFb(link: string): Promise<FbMeta | { error: string }> {
  try {
    const r = await fetch(`${BASE}api/fb/meta?url=${encodeURIComponent(link)}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    if (j && typeof j === "object") return j as FbMeta | { error: string };
    return { error: `The lookup didn't answer (${r.status})` };
  } catch {
    return { error: navigator.onLine ? "The lookup took too long — try again, or fill it in yourself" : "You're offline" };
  }
}

/** What the app's server found at a page link (worker/src/fb.ts). */
export interface FbPageMeta {
  name: string;
  path: string;
  followers: number;
  about: string;
}

export async function lookupPage(link: string): Promise<FbPageMeta | { error: string }> {
  try {
    const r = await fetch(`${BASE}api/fb/page?url=${encodeURIComponent(link)}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    if (j && typeof j === "object") return j as FbPageMeta | { error: string };
    return { error: `The lookup didn't answer (${r.status})` };
  } catch {
    return { error: navigator.onLine ? "The lookup took too long" : "You're offline" };
  }
}

/** A page's picture (its first letter until it loads, or when there's none). */
export function pageAvatar(p: { name: string; url: string } | undefined, cls = "cp-avatar fb-avatar") {
  const box = el("div", cls, (p?.name.trim()[0] ?? "f").toUpperCase());
  const src = p ? fbPagePicUrl(p.url) : "";
  if (src) {
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    img.onload = () => box.classList.add("pic");
    img.onerror = () => img.remove();
    img.src = src;
    box.append(img);
  }
  return box;
}

/** One of your YouTube channels with this name (to link a Facebook page to it). */
function channelNamed(name: string) {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return feed.ds.channels.find((c) => c.st !== "fb" && c.st !== "external" && c.st !== "removed" && c.n.trim().toLowerCase() === n);
}

const yourChannels = () =>
  feed.ds.channels.filter((c) => c.st !== "fb" && c.st !== "external" && c.st !== "removed").sort((a, b) => a.n.localeCompare(b.n));

let uid = 0;
function field(label: string, input: HTMLElement, hint = "") {
  const wrap = el("label", "fbf");
  const id = `fbf-${++uid}`;
  input.id = id;
  wrap.htmlFor = id;
  wrap.append(el("span", "fbf-label", label), input);
  if (hint) wrap.append(el("span", "ch-note", hint));
  return wrap;
}

/** Add a Facebook video (or edit one you added). Resolves true when saved. */
export async function fbVideoDialog(o: { edit?: ManualVideo; link?: string; page?: FbPage } = {}): Promise<boolean> {
  const ed = o.edit;
  let meta: Pick<FbMeta, "id" | "url" | "views" | "reactions" | "caption"> | null = ed
    ? { id: ed.id, url: ed.url, views: ed.v, reactions: ed.l, caption: "" }
    : null;
  // "Add a video from this page": the page is filled in already (unless the link turns out to be someone else's)
  const fromPage = ed ? undefined : o.page;
  const oldPage = ed ? state.fbPages.find((p) => p.key === ed.by) : fromPage;
  let catsTouched = !!ed;
  let saveBtn: HTMLButtonElement | null = null;

  const box = el("div", "fbadd");
  const link = el("input", "ch-search");
  link.type = "url";
  link.placeholder = "https://www.facebook.com/share/v/…";
  link.value = ed?.url ?? o.link ?? "";
  link.disabled = !!ed;
  link.dataset.ownEnter = "1";
  const status = el("p", "ch-note fb-status");
  status.setAttribute("aria-live", "polite");
  const preview = el("div", "fb-preview");
  const img = el("img");
  img.alt = "";
  const open = el("a", "btn sm", "▶ Watch on Facebook ↗");
  open.target = "_blank";
  open.rel = "noopener";
  preview.append(img, open);
  preview.hidden = true;

  const title = el("input", "ch-search");
  title.maxLength = 300;
  title.placeholder = "What it is, e.g. Ghorerbazar Eid offer ad";
  title.value = ed?.t ?? "";
  title.dataset.ownEnter = "1";
  const note = el("textarea", "ch-search fb-note");
  note.rows = 3;
  note.maxLength = 2000;
  note.placeholder = "Why you kept it, e.g. hook in the first 2 s — idea for our Black Friday reel";
  note.value = ed ? noteOf(fbShortId(ed.id)) : "";
  note.dataset.ownEnter = "1";

  const pageName = el("input", "ch-search");
  pageName.maxLength = 120;
  pageName.placeholder = "Facebook page or person";
  pageName.value = oldPage?.name ?? "";
  pageName.dataset.ownEnter = "1";
  const known = el("datalist");
  known.id = `fb-pages-${++uid}`;
  for (const p of state.fbPages) known.append(new Option(p.name));
  pageName.setAttribute("list", known.id);
  const pageUrl = el("input", "ch-search");
  pageUrl.type = "url";
  pageUrl.placeholder = "https://www.facebook.com/… (optional)";
  pageUrl.value = oldPage?.url ?? "";
  pageUrl.dataset.ownEnter = "1";
  const linkCh = el("select");
  linkCh.append(new Option("— Not one of my YouTube channels —", ""));
  for (const c of yourChannels()) linkCh.append(new Option(`${c.n} (${c.h})`, c.h));
  linkCh.value = oldPage?.ch ?? "";
  /** Typing a known page (or a channel's name) fills in what's known about it. */
  const fillPage = () => {
    const p = state.fbPages.find((x) => x.name.toLowerCase() === pageName.value.trim().toLowerCase());
    if (p) {
      if (!pageUrl.value) pageUrl.value = p.url;
      linkCh.value = p.ch;
    } else if (!linkCh.value) linkCh.value = channelNamed(pageName.value)?.h ?? "";
  };
  pageName.onchange = fillPage;

  // the page's picture + followers, looked up from its link
  const pageCard = el("div", "fb-pagecard");
  pageCard.setAttribute("aria-live", "polite");
  let autoName = "";
  const drawPageCard = (info = "") => {
    const url = pageUrl.value.trim();
    pageCard.replaceChildren();
    if (!url && !info) return;
    pageCard.append(pageAvatar({ name: pageName.value || "f", url }, "fb-avatar fb-pagepic"), el("span", "ch-note", info));
  };
  let pageLooking = 0;
  const lookPage = async () => {
    const v = pageUrl.value.trim();
    if (!v) return drawPageCard();
    if (!/^(https?:\/\/)?([\w-]+\.)?(facebook\.com|fb\.com)\//i.test(v)) return drawPageCard("That isn't a Facebook page link");
    if (!/^https?:/i.test(v)) pageUrl.value = `https://${v}`;
    const n = ++pageLooking;
    drawPageCard("Looking up the page…");
    const r = await lookupPage(pageUrl.value.trim());
    if (n !== pageLooking) return;
    if ("error" in r) return drawPageCard(r.error);
    pageUrl.value = `https://www.facebook.com${r.path}`;
    if (!pageName.value.trim() || pageName.value === autoName) {
      pageName.value = r.name;
      autoName = r.name;
      fillPage();
    }
    drawPageCard(
      [r.name, r.followers ? `${compact(r.followers)} followers` : "", r.about.split("\n")[0].slice(0, 80)].filter(Boolean).join(" · "),
    );
  };
  pageUrl.addEventListener("change", () => void lookPage());
  pageUrl.addEventListener("paste", () => setTimeout(() => void lookPage(), 0));
  pageUrl.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void lookPage();
    }
  };

  const cats = catChooser({
    current: ed?.cats ?? [],
    emptyLabel: "Pick at least one category",
    onChange: () => {
      catsTouched = true;
      check();
    },
  });
  const lists = new Set(ed?.lists ?? []);
  const listRow = el("div", "catpick-chips");
  listRow.setAttribute("role", "group");
  listRow.setAttribute("aria-label", "Lists for this video");
  for (const l of state.lists) {
    const b = btn(
      listLabel(l),
      () => {
        if (lists.has(l.id)) lists.delete(l.id);
        else lists.add(l.id);
        b.classList.toggle("on", lists.has(l.id));
        b.setAttribute("aria-pressed", String(lists.has(l.id)));
      },
      `chip${lists.has(l.id) ? " on" : ""}`,
    );
    b.setAttribute("aria-pressed", String(lists.has(l.id)));
    listRow.append(b);
  }

  const check = () => {
    if (saveBtn) saveBtn.disabled = !meta || !cats.picked().length;
  };
  const showPreview = () => {
    if (!meta) return;
    img.src = fbThumbUrl(fbShortId(meta.id));
    img.onerror = () => img.removeAttribute("src");
    open.href = meta.url;
    preview.hidden = false;
  };
  /** The server's guess from the caption, until you pick categories yourself. */
  const guess = (g: readonly string[]) => {
    const ok = g.filter((c): c is CatId => isCat(c));
    if (!catsTouched && ok.length) cats.set(ok);
    check();
  };

  // "Already added": a clear warning, with the video and a way to it (this dialog closes first)
  const dupBox = el("div", "fb-dup");
  dupBox.setAttribute("role", "alert");
  dupBox.hidden = true;
  const closeThen = (run: () => void) => {
    box.closest(".dlg")?.querySelector<HTMLButtonElement>(".dlg-actions .btn:not(.primary)")?.click();
    run(); // right away: what opens next takes over this dialog's Back step
  };
  const showDup = (m: ManualVideo) => {
    const s = feed.byId.get(fbShortId(m.id));
    const page = state.fbPages.find((p) => p.key === m.by);
    const acts = el("div", "fb-dup-acts");
    if (s) acts.append(btn("▶ Play it", () => closeThen(() => playList("Added", [s], 0)), "btn sm"));
    acts.append(btn("✎ Edit it", () => closeThen(() => void fbVideoDialog({ edit: m })), "btn sm"));
    dupBox.replaceChildren(
      el("strong", "", "⚠ You already added this video"),
      el("div", "fb-dup-what", [m.t || fallbackTitle(m), page?.name, `added ${ago(m.at)}`].filter(Boolean).join(" · ")),
      acts,
    );
    dupBox.hidden = false;
  };

  let looking = 0;
  let looked = ""; // the link last looked up: Enter, paste and leaving the box ("change") each ask, once is enough
  const look = async () => {
    const v = link.value.trim();
    if (ed || !v || v === looked) return;
    looked = v;
    const n = ++looking;
    const quick = fbIdFromLink(v);
    dupBox.hidden = true;
    // already added? (a direct link says at once; a share link after the lookup)
    const isDup = (id: string | null) => {
      const m = id ? state.manual.find((x) => x.id === id) : undefined;
      if (!m) return false;
      meta = null;
      status.textContent = "";
      preview.hidden = true;
      showDup(m);
      check();
      return true;
    };
    if (isDup(quick)) return;
    status.textContent = "Looking it up…";
    const r = await lookupFb(v);
    if (n !== looking) return;
    if (isDup("error" in r ? quick : r.id)) return;
    if ("error" in r) {
      looked = ""; // let Enter try again
      if (quick) {
        meta = { id: quick, url: v.split("?")[0], views: 0, reactions: 0, caption: "" };
        status.textContent = `${r.error}. You can still add it — fill in the rest yourself.`;
      } else {
        meta = null;
        status.textContent = r.error;
      }
    } else {
      meta = r;
      const bits = [
        r.page?.name,
        r.views ? `${compact(r.views)} views` : "",
        r.reactions ? `${compact(r.reactions)} reactions` : "",
      ].filter(Boolean);
      status.textContent = `Found${bits.length ? `: ${bits.join(" · ")}` : " the video"}.${r.embeddable ? "" : " Facebook says it can't be played in other apps — it will open on Facebook."}`;
      if (!title.value) title.value = r.title;
      const otherPage =
        !!fromPage &&
        !!r.page &&
        pageName.value === fromPage.name &&
        r.page.name.trim().toLowerCase() !== fromPage.name.trim().toLowerCase() &&
        !(r.page.path && fromPage.url.toLowerCase().replace(/\/$/, "").endsWith(r.page.path.toLowerCase()));
      if (otherPage) {
        pageUrl.value = "";
        linkCh.value = "";
      }
      if (r.page && (!pageName.value || otherPage)) {
        pageName.value = r.page.name;
        autoName = r.page.name;
        fillPage();
        if (r.page.path && !pageUrl.value) {
          pageUrl.value = `https://www.facebook.com${r.page.path}`;
          void lookPage();
        }
      }
    }
    showPreview();
    guess("cats" in r ? (r.cats ?? []) : []);
  };
  link.addEventListener("change", look);
  link.addEventListener("paste", () => setTimeout(look, 0));
  link.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void look();
    }
  };

  if (!ed) box.append(field("Facebook video link", link), status, dupBox);
  box.append(
    preview,
    field("Title", title, "Shown on the video. Paste the post's caption if you like."),
    field("Note (only you see it)", note),
    el("div", "fbf-label", "Who made it"),
    field("Page name", pageName),
    field("Page link", pageUrl, "Paste the page's link and its name and picture fill in."),
    pageCard,
    field("Same as my YouTube channel", linkCh, "Its videos then join that channel's feeds and lists."),
    el("div", "fbf-label", "Categories"),
    cats.box,
    el("div", "fbf-label", "Lists (optional)"),
    listRow,
  );
  box.append(known);
  if (ed) showPreview();
  if (oldPage?.url) drawPageCard(oldPage.name);

  const ok = await confirmDialog({
    title: ed ? "Edit Facebook video" : "Add a Facebook video",
    extra: box,
    confirm: ed ? "Save" : "Add",
    variant: "sheet",
    onOpen: (yes) => {
      saveBtn = yes;
      check();
      if (!ed && link.value) void look();
      else if (!ed) link.focus();
      else if (!pageName.value && !pageUrl.value)
        // added before its page could be found: try again
        void lookupFb(ed.url).then((r) => {
          if ("error" in r || !r.page || pageName.value || pageUrl.value) return;
          pageName.value = r.page.name;
          autoName = r.page.name;
          fillPage();
          if (r.page.path) {
            pageUrl.value = `https://www.facebook.com${r.page.path}`;
            void lookPage();
          } else drawPageCard(r.page.name);
        });
    },
  });
  if (!ok || !meta || !cats.picked().length) return false;

  // who made it
  const by = savePage(pageName.value, pageUrl.value, linkCh.value);
  const v: ManualVideo = {
    id: meta.id,
    url: meta.url,
    t: title.value.trim(),
    note: "", // the note lives in your notes (written below)
    by,
    cats: cats.picked(),
    lists: state.lists.filter((l) => lists.has(l.id)).map((l) => l.id),
    lg: detectLang(`${title.value} ${meta.caption}`),
    at: ed?.at ?? Math.floor(nowSec()),
    v: meta.views,
    l: meta.reactions,
  };
  act(ed ? { t: "manEdit", v } : { t: "manAdd", v });
  if (note.value.trim() !== noteOf(fbShortId(v.id)).trim()) writeNote(fbShortId(v.id), note.value.trim(), v.t);
  refreshManual();
  window.dispatchEvent(new Event(LISTS_EVENT)); // list feeds and chips may change
  toast(ed ? "Saved ✓" : "Added ✓ — it's in your feeds and on the Added page");
  return true;
}

/**
 * Saves who made a video (a page you have already is matched by name, then by address) and
 * returns its key for ManualVideo.by — "" when there's no name. `ch` undefined = keep its link.
 */
export function savePage(nameIn: string, urlIn: string, ch?: string): string {
  const name = nameIn.trim();
  if (!name) return "";
  const url = urlIn.trim();
  const key = state.fbPages.find((p) => p.name.toLowerCase() === name.toLowerCase())?.key ?? pageKey(name, url);
  const old = state.fbPages.find((p) => p.key === key);
  const page: FbPage = {
    key,
    name,
    url: /^https:\/\/([\w-]+\.)?facebook\.com\//i.test(url) ? url : (old?.url ?? ""),
    ch: ch ?? old?.ch ?? "",
  };
  if (!old || old.name !== page.name || old.url !== page.url || old.ch !== page.ch) act({ t: "pageSet", p: page });
  return key;
}

/** Delete an added video (also from Saved), with Undo. */
export function deleteManual(m: ManualVideo, after: () => void) {
  const savedAt = state.saved.indexOf(fbShortId(m.id));
  act({ t: "manDel", id: m.id });
  refreshManual();
  renderSave();
  after();
  undoable("Deleted", () => {
    act({ t: "manAdd", v: m });
    if (savedAt >= 0) act({ t: "save", id: fbShortId(m.id), i: savedAt });
    refreshManual();
    renderSave();
    after();
  });
}

export const openOnFacebook = (url: string) => window.open(url, "_blank", "noopener");

/** Add many Facebook videos at once (loaded only when used). Resolves true if any were added. */
export async function openBulkAdd(links: string[] = []): Promise<boolean> {
  const m = await import("./bulkadd");
  const ok = await m.fbBulkDialog(links);
  if (ok && addedShown?.body.isConnected) addedShown.rerender(); // the Added page is open: show them
  return ok;
}

// ---------- the Added page ----------
const addedFilter = { q: "", group: "" as GroupId | "", list: "", page: "" };
let addedShown: { body: HTMLElement; rerender: () => void } | null = null;

/** Everything you added (a Menu tab). `rerender` draws it again after a change. */
export function renderAdded(body: HTMLElement, rerender: () => void) {
  const f = addedFilter;
  addedShown = { body, rerender };
  body.append(btn("＋ Add a Facebook video", async () => (await fbVideoDialog()) && rerender(), "btn primary sv-play"));
  body.append(btn("＋ Add several at once", () => void openBulkAdd(), "btn sv-play"));
  const all = state.manual;
  if (!all.length) {
    body.append(
      el(
        "p",
        "ch-note",
        "Paste a Facebook video link to add it. It plays in your feeds like a Short — in its categories and lists — and stays here until you delete it. Saving it (♡) also puts it in Saved.",
      ),
    );
    return;
  }
  const short = (m: ManualVideo) => feed.byId.get(fbShortId(m.id));
  const pageOf = (m: ManualVideo) => state.fbPages.find((p) => p.key === m.by);
  const text = (m: ManualVideo) => `${m.t} ${noteOf(fbShortId(m.id))} ${pageOf(m)?.name ?? ""}`.toLowerCase();
  const inGroup = (m: ManualVideo, g: GroupId) => m.cats.some((c) => groupOf(c) === g);
  const inList = (m: ManualVideo, id: string) => {
    if (m.lists.includes(id)) return true;
    const p = pageOf(m);
    const l = state.lists.find((x) => x.id === id);
    const hs = [m.by, p?.ch ?? ""].filter(Boolean).map((h) => h.toLowerCase());
    return !!l && l.ch.some((h) => hs.includes(h.toLowerCase()));
  };
  const base = all.filter(
    (m) => (!f.q || text(m).includes(f.q.toLowerCase())) && (!f.page || m.by === f.page) && (!f.list || inList(m, f.list)),
  );
  const items = base.filter((m) => !f.group || inGroup(m, f.group));

  const head = el("div", "sv-head");
  const search = el("input", "ch-search");
  search.type = "search";
  search.placeholder = "Search title, note or page";
  search.setAttribute("aria-label", "Search added videos");
  search.value = f.q;
  let t: number | undefined;
  search.oninput = () => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      f.q = search.value.trim();
      rerender();
      const again = document.querySelector<HTMLInputElement>(".sv-head input[type=search]");
      again?.focus();
      again?.setSelectionRange(again.value.length, again.value.length);
    }, 250);
  };
  head.append(search);
  const pages = state.fbPages.filter((p) => all.some((m) => m.by === p.key));
  if (pages.length) {
    const sel = el("select");
    sel.setAttribute("aria-label", "Page");
    sel.append(new Option("All pages", ""));
    for (const p of pages) sel.append(new Option(p.name, p.key));
    sel.value = f.page;
    sel.onchange = () => {
      f.page = sel.value;
      rerender();
    };
    head.append(sel);
  }
  body.append(head);

  const chip = (label: string, on: boolean, run: () => void) => {
    const c = btn(label, run, `chip${on ? " on" : ""}`);
    c.setAttribute("aria-pressed", String(on));
    return c;
  };
  const listsHere = state.lists.filter((l) => all.some((m) => inList(m, l.id)) || l.id === f.list);
  if (listsHere.length) {
    const lRow = el("div", "cp-chips sv-chips");
    lRow.setAttribute("role", "group");
    lRow.setAttribute("aria-label", "Channel list");
    lRow.append(
      chip(`All added · ${all.length}`, !f.list, () => {
        f.list = "";
        rerender();
      }),
    );
    for (const l of listsHere)
      lRow.append(
        chip(listLabel(l), f.list === l.id, () => {
          f.list = f.list === l.id ? "" : l.id;
          rerender();
        }),
      );
    body.append(lRow);
  }
  const gRow = el("div", "cp-chips sv-chips");
  gRow.setAttribute("role", "group");
  gRow.setAttribute("aria-label", "Main category");
  gRow.append(
    chip(`All · ${base.length}`, !f.group, () => {
      f.group = "";
      rerender();
    }),
  );
  for (const g of GROUPS) {
    const n = base.filter((m) => inGroup(m, g.id)).length;
    if (n)
      gRow.append(
        chip(`${g.icon} ${g.label} · ${n}`, f.group === g.id, () => {
          f.group = f.group === g.id ? "" : g.id;
          rerender();
        }),
      );
  }
  body.append(gRow);

  const shorts = items.map(short).filter((s): s is Short => !!s);
  if (shorts.length) body.append(btn(`▶ Play these ${shorts.length}`, () => playList("Added", shorts, 0, rerender), "btn sv-play"));
  if (!items.length) {
    body.append(el("p", "ch-note", "Nothing you added matches these filters."));
    return;
  }
  const listEl = el("div", "fb-list");
  for (const m of items) {
    const s = short(m);
    const card = el("div", "fb-card");
    const play = clickable(
      el("div", "fb-card-play"),
      () => {
        if (s) playList("Added", shorts, Math.max(0, shorts.indexOf(s)), rerender);
      },
      `Play ${m.t || "this video"}`,
    );
    const img = el("img");
    img.loading = "lazy";
    img.alt = "";
    img.src = fbThumbUrl(fbShortId(m.id));
    img.onerror = () => img.removeAttribute("src");
    const info = el("div", "fb-card-info");
    info.append(el("div", "fb-card-title", m.t || fallbackTitle(m)));
    const p = pageOf(m);
    const sub = [p?.name, m.v ? `${compact(m.v)} views` : "", `added ${ago(m.at)}`].filter(Boolean).join(" · ");
    info.append(el("div", "ch-note", sub));
    const note = noteOf(fbShortId(m.id));
    if (note) info.append(el("div", "fb-card-note", `📝 ${note}`));
    play.append(img, info);
    const saved = state.saved.includes(fbShortId(m.id));
    const acts = el("div", "fb-card-acts");
    const save = btn(
      saved ? "♥ Saved" : "♡ Save",
      () => {
        act(saved ? { t: "unsave", id: fbShortId(m.id) } : { t: "save", id: fbShortId(m.id) });
        renderSave();
        rerender();
      },
      `btn sm${saved ? " on" : ""}`,
    );
    save.setAttribute("aria-pressed", String(saved));
    acts.append(
      save,
      btn("✎ Edit", async () => (await fbVideoDialog({ edit: m })) && rerender()),
      btn("↗ Facebook", () => openOnFacebook(m.url)),
    );
    if (p?.url) acts.append(btn("↗ Page", () => openOnFacebook(p.url)));
    acts.append(
      btn(
        "Delete",
        async () => {
          const sure = await confirmDialog({
            title: "Delete this video?",
            body: `"${m.t || fallbackTitle(m)}" leaves your feeds, the Added page${saved ? " and Saved" : ""}. You can undo right after.`,
            confirm: "Delete",
            danger: true,
          });
          if (sure) deleteManual(m, rerender);
        },
        "btn sm danger",
      ),
    );
    card.append(play, acts);
    listEl.append(card);
  }
  body.append(listEl);
}

// ---------- a Facebook page's own screen ----------
function openFbPage(chIndex: number) {
  const ch = feed.ds.channels[chIndex];
  if (!ch) return;
  const page = state.fbPages.find((p) => p.key === ch.h);
  const draw = () =>
    app.openPage(
      ch.n,
      (body) => {
        const items = feed.ds.videos.filter((v) => v.ch === chIndex);
        const head = el("div", "cp-head");
        const meta = el("div", "cp-meta");
        meta.append(
          el("div", "cp-name", ch.n),
          el(
            "div",
            "cp-sub",
            `${page ? "Facebook page" : "No page set — edit a video to add one"} · ${items.length} video${items.length === 1 ? "" : "s"} you added`,
          ),
        );
        head.append(pageAvatar(page), meta);
        const actions = el("div", "cp-actions");
        if (page) {
          actions.append(btn("↗ Open page on Facebook", () => openOnFacebook(pageHref(page)), "btn sm primary"));
          actions.append(btn(`📋 ${listsLabel(ch.h)}`, async () => (await pickLists(ch.h, ch.n)) && draw()));
        }
        actions.append(btn("＋ Add a video from this page", async () => (await fbVideoDialog({ page })) && draw()));
        body.append(head, actions);
        if (items.length)
          body.append(
            shortGrid(app, items, (i) => playList(ch.n, items, i, draw), {
              badge: undefined,
            }),
          );
      },
      { k: "channel", h: ch.h },
    );
  draw();
}
const listsLabel = (h: string) => {
  const ls = state.lists.filter((l) => l.ch.some((c) => c.toLowerCase() === h.toLowerCase()));
  if (!ls.length) return "Add to a list";
  return `${ls.map((l) => l.icon).join(" ")} ${ls.length === 1 ? ls[0].name : `${ls.length} lists`}`;
};
setFbPageOpener(openFbPage);
