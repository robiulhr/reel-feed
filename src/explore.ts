/**
 * Channel explorer: a page for any channel — in your list (free, Shorts already loaded) or not
 * (loaded on demand through the Worker: ~10 units, then free for 24 hours on every device).
 * Grid sorted Newest / Most viewed / Breakouts, filtered by category and time range;
 * tap a Short to swipe through just this channel.
 */
import type { AppApi, ExternalChannelInfo } from "./app";
import { type CatId, catInfo, catLabel, detectLang, normCats } from "./categories";
import { catSummary, pickCategories } from "./catpicker";
import { addFromInfo, editChannelCats, lastChangeError, listStatus, mixText, removeByHandle, restoreByHandle } from "./channels";
import { COST, confirmCost, noteSpend, spendToast } from "./quota";
import { videoCats } from "./rank";
import { act, state } from "./store";
import * as sync from "./sync";
import type { Channel, Dataset, Short } from "./types";
import { el, btn } from "./dom";
import { longCardEl } from "./longcard";
import { listSummary, listsOf, pickLists } from "./lists";
import { pageHref } from "./fbdata";

type Sort = "newest" | "popular" | "gems";
interface MiniShort {
  id: string;
  t: string;
  p: number;
  v: number;
  l: number;
  c: number;
}
interface PreviewResponse {
  channel: {
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
  };
  shorts: MiniShort[];
  units: number;
  cached: boolean;
  fetchedAt: number;
  quota?: { used: number; budget: number };
}

const previews = new Map<string, PreviewResponse>(); // this session
let sortPref: Sort = "newest";
/** Category + time range picked on the channel page (reset when you open another channel). */
const pageFilter = { handle: "", cat: "" as CatId | "", days: 0 };
/** Categories picked for a channel you're about to add. */
const addPick = new Map<string, CatId[]>();
const PERIODS: [number, string][] = [
  [0, "All time"],
  [365, "This year"],
  [30, "30 days"],
  [7, "7 days"],
];

const ytUrl = (h: string, id: string) =>
  h.startsWith("@") ? `https://www.youtube.com/${h}/shorts` : `https://www.youtube.com/channel/${id}/shorts`;

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
export function shortGrid(
  app: AppApi,
  items: Short[],
  onPlay: (i: number) => void,
  opts: { showChannel?: boolean; badge?: (s: Short) => string; picked?: ReadonlySet<string> } = {},
) {
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
    if (opts.picked) {
      // selecting: a tick on the ones picked (the card's tap picks it instead of playing it)
      const on = opts.picked.has(s.id);
      card.classList.toggle("sel", on);
      card.setAttribute("aria-pressed", String(on));
      card.append(el("span", on ? "scard-pick on" : "scard-pick", on ? "✓" : ""));
    }
    if (state.saved.includes(s.id)) card.append(el("span", "scard-saved", "♥"));
    if (state.notes[s.id]) card.append(el("span", "scard-note", "📝")); // you wrote a note on this one
    const cap = el("span", "scard-cap", s.t);
    card.append(cap);
    if (opts.showChannel) card.append(el("span", "scard-ch", app.ds.channels[s.ch]?.n ?? ""));
    card.onclick = () => onPlay(i);
    grid.append(card);
  });
  return grid;
}

/**
 * The grid of a page's or channel's videos with a ☑ Select button: pick several, then ✎ Edit changes their
 * categories (and Facebook videos' lists) all at once. `redraw` draws the screen again after a change.
 */
export function selectableGrid(
  app: AppApi,
  items: Short[],
  onPlay: (i: number) => void,
  opts: Parameters<typeof shortGrid>[3],
  redraw: () => void,
) {
  const wrap = el("div", "selwrap");
  const picked = new Set<string>();
  let selecting = false;
  const draw = () => {
    wrap.replaceChildren();
    const bar = el("div", "selbar");
    if (!selecting) {
      bar.append(
        btn(
          "☑ Select videos",
          () => {
            selecting = true;
            draw();
          },
          "btn sm",
        ),
      );
    } else {
      const count = el("span", "selbar-count", `${picked.size} selected`);
      count.setAttribute("aria-live", "polite");
      const edit = btn(
        `✎ Edit ${picked.size || ""}`.trim(),
        async () => {
          const chosen = items.filter((s) => picked.has(s.id));
          const m = await import("./bulkedit");
          if (await m.bulkEdit(chosen)) redraw();
        },
        "btn sm primary",
      );
      edit.disabled = !picked.size;
      bar.append(
        count,
        btn(
          "All",
          () => {
            for (const s of items) picked.add(s.id);
            draw();
          },
          "btn sm",
        ),
        btn(
          "None",
          () => {
            picked.clear();
            draw();
          },
          "btn sm",
        ),
        edit,
        btn(
          "Cancel",
          () => {
            selecting = false;
            picked.clear();
            draw();
          },
          "btn sm",
        ),
      );
    }
    wrap.append(
      bar,
      shortGrid(
        app,
        items,
        (i) => {
          if (!selecting) return onPlay(i);
          const id = items[i].id;
          if (picked.has(id)) picked.delete(id);
          else picked.add(id);
          draw();
        },
        { ...opts, picked: selecting ? picked : undefined },
      ),
    );
  };
  draw();
  return wrap;
}

/** A Facebook page's screen (manual.ts) — set there, so this module doesn't load it. */
let openFbPage: (chIndex: number) => void = () => {};
export const setFbPageOpener = (fn: (chIndex: number) => void) => {
  openFbPage = fn;
};

/** The long videos (Home's library) — set by home.ts, which loads them; so this module doesn't. */
export interface LongSource {
  ds: Dataset;
  open(s: Short, list: Short[]): void;
}
let longSource: () => Promise<LongSource | null> = async () => null;
export const setLongSource = (fn: () => Promise<LongSource | null>) => {
  longSource = fn;
};
const kind = { h: "", k: "shorts" as "shorts" | "videos" }; // which list the channel page shows
const clock = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const t = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${t(m)}:${t(Math.floor(sec % 60))}` : `${m}:${t(Math.floor(sec % 60))}`;
};

/** Long videos as the cards Home uses (thumbnail, length, title, views). */
export function longCards(app: AppApi, vids: Short[], open: (s: Short) => void, chOf?: (s: Short) => Channel | undefined): HTMLElement[] {
  return vids.map((s) => {
    const ch = chOf?.(s);
    return longCardEl({
      id: s.id,
      title: s.t,
      dur: s.d ? clock(s.d) : "",
      channel: ch?.n ?? "",
      avatar: ch?.thumb,
      rest: `${app.fmt(s.v)} views · ${app.ago(s.p)}`,
      thumb: app.thumb,
      open: () => open(s),
      openChannel: ch ? () => openChannelOf(app, ch) : undefined,
    });
  });
}

/** Opens a channel (by what the data knows of it) in the app. */
export function openChannelOf(app: AppApi, ch: Channel) {
  openChannel(app, { info: { id: ch.id, name: ch.n, handle: ch.h, thumb: ch.thumb, subs: ch.subs, suggestedCats: ch.cats } });
}

/** The channel's long videos, newest first, as the same cards Home uses. */
function drawVideos(app: AppApi, body: HTMLElement, info: ExternalChannelInfo) {
  const box = el("div", "cp-videos");
  box.append(el("p", "ch-note", "Loading videos…"));
  body.append(box);
  void longSource().then((src) => {
    if (!box.isConnected) return;
    const ci = src
      ? src.ds.channels.findIndex((c) => (info.id && c.id === info.id) || (info.handle && c.h.toLowerCase() === info.handle.toLowerCase()))
      : -1;
    const vids = src && ci >= 0 ? src.ds.videos.filter((v) => v.ch === ci).sort((a, b) => b.p - a.p) : [];
    if (!src || !vids.length) {
      box.replaceChildren(el("p", "ch-note", "No long videos from this channel in your library yet."));
      return;
    }
    const cards = longCards(app, vids, (s) => {
      app.closePage();
      src.open(s, vids);
    });
    const list = el("div", "cp-videos-l");
    list.append(...cards);
    box.replaceChildren(el("p", "ch-note", `${vids.length} long video${vids.length === 1 ? "" : "s"}`), list);
  });
}

export function openChannel(app: AppApi, target: { chIndex?: number; info?: ExternalChannelInfo }, sort: Sort = sortPref) {
  const ds = app.ds;
  let chIndex = target.chIndex;
  if (chIndex !== undefined && ds.channels[chIndex]?.st === "fb") return openFbPage(chIndex);
  if (chIndex === undefined && target.info) {
    const i = ds.channels.findIndex((c) => c.id === target.info!.id || c.h.toLowerCase() === target.info!.handle.toLowerCase());
    chIndex = i >= 0 ? i : undefined;
  }
  const ch: Channel | undefined = chIndex !== undefined ? ds.channels[chIndex] : undefined;
  const info: ExternalChannelInfo = ch
    ? { id: ch.id, name: ch.n, handle: ch.h, thumb: ch.thumb, subs: ch.subs, suggestedCats: ch.cats }
    : target.info!;
  const inLibrary = !!ch && ch.st !== "external" && ds.videos.some((v) => v.ch === chIndex);

  app.openPage(
    info.name,
    (body) => {
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
      const pill = el(
        "span",
        `pill st-${status === "listed" ? "active" : status === "removed" ? "removed" : "pending"}`,
        status === "listed" ? "In your list" : status === "removed" ? "Removed" : "Not in your list",
      );
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
      const mix = mixText(ch);
      if (mix) meta.append(el("div", "cp-sub", mix));
      head.append(avatar, meta);
      body.append(head);

      // ---- actions
      const actions = el("div", "cp-actions");
      let addError: HTMLElement | null = null;
      if (status === "listed") {
        const cats = ch?.cats ?? [];
        const cat = btn(`🏷 ${catSummary(cats)}`, async () => {
          if (await editChannelCats(info.handle, info.name, cats)) reopen();
        });
        cat.setAttribute("aria-label", `Categories: ${cats.map(catLabel).join(", ") || "none"}. Change`);
        actions.append(
          cat,
          btn(hidden ? "Unhide" : "Hide", () => {
            act({ t: hidden ? "unhide" : "hide", h: info.handle });
            app.onFeedChange();
            reopen();
          }),
          btn(
            "Remove",
            async () => {
              if (await removeByHandle(info.handle, info.name)) reopen();
            },
            "btn sm danger",
          ),
        );
      } else if (status === "removed") {
        actions.append(
          btn(
            "Restore to my list",
            async () => {
              if (await restoreByHandle(info.handle, info.name)) reopen();
            },
            "btn sm primary",
          ),
        );
      } else {
        const key = info.id || info.handle;
        if (!addPick.has(key) || (!addPick.get(key)!.length && preview))
          addPick.set(key, normCats(info.suggestedCats ?? preview?.channel.suggestedCats, preview?.channel.suggestedCat));
        const picked = () => addPick.get(key) ?? [];
        const cat = btn(`🏷 ${catSummary(picked(), "Pick categories")}`, async () => {
          const cats = await pickCategories({ title: `Categories for ${info.name}`, current: picked() });
          if (cats) {
            addPick.set(key, cats);
            cat.textContent = `🏷 ${catSummary(cats)}`;
          }
        });
        cat.setAttribute("aria-label", `Categories: ${catSummary(picked())}. Change`);
        const err = el("p", "ch-note warn", "");
        const addBtn = btn(
          "+ Add to my list",
          async () => {
            if (!picked().length) {
              err.textContent = "Pick at least one category first";
              return;
            }
            addBtn.disabled = true;
            addBtn.textContent = "Adding…";
            if (await addFromInfo({ name: info.name, handle: info.handle, id: info.id, cats: picked() })) {
              reopen();
              return;
            }
            addBtn.disabled = false;
            addBtn.textContent = "+ Add to my list";
            err.textContent = `Not added: ${lastChangeError}`;
          },
          "btn sm primary",
        );
        actions.append(cat, addBtn);
        addError = err;
      }
      const lists = btn(`📋 ${listSummary(info.handle)}`, async () => {
        if (await pickLists(info.handle, info.name)) reopen();
      });
      lists.setAttribute(
        "aria-label",
        `Lists: ${
          listsOf(info.handle)
            .map((l) => l.name)
            .join(", ") || "none"
        }. Change`,
      );
      actions.prepend(lists);
      // its Facebook page, when you linked one (videos you added from it show below with the Shorts)
      const fbPage = state.fbPages.find((p) => p.ch && p.ch.toLowerCase() === info.handle.toLowerCase());
      if (fbPage) actions.append(btn("↗ Facebook page", () => window.open(pageHref(fbPage), "_blank", "noopener")));
      body.append(actions);
      if (addError) body.append(addError);

      // ---- Shorts | Videos
      if (kind.h !== info.handle) Object.assign(kind, { h: info.handle, k: "shorts" });
      const kinds = el("div", "cp-tabs cp-kinds");
      for (const [k, label] of [
        ["shorts", "Shorts"],
        ["videos", "Videos"],
      ] as const) {
        const b = btn(
          label,
          () => {
            kind.k = k;
            reopen(sort);
          },
          `cp-tab${kind.k === k ? " on" : ""}`,
        );
        b.setAttribute("aria-pressed", String(kind.k === k));
        kinds.append(b);
      }
      body.append(kinds);
      if (kind.k === "videos") return drawVideos(app, body, info);

      // ---- Shorts
      let items: Short[] = [];
      if (inLibrary) {
        items = ds.videos.filter((v) => v.ch === chIndex);
      } else if (preview) {
        const idx = app.ensureChannel({ ...info, thumb: info.thumb || preview.channel.thumb, subs: info.subs || preview.channel.subs });
        items = preview.shorts.map((s) => ({ ...s, ch: idx, o: 0, e: 0, tr: 0, r: 0, k: [], lg: detectLang(s.t), g: true }));
      } else {
        const box = el("div", "cp-load");
        box.append(
          el("p", "ch-note", "This channel isn't in your feed data, so its Shorts are loaded from YouTube when you ask."),
          el("p", "ch-note", `Cost: ~${COST.preview} units — free if it was opened in the last 24 hours on any of your devices.`),
        );
        const go = btn(
          `Load Shorts · ~${COST.preview} units`,
          async () => {
            if (!sync.isConnected()) {
              app.toast("Log in first (Menu → Sync)");
              return;
            }
            if (!info.id) {
              app.toast("Unknown channel ID");
              return;
            }
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
          },
          "btn primary",
        );
        box.append(go);
        body.append(box);
        return;
      }

      if (!items.length) {
        body.append(el("p", "ch-note", "No Shorts to show for this channel yet."));
        return;
      }

      // ---- filters: category (only ones this channel has) + time range
      if (pageFilter.handle !== info.handle) Object.assign(pageFilter, { handle: info.handle, cat: "", days: 0 });
      const counts = new Map<CatId, number>();
      for (const s of items) for (const c of videoCats(s, state)) counts.set(c, (counts.get(c) ?? 0) + 1);
      const catsHere = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
      if (pageFilter.cat && !counts.has(pageFilter.cat)) pageFilter.cat = "";
      const filters = el("div", "cp-filters");
      let chipRow: HTMLElement | null = null;
      if (catsHere.length > 1) {
        const chips = el("div", "cp-chips");
        chips.setAttribute("role", "group");
        chips.setAttribute("aria-label", "Category");
        for (const [id, label] of [["", "All"], ...catsHere.map(([c, n]) => [c, `${catInfo(c)?.short ?? c} · ${n}`])] as [
          CatId | "",
          string,
        ][]) {
          const b = btn(
            label,
            () => {
              pageFilter.cat = id;
              reopen(sort);
            },
            `chip${pageFilter.cat === id ? " on" : ""}`,
          );
          b.setAttribute("aria-pressed", String(pageFilter.cat === id));
          chips.append(b);
        }
        chipRow = chips;
      }
      const period = el("select") as HTMLSelectElement;
      period.setAttribute("aria-label", "Time range");
      for (const [d, label] of PERIODS) period.append(new Option(label, String(d)));
      period.value = String(pageFilter.days);
      period.onchange = () => {
        pageFilter.days = Number(period.value);
        reopen(sort);
      };
      filters.append(period);
      if (chipRow) filters.append(chipRow);
      body.append(filters);
      const now = Date.now() / 1000;
      const shown = items.filter(
        (s) =>
          (!pageFilter.cat || videoCats(s, state).includes(pageFilter.cat)) && (!pageFilter.days || now - s.p <= pageFilter.days * 86400),
      );

      const tabs = el("div", "cp-tabs");
      const labels: [Sort, string][] = [
        ["newest", "Newest"],
        ["popular", "Most viewed"],
        ["gems", "Breakouts"],
      ];
      for (const [k, label] of labels) {
        const b = btn(
          label,
          () => {
            sortPref = k;
            reopen(k);
          },
          `cp-tab${k === sort ? " on" : ""}`,
        );
        tabs.append(b);
      }
      const { list, ratio } = sortShorts(shown, sort);
      const what = [labels.find(([k]) => k === sort)![1], pageFilter.cat ? catLabel(pageFilter.cat) : ""].filter(Boolean).join(" · ");
      const play = (i: number) => app.playList(`${info.name} · ${what}`, list, i, () => reopen(sort));
      tabs.append(btn("▶ Play all", () => play(0), "btn sm primary cp-playall"));
      body.append(tabs);
      if (sort === "gems")
        body.append(el("p", "ch-note", "Shorts that got far more views than this channel's typical Short (×N = times its usual)."));
      if (!list.length) {
        body.append(el("p", "ch-note", "No Shorts match these filters."));
        return;
      }
      if (preview && !inLibrary)
        body.append(el("p", "ch-note", `Loaded ${app.ago(preview.fetchedAt)} · newest ${preview.shorts.length} Shorts`));
      const gridOpts = { badge: sort === "gems" ? (s: Short) => `×${ratio(s).toFixed(1)}` : undefined };
      // a channel in your library: its videos can be picked and edited together
      body.append(inLibrary ? selectableGrid(app, list, play, gridOpts, () => reopen(sort)) : shortGrid(app, list, play, gridOpts));
    },
    { k: "channel", h: info.handle || info.id },
  );
}
