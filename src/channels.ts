/**
 * Channels control panel: list, search, filter, sort, add (with YouTube lookup), change categories,
 * hide (personal), remove (soft — restorable any time), delete permanently (only after removing),
 * and "Refresh now".
 *
 * The channel list itself is channels.json in the code repo; edits go through the sync Worker,
 * which commits them (and the commit starts a refresh automatically).
 */
import { CATEGORIES, type CatId, catLabel, normCats } from "./categories";
import { catSummary, pickCategories } from "./catpicker";
import { act, type FbPage, state } from "./store";
import * as sync from "./sync";
import { COST, confirmCost, noteSpend, spendToast } from "./quota";
import { busy, confirmDialog, latest, toastError } from "./ui";
import type { Channel, Dataset } from "./types";
import { el, btn } from "./dom";
import { listSummary, pickLists } from "./lists";
import { fbPagePicUrl, pageHref } from "./fbdata";
import { BASE } from "./router";

export interface ChannelsCtx {
  ds: Dataset;
  toast(msg: string, action?: { label: string; run: () => void }): void;
  ago(sec: number): string;
  fmt(n: number): string;
  onFeedChange(): void; // a channel was removed/restored/re-categorised → refresh the queue
  explore(info: { id: string; name: string; handle: string; thumb: string; subs: number; suggestedCats?: CatId[] }): void;
  openPage(chIndex: number): void; // a Facebook page's screen
  refreshPages(): void; // a Facebook page was renamed/removed → rebuild its channel
}

/** Called at startup so other screens (channel page, More like this) can add/remove channels too. */
export function initChannels(c: ChannelsCtx) {
  ctx = c;
}

/** Is this channel in your list? Uses the GitHub copy when loaded, otherwise the feed data. */
export function listStatus(handle: string, id?: string): "listed" | "removed" | "none" {
  const list = entries ?? fallbackEntries();
  const e = list.find((x) => lc(x.handle) === lc(handle) || (!!id && x.id === id));
  if (!e) {
    const d = ctx?.ds.channels.find((c) => c.st !== "external" && ((id && c.id === id) || lc(c.h) === lc(handle)));
    if (!d) return "none";
    return d.st === "removed" ? "removed" : "listed";
  }
  return e.status === "removed" ? "removed" : "listed";
}

export function addFromInfo(info: { name: string; handle: string; id: string; cats: CatId[] }) {
  return change([{ t: "add", channel: info }], `Added ${info.name} — its Shorts join your feed after the refresh (~3 min)`);
}
export function removeByHandle(handle: string, name: string) {
  return change([{ t: "remove", h: handle }], `Removed ${name}. Restore any time under Channels → Removed.`, {
    label: "Undo",
    run: () => change([{ t: "restore", h: handle }], `Restored ${name}`),
  });
}
export function restoreByHandle(handle: string, name: string) {
  return change([{ t: "restore", h: handle }], `Restored ${name}`);
}
export function setCategories(handle: string, name: string, cats: CatId[]) {
  return change([{ t: "cats", h: handle, cats }], `${name} → ${cats.map(catLabel).join(", ")}`);
}

/** Opens the picker for a channel's categories; saves if you change them. */
export async function editChannelCats(handle: string, name: string, current: CatId[]) {
  const cats = await pickCategories({
    title: `Categories for ${name}`,
    current,
    note: "A starting guess for this channel's Shorts. Each Short is still sorted by its own title, tags and description.",
  });
  if (cats && cats.join() !== current.join()) return setCategories(handle, name, cats);
  return false;
}

interface Entry {
  name: string;
  handle: string;
  cats?: string[];
  cat?: string; // old single category (lists saved before multi-category)
  id?: string;
  status?: "removed";
  addedAt?: string;
  removedAt?: string;
}
type Op =
  | { t: "add"; channel: { name: string; handle: string; id?: string; cats: CatId[] } }
  | { t: "remove"; h: string }
  | { t: "restore"; h: string }
  | { t: "delete"; h: string }
  | { t: "cats"; h: string; cats: CatId[] };

interface LookupResult {
  id: string;
  name: string;
  handle: string;
  thumb: string;
  subs: number;
  videos: number;
  desc: string;
  shorts: number;
  latestShort: number;
  suggestedCats?: string[];
  suggestedCat?: string; // older sync server
}

type RowStatus = "active" | "noShorts" | "notFound" | "removed" | "pending";
const STATUS_LABEL: Record<RowStatus, string> = {
  active: "Active",
  noShorts: "No Shorts yet",
  notFound: "Not found",
  removed: "Removed",
  pending: "Waiting for refresh",
};
const entryCats = (e: Entry) => normCats(e.cats, e.cat);
/** Categories picked for each lookup result before tapping Add. */
const addCats = new Map<string, CatId[]>();

// ---------- module state (survives re-opening the panel) ----------
let entries: Entry[] | null = null; // from GitHub (source of truth); null = not loaded
let loading = false;
let loadError = "";
const view = { q: "", cat: "all", status: "listed", sort: "name", src: "all" as "all" | "yt" | "fb" };
const add = { open: false, q: "", busy: false, pendingKey: "", msg: "", results: [] as LookupResult[], needsSearch: false };
const lookupCache = new Map<string, { results: LookupResult[]; needsSearch: boolean }>();
let runText = "";
const prevStatus = new Map<string, Channel["st"]>();

let ctx: ChannelsCtx;
let listEl: HTMLElement | null = null;
let headEl: HTMLElement | null = null;
let addEl: HTMLElement | null = null;

const lc = (s: string) => s.toLowerCase();
const ytUrl = (h: string) => (h.startsWith("@") ? `https://www.youtube.com/${h}` : `https://www.youtube.com/channel/${h}`);

function dsByHandle() {
  return new Map(ctx.ds.channels.map((c) => [lc(c.h), c] as const));
}

function fallbackEntries(): Entry[] {
  return ctx.ds.channels
    .filter((c) => c.st !== "external" && c.st !== "fb")
    .map((c) => ({ name: c.n, handle: c.h, cats: c.cats, ...(c.st === "removed" ? { status: "removed" as const } : {}) }));
}

function rowStatus(e: Entry, d: Channel | undefined): RowStatus {
  if (e.status === "removed") return "removed";
  if (!d || d.st === "removed" || d.st === "external" || d.st === "fb") return "pending"; // just added — not in the feed data yet
  return d.st;
}

// ---------- data ----------
async function loadEntries() {
  if (!sync.isConnected()) {
    entries = null;
    return;
  }
  loading = true;
  loadError = "";
  renderList();
  try {
    const r = await sync.call<{ data: Entry[] | null }>("/channels");
    entries = r.data ?? [];
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
    renderHead();
    renderList();
  }
}

async function loadRunStatus() {
  if (!sync.isConnected()) return;
  try {
    const { run } = await sync.call<{ run: null | { status: string; conclusion: string | null; startedAt: number } }>("/status");
    if (!run) runText = "";
    else if (run.status !== "completed") runText = `Refreshing now (started ${ctx.ago(run.startedAt)})…`;
    else runText = `Last refresh ${ctx.ago(run.startedAt)} · ${run.conclusion === "success" ? "✓ succeeded" : `✗ ${run.conclusion}`}`;
  } catch {
    runText = "";
  }
  renderHead();
}

/** Mirror of the server's rules, so the list updates instantly. */
function applyLocal(list: Entry[], op: Op) {
  const find = (h: string) => list.find((x) => lc(x.handle) === lc(h));
  switch (op.t) {
    case "add": {
      const ex = list.find((x) => lc(x.handle) === lc(op.channel.handle) || (op.channel.id && x.id === op.channel.id));
      if (ex) {
        delete ex.status;
        delete ex.cat;
        ex.cats = op.channel.cats;
      } else list.push({ ...op.channel, addedAt: new Date().toISOString() });
      break;
    }
    case "remove": {
      const c = find(op.h);
      if (c) c.status = "removed";
      break;
    }
    case "restore": {
      const c = find(op.h);
      if (c) delete c.status;
      break;
    }
    case "delete": {
      const c = find(op.h);
      if (c) list.splice(list.indexOf(c), 1);
      break;
    }
    case "cats": {
      const c = find(op.h);
      if (c) {
        delete c.cat;
        c.cats = op.cats;
      }
      break;
    }
  }
}

/** Effects on the feed right away (before the next refresh rebuilds the data). */
function applyFeed(op: Op) {
  const d = "h" in op ? dsByHandle().get(lc(op.h)) : undefined;
  if (!d) return;
  if (op.t === "remove") {
    prevStatus.set(d.h, d.st);
    d.st = "removed";
  }
  if (op.t === "restore") d.st = prevStatus.get(d.h) ?? (d.cnt ? "active" : "noShorts");
  if (op.t === "cats") {
    d.cats = op.cats;
    // Shorts whose own words said nothing follow the channel's main category straight away
    const i = ctx.ds.channels.indexOf(d);
    for (const s of ctx.ds.videos) if (s.ch === i && s.g) s.k = op.cats.slice(0, 1);
  }
  ctx.onFeedChange();
}

/** Why the last change failed (shown next to the button that was pressed, not only as a toast). */
export let lastChangeError = "";

/**
 * Channel changes go through a queue:
 *  - they show instantly (list + feed),
 *  - changes made within ~0.4 s of each other are combined into ONE save (= one GitHub commit,
 *    one refresh) — e.g. flicking through categories, or Remove on several channels,
 *  - saves are sent strictly one after another (never two at the same time),
 *  - a change that no longer makes sense (deleting something already gone, adding something already
 *    listed) is dropped instead of failing the whole save.
 */
interface Job {
  ops: Op[];
  success: string;
  undo?: { label: string; run: () => void };
  entriesBefore: Entry[];
  dsBefore: { st: Channel["st"]; cats: CatId[] }[];
  resolve: (ok: boolean) => void;
}
let jobs: Job[] = [];
/** Channels changed since you last searched/filtered — kept in place in the list. */
const sticky = new Set<string>();
/** Channel → time until its buttons unlock again after a change. */
const cooldown = new Map<string, number>();
let flushTimer: number | undefined;
let sending: Promise<void> = Promise.resolve();
const BATCH_MS = 400;

function stillValid(op: Op): boolean {
  const e = entries?.find((x) => "h" in op && lc(x.handle) === lc(op.h));
  switch (op.t) {
    case "add":
      return !entries?.some(
        (x) => (lc(x.handle) === lc(op.channel.handle) || (op.channel.id && x.id === op.channel.id)) && x.status !== "removed",
      );
    case "remove":
      return !!e && e.status !== "removed";
    case "restore":
      return !!e && e.status === "removed";
    case "delete":
      return !!e && e.status === "removed";
    case "cats":
      return !!e && entryCats(e).join() !== op.cats.join();
  }
}

async function change(ops: Op[], success: string, undo?: { label: string; run: () => void }): Promise<boolean> {
  const fail = (msg: string) => {
    lastChangeError = msg;
    toastError(msg);
    return false;
  };
  if (!sync.isConnected()) return fail("Log in first (Menu → Sync) to add or edit channels");
  if (!entries) await loadEntries();
  if (!entries) return fail(loadError || "Couldn't load the channel list — check your connection");
  ops = ops.filter(stillValid);
  if (!ops.length) return true; // already done (double tap)
  const job: Job = {
    ops,
    success,
    undo,
    resolve: () => {},
    entriesBefore: structuredClone(entries),
    dsBefore: ctx.ds.channels.map((c) => ({ st: c.st, cats: c.cats })),
  };
  for (const op of ops) {
    applyLocal(entries, op);
    applyFeed(op);
    const h = "h" in op ? op.h : op.channel.handle;
    sticky.add(lc(h));
    cooldown.set(lc(h), Date.now() + 700);
  }
  renderHead();
  renderList();
  const done = new Promise<boolean>((resolve) => (job.resolve = resolve));
  jobs.push(job);
  clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flush, BATCH_MS);
  return done;
}

function flush() {
  const batch = jobs;
  jobs = [];
  if (batch.length) sending = sending.then(() => send(batch));
}

/** Combine the batch's changes: later category changes replace earlier ones for the same channel. */
function combine(batch: Job[]): Op[] {
  const ops = batch.flatMap((j) => j.ops);
  const lastCat = new Map<string, number>();
  ops.forEach((op, i) => {
    if (op.t === "cats") lastCat.set(lc(op.h), i);
  });
  return ops.filter((op, i) => op.t !== "cats" || lastCat.get(lc(op.h)) === i);
}

async function send(batch: Job[]) {
  const ops = combine(batch);
  try {
    const r = await sync.call<{ data: Entry[] }>("/channels", { method: "POST", body: JSON.stringify({ ops }) });
    entries = r.data;
    for (const j of jobs) for (const op of j.ops) applyLocal(entries, op); // keep later, not-yet-sent changes visible
    lastChangeError = "";
    if (batch.length === 1) ctx.toast(batch[0].success, batch[0].undo);
    else ctx.toast(`Saved ${batch.length} changes ✓ — one refresh starts now`);
    runText = "Refresh starting — new data in about 3 minutes";
    for (const j of batch) j.resolve(true);
  } catch (e) {
    // Undo this batch's instant changes (list + feed), then show why, with a Try again button.
    entries = batch[0].entriesBefore;
    for (const j of jobs) for (const op of j.ops) applyLocal(entries, op);
    batch[0].dsBefore.forEach((b, i) => {
      const c = ctx.ds.channels[i];
      if (c) {
        c.st = b.st;
        c.cats = b.cats;
      }
    });
    ctx.onFeedChange();
    const msg = e instanceof Error ? e.message : "Couldn't save the change";
    lastChangeError = msg;
    toastError(msg, () => {
      for (const j of batch) change(j.ops, j.success, j.undo);
    });
    for (const j of batch) j.resolve(false);
  } finally {
    renderHead();
    renderList();
  }
}

// ---------- actions ----------
function removeChannel(e: Entry, d?: Channel) {
  const n = d?.cnt ?? 0;
  return change(
    [{ t: "remove", h: e.handle }],
    `Removed ${e.name}${n ? ` — ${n} Shorts left your feed` : ""}. Restore any time under "Removed".`,
    { label: "Undo", run: () => restoreChannel(e) },
  );
}
function restoreChannel(e: Entry) {
  return change([{ t: "restore", h: e.handle }], `Restored ${e.name}`);
}
async function deleteChannel(e: Entry) {
  const ok = await confirmDialog({
    title: `Delete ${e.name} permanently?`,
    body: "It disappears from the Removed list and can't be restored from the app (GitHub history still has it).",
    confirm: "Delete",
    danger: true,
  });
  if (ok) await change([{ t: "delete", h: e.handle }], `Deleted ${e.name} permanently`);
}
/** "Posts: Marketing 72% · Career 8%" — what the channel's Shorts are really about. */
export function mixText(ch: Channel | undefined) {
  if (!ch?.mix.length) return "";
  return `Posts: ${ch.mix
    .slice(0, 3)
    .map(([c, pct]) => `${catLabel(c)} ${pct}%`)
    .join(" · ")}`;
}
function toggleHide(h: string, hidden: boolean) {
  act({ t: hidden ? "unhide" : "hide", h });
  ctx.onFeedChange();
  renderList();
}
async function refreshNow() {
  try {
    await sync.call("/refresh", { method: "POST" });
    runText = "Refresh started — new Shorts in about 3 minutes";
    ctx.toast("Refresh started");
    setTimeout(loadRunStatus, 8000);
  } catch (e) {
    toastError(e instanceof Error ? e.message : "Couldn't start the refresh", () => refreshNow());
  }
  renderHead();
}

const looksDirect = (q: string) => /^@|youtube\.com|youtu\.be|^UC[\w-]{22}$/i.test(q.trim()) || /^[\w.-]{3,100}$/.test(q.trim());

async function doLookup(search: boolean) {
  const q = add.q.trim();
  if (!q) return;
  if (!sync.isConnected()) {
    add.msg = "Log in first (Menu → Sync) to look up channels.";
    renderAdd();
    return;
  }
  const key = `${search ? "s" : "d"}:${lc(q)}`;
  const cached = lookupCache.get(key);
  if (cached) {
    Object.assign(add, cached, { msg: "" });
    renderAdd();
    return;
  }
  if (search) {
    const ok = await confirmCost({
      title: `Search YouTube for channels named "${q}"`,
      cost: COST.nameSearch,
      alwaysAsk: true,
      detail: "Searching by name is the most expensive way to find a channel. Pasting its @handle or any link to it costs only 2–3 units.",
    });
    if (!ok) return;
  }
  if (add.busy && add.pendingKey === key) return; // same lookup already running (double tap)
  const tok = lookupReq.next();
  add.busy = true;
  add.pendingKey = key;
  add.msg = search ? "Searching YouTube…" : "Looking up…";
  add.results = [];
  renderAdd();
  try {
    const r = await sync.call<{ results: LookupResult[]; units: number; needsSearch: boolean; quota?: { used: number; budget: number } }>(
      "/lookup",
      {
        method: "POST",
        body: JSON.stringify({ q, search }),
      },
    );
    if (r.units) noteSpend(r.units, `${search ? "Channel search" : "Look up"} "${q.slice(0, 60)}"`, r.quota);
    lookupCache.set(key, { results: r.results, needsSearch: r.needsSearch || (!search && !r.results.length) });
    if (!lookupReq.isLatest(tok)) return; // you started a newer lookup — don't show this old answer
    if (r.units && search) ctx.toast(spendToast(r.units, r.quota, false));
    add.results = r.results;
    add.needsSearch = r.needsSearch || (!search && !r.results.length);
    add.msg = r.results.length
      ? `Found ${r.results.length} · used ${r.units} API unit${r.units === 1 ? "" : "s"}`
      : r.needsSearch
        ? ""
        : "No channel found with that handle or link.";
  } catch (e) {
    if (lookupReq.isLatest(tok)) add.msg = e instanceof Error ? e.message : "Lookup failed";
  } finally {
    if (lookupReq.isLatest(tok)) {
      add.busy = false;
      add.pendingKey = "";
      renderAdd();
    }
  }
}
const lookupReq = latest();

// ---------- rendering ----------
export function renderChannelsPanel(body: HTMLElement, c: ChannelsCtx) {
  ctx = c;
  headEl = el("div", "ch-head");
  addEl = el("div", "ch-add");
  const controls = el("div", "ch-controls");
  listEl = el("div", "ch-list");

  const search = el("input", "ch-search") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Search channels…";
  search.value = view.q;
  let t: number | undefined;
  search.oninput = () => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      view.q = search.value;
      sticky.clear();
      renderList();
    }, 120);
  };

  const sel = (options: [string, string][], value: string, onChange: (v: string) => void, label: string) => {
    const s = el("select") as HTMLSelectElement;
    s.setAttribute("aria-label", label);
    for (const [v, l] of options) s.append(new Option(l, v));
    s.value = value;
    s.onchange = () => {
      sticky.clear();
      onChange(s.value);
    };
    return s;
  };
  controls.append(
    search,
    sel(
      [["all", "All categories"], ...CATEGORIES.map((x) => [x.id, x.label] as [string, string])],
      view.cat,
      (v) => {
        view.cat = v;
        renderList();
      },
      "Category",
    ),
    sel(
      [
        ["listed", "In my list"],
        ["active", "Active"],
        ["noShorts", "No Shorts yet"],
        ["notFound", "Not found"],
        ["pending", "Waiting for refresh"],
        ["hidden", "Hidden by me"],
        ["removed", "Removed"],
      ],
      view.status,
      (v) => {
        view.status = v;
        renderList();
      },
      "Status",
    ),
    sel(
      [
        ["name", "Sort: Name"],
        ["subs", "Sort: Subscribers"],
        ["shorts", "Sort: Shorts in feed"],
        ["latest", "Sort: Latest upload"],
        ["taste", "Sort: Your taste"],
      ],
      view.sort,
      (v) => {
        view.sort = v;
        renderList();
      },
      "Sort",
    ),
  );

  // Channels and Facebook pages are one list; this narrows it to one platform
  const srcChips = el("div", "chips ch-src");
  srcChips.setAttribute("role", "group");
  srcChips.setAttribute("aria-label", "Show");
  const drawSrc = () => {
    srcChips.replaceChildren();
    for (const [id, label] of [
      ["all", "All"],
      ["yt", "📺 YouTube"],
      ["fb", "📘 Facebook"],
    ] as ["all" | "yt" | "fb", string][]) {
      const b = btn(
        label,
        () => {
          view.src = id;
          sticky.clear();
          drawSrc();
          renderList();
        },
        view.src === id ? "on" : "",
      );
      b.setAttribute("aria-pressed", String(view.src === id));
      srcChips.append(b);
    }
  };
  drawSrc();

  body.append(headEl, addEl, srcChips, controls, listEl);
  renderHead();
  renderAdd();
  renderList();
  if (sync.isConnected()) {
    if (!entries && !loading) loadEntries();
    loadRunStatus();
  }
}

function renderHead() {
  if (!headEl) return;
  const list = entries ?? fallbackEntries();
  const d = dsByHandle();
  const counts = { listed: 0, active: 0, noShorts: 0, removed: 0 };
  for (const e of list) {
    const s = rowStatus(e, d.get(lc(e.handle)));
    if (s === "removed") counts.removed++;
    else {
      counts.listed++;
      if (s === "active") counts.active++;
      if (s === "noShorts") counts.noShorts++;
    }
  }
  headEl.replaceChildren();
  const top = el("div", "ch-head-row");
  top.append(
    el(
      "p",
      "ch-counts",
      `${counts.listed} channels · ${counts.active} active · ${counts.noShorts} no Shorts yet${counts.removed ? ` · ${counts.removed} removed` : ""}`,
    ),
  );
  const actions = el("div", "ch-head-actions");
  actions.append(
    btn(
      add.open ? "Close" : "+ Add channel",
      () => {
        add.open = !add.open;
        renderHead();
        renderAdd();
      },
      "btn sm primary",
    ),
    btn("↻ Refresh now", (b) => busy(b, "Starting…", refreshNow)),
  );
  top.append(actions);
  headEl.append(top);
  const info = el(
    "p",
    "ch-note",
    `${runText ? `${runText} · ` : ""}Data from ${ctx.ago(ctx.ds.generatedAt)}${ctx.ds.units ? ` · last refresh used ~${ctx.ds.units} API units` : ""}`,
  );
  headEl.append(info);
  if (!sync.isConnected()) headEl.append(el("p", "ch-note warn", "View only — log in under Sync to add, remove or edit channels."));
  else if (loadError) headEl.append(el("p", "ch-note warn", loadError));
}

function renderAdd() {
  if (!addEl) return;
  addEl.replaceChildren();
  addEl.hidden = !add.open;
  if (!add.open) return;

  const form = el("form", "ch-add-form");
  const input = el("input") as HTMLInputElement;
  input.placeholder = "@handle, YouTube link, or channel name";
  input.value = add.q;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.oninput = () => {
    add.q = input.value;
    add.needsSearch = false;
    go.textContent = label();
  };
  const label = () => (add.q.trim() && !looksDirect(add.q) ? "Search YouTube" : "Look up");
  const go = btn(label(), () => {}, "btn sm primary");
  go.type = "submit";
  go.disabled = add.busy;
  form.onsubmit = (e) => {
    e.preventDefault();
    doLookup(!looksDirect(add.q));
  };
  form.append(input, go);
  addEl.append(form);
  addEl.append(
    el("p", "ch-note", "Handles and links cost 2–3 API units. A name search costs ~100 (of 10,000 per day), so it only runs when you ask."),
  );
  if (add.msg) addEl.append(el("p", "ch-note", add.msg));
  if (add.needsSearch && !add.busy) {
    addEl.append(btn(`Search YouTube for "${add.q.trim()}" (~100 units)`, (b) => busy(b, "Searching…", () => doLookup(true))));
  }
  setTimeout(() => {
    if (document.activeElement === document.body) input.focus();
  });

  const list = entries ?? fallbackEntries();
  for (const r of add.results) {
    const card = el("div", "ch-card");
    const img = el("img", "ch-card-img") as HTMLImageElement;
    img.src = r.thumb;
    img.alt = "";
    const main = el("div", "ch-main");
    const title = el("div", "ch-title");
    const a = el("a", "", r.name) as HTMLAnchorElement;
    a.href = ytUrl(r.handle);
    a.target = "_blank";
    a.rel = "noopener";
    title.append(a);
    main.append(
      title,
      el(
        "div",
        "ch-sub",
        `${r.handle} · ${ctx.fmt(r.subs)} subs · ${ctx.fmt(r.videos)} videos · ${r.shorts ? `${ctx.fmt(r.shorts)} Shorts` : "no Shorts"}${r.latestShort ? ` · latest Short ${ctx.ago(r.latestShort)}` : ""}`,
      ),
    );
    if (r.desc) main.append(el("p", "ch-desc", r.desc));

    const existing = list.find((e) => lc(e.handle) === lc(r.handle) || (e.id && e.id === r.id));
    if (existing && existing.status !== "removed") main.append(el("p", "ch-note warn", "Already in your list."));
    else if (existing) main.append(el("p", "ch-note", "This channel is in Removed — adding it restores it."));
    if (!r.shorts) main.append(el("p", "ch-note warn", "No Shorts yet. You can still add it — it'll appear once they post Shorts."));

    const row = el("div", "ch-card-actions");
    if (!addCats.has(r.id)) addCats.set(r.id, normCats(r.suggestedCats, r.suggestedCat));
    const picked = () => addCats.get(r.id) ?? [];
    const cat = btn(catSummary(picked(), "Pick categories"), async () => {
      const cats = await pickCategories({ title: `Categories for ${r.name}`, current: picked() });
      if (cats) {
        addCats.set(r.id, cats);
        cat.textContent = catSummary(cats);
      }
    });
    cat.setAttribute("aria-label", `Categories: ${catSummary(picked())}. Change`);
    const addBtn = btn(
      existing && existing.status === "removed" ? "Restore" : "Add",
      (b) =>
        busy(b, "Adding…", async () => {
          errNote.textContent = "";
          if (!picked().length) {
            errNote.textContent = "Pick at least one category first";
            return;
          }
          const ok = await change(
            [{ t: "add", channel: { name: r.name, handle: r.handle, id: r.id, cats: picked() } }],
            `Added ${r.name} — its Shorts appear after the refresh (~3 min)`,
          );
          if (ok) {
            add.results = add.results.filter((x) => x.id !== r.id);
            renderAdd();
          } else errNote.textContent = `Not added: ${lastChangeError}`;
        }),
      "btn sm primary",
    );
    if (existing && existing.status !== "removed") addBtn.disabled = true;
    const preview = btn(
      r.shorts ? "Preview Shorts" : "View channel",
      () => ctx.explore({ id: r.id, name: r.name, handle: r.handle, thumb: r.thumb, subs: r.subs, suggestedCats: picked() }),
      "btn sm",
    );
    row.append(cat, addBtn, preview);
    const errNote = el("p", "ch-note warn", "");
    main.append(row, errNote);
    card.append(img, main);
    addEl.append(card);
  }
}

function renderList() {
  if (!listEl) return;
  listEl.replaceChildren();
  if (loading && !entries) {
    listEl.append(el("p", "ch-note", "Loading channel list…"));
  }
  const list = entries ?? fallbackEntries();
  const d = dsByHandle();
  const hidden = new Set(state.hidden.map(lc));
  const q = lc(view.q.trim());

  const rows = (view.src === "fb" ? [] : list)
    .map((e) => {
      const ch = d.get(lc(e.handle));
      return { e, ch, st: rowStatus(e, ch), hidden: hidden.has(lc(e.handle)) };
    })
    .filter(({ e, ch, st, hidden: isHidden }) => {
      if (q && !lc(`${e.name} ${e.handle} ${ch?.n ?? ""}`).includes(q)) return false;
      // A channel you just changed stays where it is (so the next row can't slide under your finger)
      if (sticky.has(lc(e.handle))) return true;
      if (view.cat !== "all" && !entryCats(e).includes(view.cat as CatId)) return false;
      if (view.status === "listed") return st !== "removed";
      if (view.status === "hidden") return isHidden && st !== "removed";
      return st === view.status;
    });

  const taste = (h: string) => state.affCh[h] ?? 0;
  rows.sort((a, b) => {
    switch (view.sort) {
      case "subs":
        return (b.ch?.subs ?? 0) - (a.ch?.subs ?? 0);
      case "shorts":
        return (b.ch?.cnt ?? 0) - (a.ch?.cnt ?? 0);
      case "latest":
        return (b.ch?.last ?? 0) - (a.ch?.last ?? 0);
      case "taste":
        return taste(b.e.handle) - taste(a.e.handle);
      default:
        return a.e.name.localeCompare(b.e.name);
    }
  });

  const pages = view.src === "yt" ? [] : facebookPages(q, hidden);
  listEl.append(el("p", "ch-note", `${rows.length + pages.length} shown`));
  if (!rows.length && !pages.length) {
    listEl.append(el("p", "ch-note", "No channels match."));
    return;
  }

  const canEdit = sync.isConnected() && !!entries;
  for (const { e, ch, st, hidden: isHidden } of rows) {
    const item = el("div", `ch-item${st === "removed" ? " removed" : ""}`);
    const img = el("img", "ch-avatar") as HTMLImageElement;
    img.alt = "";
    img.loading = "lazy";
    if (ch?.thumb) img.src = ch.thumb;

    const main = el("div", "ch-main");
    const title = el("div", "ch-title");
    const name = ch?.n || e.name;
    // the name opens the channel in the app (its Shorts, lists…); "↗ YouTube" opens it on YouTube
    const openHere = () => ctx.explore({ id: ch?.id ?? e.id ?? "", name, handle: e.handle, thumb: ch?.thumb ?? "", subs: ch?.subs ?? 0 });
    const a = el("a", "", name) as HTMLAnchorElement;
    a.href = `${BASE}channel/${encodeURIComponent(e.handle)}`;
    a.onclick = (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      ev.preventDefault();
      openHere();
    };
    title.append(a, el("span", "pill st-yt", "📺 YouTube"), el("span", `pill st-${st}`, STATUS_LABEL[st]));
    if (isHidden && st !== "removed") title.append(el("span", "pill st-hidden", "Hidden"));
    const bits = [e.handle];
    if (ch?.subs) bits.push(`${ctx.fmt(ch.subs)} subs`);
    if (ch?.cnt) bits.push(`${ch.cnt} Shorts`);
    if (ch?.last) bits.push(`latest ${ctx.ago(ch.last)}`);
    const tv = taste(e.handle);
    if (tv) bits.push(`taste ${tv > 0 ? "+" : ""}${Math.round(tv * 10) / 10}`);
    main.append(title, el("div", "ch-sub", bits.join(" · ")));
    const mix = mixText(ch);
    if (mix) main.append(el("div", "ch-sub ch-mix", mix));

    const actions = el("div", "ch-actions");
    const yt = el("a", "btn sm", "↗ YouTube") as HTMLAnchorElement;
    yt.href = ytUrl(e.handle);
    yt.target = "_blank";
    yt.rel = "noopener";
    yt.setAttribute("aria-label", `Open ${name} on YouTube`);
    const open = btn("▶ Open", openHere, "btn sm");
    open.setAttribute("aria-label", `Open ${name} in the app`);
    const lists = btn(`📋 ${listSummary(e.handle)}`, async () => (await pickLists(e.handle, name)) && renderList(), "btn sm");
    lists.setAttribute("aria-label", `${listSummary(e.handle)} — change the lists for ${name}`);
    const nav = el("div", "ch-nav");
    nav.append(open, yt, lists);
    if (st === "removed") {
      actions.append(
        btn("Restore", (b) => busy(b, "…", () => restoreChannel(e)), "btn sm"),
        btn("Delete", (b) => busy(b, "…", () => deleteChannel(e)), "btn sm danger"),
      );
    } else {
      const cats = entryCats(e);
      const cat = btn(catSummary(cats), () => editChannelCats(e.handle, e.name, cats));
      cat.setAttribute("aria-label", `${catSummary(cats)} — change the categories for ${name}`);
      cat.disabled = !canEdit;
      actions.append(
        cat,
        btn(isHidden ? "Unhide" : "Hide", () => toggleHide(e.handle, isHidden), "btn sm"),
        btn("Remove", (b) => busy(b, "…", () => removeChannel(e, ch)), "btn sm danger"),
      );
    }
    if (!canEdit)
      actions.querySelectorAll("button").forEach((b) => {
        if (b.textContent !== "Hide" && b.textContent !== "Unhide") b.disabled = true;
      });
    // Short cooldown after a change, so a double tap can't immediately undo it (Remove → Restore)
    const coolUntil = cooldown.get(lc(e.handle)) ?? 0;
    if (coolUntil > Date.now()) {
      actions.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select").forEach((b) => {
        b.disabled = true;
      });
      window.setTimeout(renderList, coolUntil - Date.now() + 20);
    }
    main.append(nav);
    item.append(img, main, actions);
    listEl.append(item);
  }
  if (pages.length) {
    if (rows.length) listEl.append(el("div", "u-h", "Facebook pages"));
    for (const p of pages) listEl.append(facebookRow(p));
  }
}

// ---------- Facebook pages (the same list, with a 📘 badge) ----------
interface PageRow {
  i: number; // index in ds.channels
  handle: string; // "fb:…"
  name: string;
  page?: FbPage;
  videos: number;
  views: number;
  latest: number; // when the newest video was added (unix seconds)
  cats: CatId[]; // its videos' most common categories
  hidden: boolean;
}

/** Facebook pages that have videos in your library, filtered like the channels. */
function facebookPages(q: string, hidden: Set<string>): PageRow[] {
  if (!["listed", "active", "hidden"].includes(view.status)) return []; // the other statuses only mean something for YouTube channels
  const ds = ctx.ds;
  const stats = new Map<number, { n: number; v: number; at: number; cats: Map<CatId, number> }>();
  for (const s of ds.videos) {
    if (!s.fb || ds.channels[s.ch]?.st !== "fb") continue;
    const x = stats.get(s.ch) ?? { n: 0, v: 0, at: 0, cats: new Map() };
    x.n++;
    x.v += s.v;
    x.at = Math.max(x.at, s.p);
    for (const k of s.k) x.cats.set(k, (x.cats.get(k) ?? 0) + 1);
    stats.set(s.ch, x);
  }
  const out: PageRow[] = [];
  ds.channels.forEach((c, i) => {
    if (c.st !== "fb") return;
    const page = state.fbPages.find((p) => p.key === c.h);
    const x = stats.get(i);
    if (!x) return; // no video of its left in your library: nothing to show
    const name = page?.name || c.n;
    const isHidden = hidden.has(lc(c.h));
    if (q && !lc(`${name} ${c.h}`).includes(q)) return;
    if (view.status === "hidden" && !isHidden) return;
    if (view.cat !== "all" && !x?.cats.has(view.cat as CatId)) return;
    const cats = x ? ([...x.cats].sort((a, b) => b[1] - a[1]).map(([k]) => k) as CatId[]) : [];
    out.push({ i, handle: c.h, name, page, videos: x?.n ?? 0, views: x?.v ?? 0, latest: x?.at ?? 0, cats, hidden: isHidden });
  });
  const taste = (h: string) => state.affCh[h] ?? 0;
  out.sort((a, b) => {
    switch (view.sort) {
      case "shorts":
        return b.videos - a.videos;
      case "latest":
        return b.latest - a.latest;
      case "taste":
        return taste(b.handle) - taste(a.handle);
      default:
        return a.name.localeCompare(b.name);
    }
  });
  return out;
}

function facebookRow(p: PageRow) {
  const item = el("div", "ch-item");
  const img = el("img", "ch-avatar") as HTMLImageElement;
  img.alt = "";
  img.loading = "lazy";
  const pic = p.page ? fbPagePicUrl(p.page.url) : "";
  if (pic) img.src = pic;

  const main = el("div", "ch-main");
  const title = el("div", "ch-title");
  const openHere = () => ctx.openPage(p.i);
  const a = el("a", "", p.name) as HTMLAnchorElement;
  a.href = `${BASE}channel/${encodeURIComponent(p.handle)}`;
  a.onclick = (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    openHere();
  };
  title.append(a, el("span", "pill st-fb", "📘 Facebook"));
  if (p.hidden) title.append(el("span", "pill st-hidden", "Hidden"));
  const bits = [`${p.videos} video${p.videos === 1 ? "" : "s"} added`];
  if (p.views) bits.push(`${ctx.fmt(p.views)} views`);
  if (p.latest) bits.push(`latest ${ctx.ago(p.latest)}`);
  if (p.page?.ch) bits.push(`same as ${p.page.ch}`);
  main.append(title, el("div", "ch-sub", bits.join(" · ")));
  if (p.cats.length) main.append(el("div", "ch-sub ch-mix", p.cats.slice(0, 3).map(catLabel).join(" · ")));

  const nav = el("div", "ch-nav");
  const open = btn("▶ Open", openHere, "btn sm");
  open.setAttribute("aria-label", `Open ${p.name} in the app`);
  const fbLink = el("a", "btn sm", "↗ Facebook") as HTMLAnchorElement;
  fbLink.href = pageHref({ url: p.page?.url ?? "", name: p.name });
  fbLink.target = "_blank";
  fbLink.rel = "noopener";
  fbLink.setAttribute("aria-label", `Open ${p.name} on Facebook`);
  const lists = btn(`📋 ${listSummary(p.handle)}`, async () => (await pickLists(p.handle, p.name)) && renderList(), "btn sm");
  lists.setAttribute("aria-label", `${listSummary(p.handle)} — change the lists for ${p.name}`);
  nav.append(open, fbLink, lists);
  main.append(nav);

  const actions = el("div", "ch-actions");
  actions.append(
    btn("Rename", () => void renamePage(p), "btn sm"),
    btn(p.hidden ? "Unhide" : "Hide", () => toggleHide(p.handle, p.hidden), "btn sm"),
    btn("Remove", () => void removePage(p), "btn sm danger"),
  );
  item.append(img, main, actions);
  return item;
}

async function renamePage(p: PageRow) {
  const input = el("input", "ch-search") as HTMLInputElement;
  input.type = "text";
  input.value = p.name;
  input.setAttribute("aria-label", "Name of the page");
  input.dataset.ownEnter = "1";
  const ok = await confirmDialog({
    title: "Rename this page",
    extra: input,
    confirm: "Save",
    cancel: "Cancel",
    onOpen: () => input.select(),
  });
  const name = input.value.trim();
  if (!ok || !name || name === p.name) return;
  act({ t: "pageSet", p: { key: p.handle, name, url: p.page?.url ?? "", ch: p.page?.ch ?? "" } });
  ctx.refreshPages();
  renderList();
}

/** Takes the page's videos out of your library (they stay in the Facebook page itself, of course). Undo puts them back. */
async function removePage(p: PageRow) {
  const mine = state.manual.filter((m) => m.by === p.handle);
  const ok = await confirmDialog({
    title: `Remove ${p.name}?`,
    body: `This removes the ${mine.length} video${mine.length === 1 ? "" : "s"} you added from this page (also from Saved and your lists). Nothing changes on Facebook. You can Undo.`,
    confirm: "Remove",
    danger: true,
  });
  if (!ok) return;
  const copy = structuredClone(mine);
  for (const m of mine) act({ t: "manDel", id: m.id });
  ctx.refreshPages();
  ctx.onFeedChange();
  renderList();
  ctx.toast(`Removed ${p.name}`, {
    label: "Undo",
    run: () => {
      for (const m of copy) act({ t: "manAdd", v: m });
      ctx.refreshPages();
      ctx.onFeedChange();
      renderList();
    },
  });
}

/** Forget the cached list (e.g. after logging out). */
export function resetChannels() {
  entries = null;
  loadError = "";
}
