/**
 * Channel lists: Competitors, Inspiration, Ads updates, AI updates and any you make. A channel can be in
 * several lists. Each list has its own feed (top bar chip) and its own view in Saved; its Shorts still show
 * in every other feed as before.
 */
import { btn, el } from "./dom";
import { act, type ChList, inChList, type Op, persist, state } from "./store";
import { confirmDialog, requestId, toast } from "./ui";

export const listLabel = (l: Pick<ChList, "icon" | "name">) => `${l.icon} ${l.name}`;
/** The lists a channel is in. */
export const listsOf = (h: string) => state.lists.filter((l) => inChList(l, h));
export const listById = (id: string) => state.lists.find((l) => l.id === id);
/** "🎯 Competitors + 1" for buttons. */
export function listSummary(h: string, empty = "Add to a list") {
  const ls = listsOf(h);
  if (!ls.length) return empty;
  return ls.length === 1 ? listLabel(ls[0]) : `${listLabel(ls[0])} + ${ls.length - 1}`;
}

/** What's in a list: its channels plus Facebook videos you put in it one by one. 0 = no feed yet. */
export const listSize = (l: ChList, s = state) => l.ch.length + s.manual.filter((m) => m.lists.includes(l.id)).length;

/** The feed of one list ("" = all channels). */
export function setFeedList(id: string) {
  state.list = id;
  persist();
}

/** Tells the top bar and the feed (panels.ts listens) that lists changed. */
export const LISTS_EVENT = "reel-lists-change";
const listsChanged = () => window.dispatchEvent(new Event(LISTS_EVENT));

const ICONS = ["🎯", "✨", "📢", "🤖", "👀", "📋", "⭐", "🔥", "💡", "🏷️"];

function newListRow(onAdd: (name: string, icon: string) => void) {
  const row = el("div", "ls-new");
  let icon = "📋";
  const ico = btn(
    icon,
    () => {
      icon = ICONS[(ICONS.indexOf(icon) + 1) % ICONS.length];
      ico.textContent = icon;
    },
    "btn sm ls-ico",
  );
  ico.setAttribute("aria-label", "Change icon");
  const name = el("input", "ch-search");
  name.placeholder = "New list, e.g. Shopify experts";
  name.maxLength = 40;
  name.setAttribute("aria-label", "New list name");
  name.dataset.ownEnter = "1";
  const add = btn("+ Add", () => {
    const n = name.value.trim();
    if (!n) return name.focus();
    onAdd(n, icon);
    name.value = "";
  });
  name.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add.click();
    }
  };
  row.append(ico, name, add);
  return row;
}

/** Pick which lists a channel is in. Resolves true if something changed. */
export async function pickLists(h: string, name: string): Promise<boolean> {
  const picked = new Set(listsOf(h).map((l) => l.id));
  const made: Op[] = [];
  const box = el("div", "lspick");
  box.append(el("p", "ch-note", "Its Shorts get their own feed and their own tab in Saved — and still show in your other feeds."));
  const chips = el("div", "catpick-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Lists");
  const chip = (l: Pick<ChList, "id" | "icon" | "name">) => {
    const b = btn(
      listLabel(l),
      () => {
        if (picked.has(l.id)) picked.delete(l.id);
        else picked.add(l.id);
        mark();
      },
      "chip",
    );
    b.dataset.id = l.id;
    chips.append(b);
  };
  const mark = () =>
    chips.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      const on = picked.has(b.dataset.id!);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  for (const l of state.lists) chip(l);
  box.append(
    chips,
    newListRow((n, icon) => {
      const id = `l${requestId().replace(/-/g, "").slice(0, 8)}`;
      made.push({ t: "listNew", id, name: n, icon });
      picked.add(id);
      chip({ id, name: n, icon });
      mark();
    }),
  );
  mark();
  if (!(await confirmDialog({ title: `Lists for ${name}`, extra: box, confirm: "Save", variant: "sheet" }))) return false;
  const before = new Set(listsOf(h).map((l) => l.id));
  for (const op of made) act(op);
  let changed = made.length > 0;
  for (const id of picked)
    if (!before.has(id)) {
      act({ t: "listAdd", id, h });
      changed = true;
    }
  for (const id of before)
    if (!picked.has(id)) {
      act({ t: "listRemove", id, h });
      changed = true;
    }
  if (changed) {
    listsChanged();
    const now = listsOf(h);
    toast(now.length ? `${name}: ${now.map((l) => l.name).join(", ")}` : `${name} isn't in any list now`);
  }
  return changed;
}

/** Rename, delete and tidy your lists. Resolves true if something changed. */
export async function manageLists(chName: (h: string) => string): Promise<boolean> {
  type Draft = { id: string; name: string; icon: string; ch: string[]; drop: boolean; isNew: boolean };
  const drafts: Draft[] = state.lists.map((l) => ({ ...l, ch: [...l.ch], drop: false, isNew: false }));
  const box = el("div", "lsman");
  const listEl = el("div", "lsman-list");
  const render = () => {
    listEl.replaceChildren(
      ...drafts.map((d) => {
        const card = el("div", `lsman-card${d.drop ? " drop" : ""}`);
        const head = el("div", "ls-new");
        const ico = btn(
          d.icon,
          () => {
            d.icon = ICONS[(ICONS.indexOf(d.icon) + 1) % ICONS.length];
            ico.textContent = d.icon;
          },
          "btn sm ls-ico",
        );
        ico.setAttribute("aria-label", `Change icon of ${d.name}`);
        const name = el("input", "ch-search");
        name.value = d.name;
        name.maxLength = 40;
        name.setAttribute("aria-label", "List name");
        name.oninput = () => {
          d.name = name.value;
        };
        const del = btn(
          d.drop ? "Undo" : "Delete",
          () => {
            d.drop = !d.drop;
            render();
          },
          d.drop ? "btn sm" : "btn sm danger",
        );
        del.setAttribute("aria-label", `${d.drop ? "Keep" : "Delete"} ${d.name}`);
        head.append(ico, name, del);
        card.append(head);
        const chs = el("div", "catpick-chips");
        if (!d.ch.length) chs.append(el("span", "ch-note", "No channels yet — add them from a channel's page or the ⋯ menu."));
        for (const h of d.ch) {
          const x = btn(
            `${chName(h)} ✕`,
            () => {
              d.ch = d.ch.filter((c) => c !== h);
              render();
            },
            "chip",
          );
          x.setAttribute("aria-label", `Take ${chName(h)} out of ${d.name}`);
          chs.append(x);
        }
        card.append(chs);
        return card;
      }),
    );
  };
  render();
  box.append(
    listEl,
    newListRow((n, icon) => {
      drafts.push({ id: `l${requestId().replace(/-/g, "").slice(0, 8)}`, name: n, icon, ch: [], drop: false, isNew: true });
      render();
    }),
  );
  if (!(await confirmDialog({ title: "Your channel lists", extra: box, confirm: "Save", variant: "sheet" }))) return false;
  let changed = false;
  const run = (op: Op) => {
    act(op);
    changed = true;
  };
  for (const d of drafts) {
    const old = listById(d.id);
    if (d.drop) {
      if (old) run({ t: "listDrop", id: d.id });
      continue;
    }
    const name = d.name.trim() || old?.name || "List";
    if (d.isNew) run({ t: "listNew", id: d.id, name, icon: d.icon });
    else if (old && (old.name !== name || old.icon !== d.icon)) run({ t: "listEdit", id: d.id, name, icon: d.icon });
    for (const h of old?.ch ?? []) if (!d.ch.includes(h)) run({ t: "listRemove", id: d.id, h });
  }
  if (state.list && !listById(state.list)) setFeedList("");
  if (changed) listsChanged();
  return changed;
}
