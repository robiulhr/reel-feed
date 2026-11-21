/**
 * Channels control panel: list, search, filter, sort, add (with YouTube lookup), change category,
 * hide (personal), remove (soft — restorable any time), delete permanently (only after removing),
 * and "Refresh now".
 *
 * The channel list itself is channels.json in the code repo; edits go through the sync Worker,
 * which commits them (and the commit starts a refresh automatically).
 */
import { CATS } from "./rank";
import { act, state } from "./store";
import * as sync from "./sync";
import { COST, confirmCost, noteSpend, spendToast } from "./quota";
import { busy, confirmDialog, latest, toastError } from "./ui";
import type { Channel, Dataset } from "./types";
import { el, btn } from "./dom";

export interface ChannelsCtx {
  ds: Dataset;
  toast(msg: string, action?: { label: string; run: () => void }): void;
  ago(sec: number): string;
  fmt(n: number): string;
  onFeedChange(): void; // a channel was removed/restored/re-categorised → refresh the queue
  explore(info: { id: string; name: string; handle: string; thumb: string; subs: number; suggestedCat?: string }): void;
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

export function addFromInfo(info: { name: string; handle: string; id: string; cat: string }) {
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
export function setCategory(handle: string, name: string, cat: string) {
  return change([{ t: "cat", h: handle, cat }], `${name} → ${CATS.find((c) => c.id === cat)?.label ?? cat}`);
}

interface Entry {
  name: string;
  handle: string;
  cat: string;
  id?: string;
  status?: "removed";
  addedAt?: string;
  removedAt?: string;
}
type Op =
  | { t: "add"; channel: { name: string; handle: string; id?: string; cat: string } }
  | { t: "remove"; h: string }
  | { t: "restore"; h: string }
  | { t: "delete"; h: string }
  | { t: "cat"; h: string; cat: string };

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
  suggestedCat: string;
}

type RowStatus = "active" | "noShorts" | "notFound" | "removed" | "pending";
const STATUS_LABEL: Record<RowStatus, string> = {
  active: "Active",
  noShorts: "No Shorts yet",
  notFound: "Not found",
  removed: "Removed",
  pending: "Waiting for refresh",
};
const CAT_OPTIONS = CATS.filter((c) => c.id !== "all");

// ---------- module state (survives re-opening the panel) ----------
let entries: Entry[] | null = null; // from GitHub (source of truth); null = not loaded
let loading = false;
let loadError = "";
const view = { q: "", cat: "all", status: "listed", sort: "name" };
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
    .filter((c) => c.st !== "external")
    .map((c) => ({ name: c.n, handle: c.h, cat: c.cat, ...(c.st === "removed" ? { status: "removed" as const } : {}) }));
}

function rowStatus(e: Entry, d: Channel | undefined): RowStatus {
  if (e.status === "removed") return "removed";
  if (!d || d.st === "removed" || d.st === "external") return "pending"; // just added — not in the feed data yet
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
        ex.cat = op.channel.cat;
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
    case "cat": {
      const c = find(op.h);
      if (c) c.cat = op.cat;
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
  if (op.t === "cat") d.cat = op.cat as Channel["cat"];
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
  dsBefore: { st: Channel["st"]; cat: Channel["cat"] }[];
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
    case "cat":
      return !!e && e.cat !== op.cat;
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
    dsBefore: ctx.ds.channels.map((c) => ({ st: c.st, cat: c.cat })),
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
    if (op.t === "cat") lastCat.set(lc(op.h), i);
  });
  return ops.filter((op, i) => op.t !== "cat" || lastCat.get(lc(op.h)) === i);
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
        c.cat = b.cat;
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
function setCat(e: Entry, cat: string) {
  change([{ t: "cat", h: e.handle, cat }], `${e.name} → ${CATS.find((c) => c.id === cat)?.label ?? cat}`);
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
      [["all", "All categories"], ...CAT_OPTIONS.map((x) => [x.id, x.label] as [string, string])],
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

  body.append(headEl, addEl, controls, listEl);
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
    const cat = el("select") as HTMLSelectElement;
    cat.setAttribute("aria-label", "Category");
    for (const x of CAT_OPTIONS) cat.append(new Option(x.label, x.id));
    cat.value = r.suggestedCat;
    const addBtn = btn(
      existing && existing.status === "removed" ? "Restore" : "Add",
      (b) =>
        busy(b, "Adding…", async () => {
          errNote.textContent = "";
          const ok = await change(
            [{ t: "add", channel: { name: r.name, handle: r.handle, id: r.id, cat: cat.value } }],
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
      () => ctx.explore({ id: r.id, name: r.name, handle: r.handle, thumb: r.thumb, subs: r.subs, suggestedCat: cat.value }),
      "btn sm",
    );
    row.append(el("span", "ch-note", "Category"), cat, addBtn, preview);
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

  const rows = list
    .map((e) => {
      const ch = d.get(lc(e.handle));
      return { e, ch, st: rowStatus(e, ch), hidden: hidden.has(lc(e.handle)) };
    })
    .filter(({ e, ch, st, hidden: isHidden }) => {
      if (q && !lc(`${e.name} ${e.handle} ${ch?.n ?? ""}`).includes(q)) return false;
      // A channel you just changed stays where it is (so the next row can't slide under your finger)
      if (sticky.has(lc(e.handle))) return true;
      if (view.cat !== "all" && e.cat !== view.cat) return false;
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

  listEl.append(el("p", "ch-note", `${rows.length} shown`));
  if (!rows.length) {
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
    const a = el("a", "", ch?.n || e.name) as HTMLAnchorElement;
    a.href = ytUrl(e.handle);
    a.target = "_blank";
    a.rel = "noopener";
    title.append(a, el("span", `pill st-${st}`, STATUS_LABEL[st]));
    if (isHidden && st !== "removed") title.append(el("span", "pill st-hidden", "Hidden"));
    const bits = [e.handle];
    if (ch?.subs) bits.push(`${ctx.fmt(ch.subs)} subs`);
    if (ch?.cnt) bits.push(`${ch.cnt} Shorts`);
    if (ch?.last) bits.push(`latest ${ctx.ago(ch.last)}`);
    const tv = taste(e.handle);
    if (tv) bits.push(`taste ${tv > 0 ? "+" : ""}${Math.round(tv * 10) / 10}`);
    main.append(title, el("div", "ch-sub", bits.join(" · ")));

    const actions = el("div", "ch-actions");
    if (st === "removed") {
      actions.append(
        btn("Restore", (b) => busy(b, "…", () => restoreChannel(e)), "btn sm"),
        btn("Delete", (b) => busy(b, "…", () => deleteChannel(e)), "btn sm danger"),
      );
    } else {
      const cat = el("select") as HTMLSelectElement;
      cat.setAttribute("aria-label", "Category");
      for (const x of CAT_OPTIONS) cat.append(new Option(x.label, x.id));
      cat.value = e.cat;
      cat.disabled = !canEdit;
      cat.onchange = () => setCat(e, cat.value);
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
    item.append(img, main, actions);
    listEl.append(item);
  }
}

/** Forget the cached list (e.g. after logging out). */
export function resetChannels() {
  entries = null;
  loadError = "";
}
