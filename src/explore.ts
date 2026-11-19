/**
 * Channel explorer: a page for any channel — in your list (free, Shorts already loaded) or not
 * (loaded on demand through the Worker: ~10 units, then free for 24 hours on every device).
 * Grid sorted Newest / Popular / Hidden gems; tap a Short to swipe through just this channel.
 */
import type { AppApi, ExternalChannelInfo } from "./app";
import { addFromInfo, listStatus, removeByHandle, restoreByHandle, setCategory } from "./channels";
import { COST, confirmCost, noteSpend, spendToast } from "./quota";
import { CATS } from "./rank";
import { act, state } from "./store";
import * as sync from "./sync";
import type { Channel, Short } from "./types";

type Sort = "newest" | "popular" | "gems";
interface MiniShort { id: string; t: string; p: number; v: number; l: number; c: number }
interface PreviewResponse {
  channel: { id: string; name: string; handle: string; thumb: string; subs: number; videos: number; desc: string; shorts: number; latestShort: number; suggestedCat: string };
  shorts: MiniShort[]; units: number; cached: boolean; fetchedAt: number; quota?: { used: number; budget: number };
}

const previews = new Map<string, PreviewResponse>(); // this session
let sortPref: Sort = "newest";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const btn = (label: string, onClick: () => void, cls = "btn sm") => {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
};
const ytUrl = (h: string, id: string) => (h.startsWith("@") ? `https://www.youtube.com/${h}/shorts` : `https://www.youtube.com/channel/${id}/shorts`);

function median(nums: number[]) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Sorted copy + "×N" factor for hidden gems (views vs the channel's typical Short). */
export function sortShorts(items: Short[], sort: Sort) {
  const med = Math.max(1, median(items.map((s) => s.v)));
  const ratio = (s: Short) => s.v / med;
  const list = [...items];
  if (sort === "newest") list.sort((a, b) => b.p - a.p);
  else if (sort === "popular") list.sort((a, b) => b.v - a.v);
  else list.sort((a, b) => ratio(b) - ratio(a) || b.v - a.v);
  return { list, ratio };
}

/** Thumbnail grid shared by the channel page and More like this. */
export function shortGrid(app: AppApi, items: Short[], onPlay: (i: number) => void, opts: { showChannel?: boolean; badge?: (s: Short) => string } = {}) {
  const grid = el("div", "sgrid");
  items.forEach((s, i) => {
    const card = el("button", "scard");
    card.type = "button";
    const img = el("img") as HTMLImageElement;
    img.loading = "lazy";
    img.alt = "";
    app.thumb(img, s.id);
    const views = el("span", "scard-views", `▶ ${app.fmt(s.v)}`);
    card.append(img, views);
    const b = opts.badge?.(s);
    if (b) card.append(el("span", "scard-badge", b));
    if (state.saved.includes(s.id)) card.append(el("span", "scard-saved", "♥"));
    const cap = el("span", "scard-cap", s.t);
    card.append(cap);
    if (opts.showChannel) card.append(el("span", "scard-ch", app.ds.channels[s.ch]?.n ?? ""));
    card.onclick = () => onPlay(i);
    grid.append(card);
  });
  return grid;
}

export function openChannel(app: AppApi, target: { chIndex?: number; info?: ExternalChannelInfo }, sort: Sort = sortPref) {
  const ds = app.ds;
  let chIndex = target.chIndex;
  if (chIndex === undefined && target.info) {
    const i = ds.channels.findIndex((c) => c.id === target.info!.id || c.h.toLowerCase() === target.info!.handle.toLowerCase());
    chIndex = i >= 0 ? i : undefined;
  }
  const ch: Channel | undefined = chIndex !== undefined ? ds.channels[chIndex] : undefined;
  const info: ExternalChannelInfo = ch
    ? { id: ch.id, name: ch.n, handle: ch.h, thumb: ch.thumb, subs: ch.subs, suggestedCat: ch.cat }
    : target.info!;
  const inLibrary = !!ch && ch.st !== "external" && ds.videos.some((v) => v.ch === chIndex);

  app.openPage(info.name, (body) => {
    const reopen = (s: Sort = sort) => openChannel(app, { chIndex, info }, s);
    const status = listStatus(info.handle, info.id);
    const preview = previews.get(info.id);

    // ---- header
    const head = el("div", "cp-head");
    const avatar = el("img", "cp-avatar") as HTMLImageElement;
    avatar.alt = "";
    if (info.thumb || preview?.channel.thumb) avatar.src = info.thumb || preview!.channel.thumb;
    const meta = el("div", "cp-meta");
    const name = el("a", "cp-name", info.name) as HTMLAnchorElement;
    name.href = ytUrl(info.handle, info.id);
    name.target = "_blank";
    name.rel = "noopener";
    const pill = el("span", `pill st-${status === "listed" ? "active" : status === "removed" ? "removed" : "pending"}`,
      status === "listed" ? "In your list" : status === "removed" ? "Removed" : "Not in your list");
    const hidden = state.hidden.some((h) => h.toLowerCase() === info.handle.toLowerCase());
    const titleRow = el("div", "cp-title-row");
    titleRow.append(name, pill);
    if (hidden) titleRow.append(el("span", "pill st-hidden", "Hidden"));
    const libCount = inLibrary ? ds.videos.filter((v) => v.ch === chIndex).length : 0;
    const stats = [info.handle, `${app.fmt(info.subs || preview?.channel.subs || 0)} subs`];
    if (inLibrary) stats.push(`${libCount} Shorts in your feed`);
    else if (preview) stats.push(`${app.fmt(preview.channel.shorts)} Shorts`);
    if (ch?.last) stats.push(`latest ${app.ago(ch.last)}`);
    meta.append(titleRow, el("div", "cp-sub", stats.join(" · ")));
    head.append(avatar, meta);
    body.append(head);

    // ---- actions
    const actions = el("div", "cp-actions");
    if (status === "listed") {
      const cat = el("select") as HTMLSelectElement;
      cat.setAttribute("aria-label", "Category");
      for (const c of CATS.filter((c) => c.id !== "all")) cat.append(new Option(c.label, c.id));
      cat.value = ch?.cat ?? "stories";
      cat.onchange = () => setCategory(info.handle, info.name, cat.value);
      actions.append(
        cat,
        btn(hidden ? "Unhide" : "Hide", () => { act({ t: hidden ? "unhide" : "hide", h: info.handle }); app.onFeedChange(); reopen(); }),
        btn("Remove", async () => { if (await removeByHandle(info.handle, info.name)) reopen(); }, "btn sm danger"),
      );
    } else if (status === "removed") {
      actions.append(btn("Restore to my list", async () => { if (await restoreByHandle(info.handle, info.name)) reopen(); }, "btn sm primary"));
    } else {
      const cat = el("select") as HTMLSelectElement;
      cat.setAttribute("aria-label", "Category");
      for (const c of CATS.filter((c) => c.id !== "all")) cat.append(new Option(c.label, c.id));
      cat.value = info.suggestedCat ?? preview?.channel.suggestedCat ?? "stories";
      actions.append(
        el("span", "ch-note", "Category"), cat,
        btn("+ Add to my list", async () => {
          if (await addFromInfo({ name: info.name, handle: info.handle, id: info.id, cat: cat.value })) reopen();
        }, "btn sm primary"),
      );
    }
    body.append(actions);

    // ---- Shorts
    let items: Short[] = [];
    if (inLibrary) {
      items = ds.videos.filter((v) => v.ch === chIndex);
    } else if (preview) {
      const idx = app.ensureChannel({ ...info, thumb: info.thumb || preview.channel.thumb, subs: info.subs || preview.channel.subs });
      items = preview.shorts.map((s) => ({ ...s, ch: idx, o: 0, e: 0, tr: 0, r: 0 }));
    } else {
      const box = el("div", "cp-load");
      box.append(
        el("p", "ch-note", "This channel isn't in your feed data, so its Shorts are loaded from YouTube when you ask."),
        el("p", "ch-note", `Cost: ~${COST.preview} units — free if it was opened in the last 24 hours on any of your devices.`),
      );
      const go = btn(`Load Shorts · ~${COST.preview} units`, async () => {
        if (!sync.isConnected()) { app.toast("Log in first (Menu → Sync)"); return; }
        if (!info.id) { app.toast("Unknown channel ID"); return; }
        if (!(await confirmCost({ title: `Load ${info.name}'s Shorts`, cost: COST.preview }))) return;
        go.disabled = true;
        go.textContent = "Loading…";
        try {
          const r = await sync.call<PreviewResponse>("/channel-shorts", { method: "POST", body: JSON.stringify({ id: info.id }) });
          previews.set(info.id, r);
          noteSpend(r.units, `Channel preview: ${info.name}`, r.quota);
          app.toast(spendToast(r.units, r.quota, r.cached));
          reopen();
        } catch (e) {
          app.toast(e instanceof Error ? e.message : "Couldn't load the channel");
          go.disabled = false;
          go.textContent = `Load Shorts · ~${COST.preview} units`;
        }
      }, "btn primary");
      box.append(go);
      body.append(box);
      return;
    }

    if (!items.length) {
      body.append(el("p", "ch-note", "No Shorts to show for this channel yet."));
      return;
    }

    const tabs = el("div", "cp-tabs");
    const labels: [Sort, string][] = [["newest", "Newest"], ["popular", "Popular"], ["gems", "Hidden gems"]];
    for (const [k, label] of labels) {
      const b = btn(label, () => { sortPref = k; reopen(k); }, `cp-tab${k === sort ? " on" : ""}`);
      tabs.append(b);
    }
    const { list, ratio } = sortShorts(items, sort);
    const play = (i: number) => app.playList(`${info.name} · ${labels.find(([k]) => k === sort)![1]}`, list, i, () => reopen(sort));
    tabs.append(btn("▶ Play all", () => play(0), "btn sm primary cp-playall"));
    body.append(tabs);
    if (sort === "gems") body.append(el("p", "ch-note", "Shorts that got far more views than this channel's typical Short (×N = times its usual)."));
    if (preview && !inLibrary) body.append(el("p", "ch-note", `Loaded ${app.ago(preview.fetchedAt)} · newest ${preview.shorts.length} Shorts`));
    body.append(shortGrid(app, list, play, { badge: sort === "gems" ? (s) => `×${ratio(s).toFixed(1)}` : undefined }));
  });
}
