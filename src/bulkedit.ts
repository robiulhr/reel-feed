/**
 * Edit several videos at once (the ☑ Select button on a page's or channel's screen): their categories and,
 * for Facebook videos, their lists. One change for all of them, one line in the Activity log, one Undo.
 * Loaded only when used (its own file).
 */
import { catChooser } from "./catpicker";
import { type CatId, normCats } from "./categories";
import { btn, el } from "./dom";
import { refreshManual } from "./feed";
import { listLabel } from "./lists";
import { act, fbShortId, logActivity, type ManualVideo, state } from "./store";
import type { Short } from "./types";
import { confirmDialog, toast } from "./ui";

type CatMode = "keep" | "set" | "add";

/** A row of chips for lists: tap to pick. */
function listChips(on: Set<string>, label: string): HTMLElement {
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
      },
      "chip",
    );
    b.setAttribute("aria-pressed", "false");
    row.append(b);
  }
  if (!state.lists.length) row.append(el("span", "ch-note", "No lists yet"));
  return row;
}

const manualOf = (s: Short) => state.manual.find((m) => fbShortId(m.id) === s.id);

/** The sheet: what to change on these videos. Resolves true if something was changed. */
export async function bulkEdit(items: Short[]): Promise<boolean> {
  const fb = items.filter((s) => s.fb && manualOf(s));
  const yt = items.length - fb.length;
  const box = el("div", "bulkedit");
  box.append(el("p", "ch-note", `${items.length} video${items.length === 1 ? "" : "s"} selected. Only what you pick below is changed.`));

  // ---- categories
  box.append(el("div", "u-h", "Categories"));
  const mode = el("select") as HTMLSelectElement;
  mode.setAttribute("aria-label", "What to do with the categories");
  for (const [v, l] of [
    ["keep", "Keep each video's own"],
    ["set", "Set to these (replaces)"],
    ["add", "Add these to each"],
  ] as [CatMode, string][])
    mode.append(new Option(l, v));
  const chooser = catChooser({ current: [], emptyLabel: "Pick up to 3, the first is the main one" });
  const showCats = () => {
    chooser.box.style.display = mode.value === "keep" ? "none" : ""; // (the hidden attribute loses to the box's own display style)
  };
  showCats();
  mode.onchange = showCats;
  box.append(mode, chooser.box);

  // ---- lists (Facebook videos: each one has its own lists)
  const addTo = new Set<string>();
  const takeOut = new Set<string>();
  if (fb.length) {
    box.append(el("div", "u-h", "Lists"), el("p", "ch-note", "Put these videos in:"), listChips(addTo, "Put in these lists"));
    box.append(el("p", "ch-note", "Take them out of:"), listChips(takeOut, "Take out of these lists"));
  }
  if (yt)
    box.append(
      el(
        "p",
        "ch-note",
        `${yt} YouTube video${yt === 1 ? "" : "s"}: only their categories change here (lists hold whole channels, and those you change on the channel).`,
      ),
    );

  const ok = await confirmDialog({
    title: `✎ Edit ${items.length} videos`,
    extra: box,
    confirm: "Apply",
    cancel: "Cancel",
    variant: "sheet",
  });
  if (!ok) return false;

  const cats: CatId[] = chooser.picked();
  const changeCats = mode.value !== "keep" && cats.length > 0;
  const changeLists = fb.length > 0 && (addTo.size > 0 || takeOut.size > 0);
  if (!changeCats && !changeLists) {
    toast("Nothing picked, so nothing changed");
    return false;
  }

  const before = { manual: [] as ManualVideo[], catFix: new Map<string, CatId[] | undefined>() };
  let n = 0;
  for (const s of items) {
    const nextCats = !changeCats ? null : mode.value === "set" ? cats : normCats([...s.k, ...cats]);
    const m = s.fb ? manualOf(s) : undefined;
    if (m) {
      const lists = new Set(m.lists);
      for (const id of addTo) lists.add(id);
      for (const id of takeOut) lists.delete(id);
      const next: ManualVideo = { ...m, cats: nextCats ?? m.cats, lists: [...lists] };
      if (next.cats.join() === m.cats.join() && next.lists.join() === m.lists.join()) continue;
      before.manual.push(structuredClone(m));
      act({ t: "manEdit", v: next }, { quiet: true });
      n++;
    } else if (nextCats && !s.fb) {
      before.catFix.set(s.id, state.catFix[s.id]);
      act({ t: "catFix", id: s.id, cats: nextCats }, { quiet: true });
      n++;
    }
  }
  const what = [changeCats ? "categories" : "", changeLists ? "lists" : ""].filter(Boolean).join(" and ");
  logActivity(
    "video",
    `Changed the ${what} of ${n} video${n === 1 ? "" : "s"} at once`,
    undefined,
    items.map((s) => s.id),
  );
  refreshManual();
  toast(`Updated ${n} video${n === 1 ? "" : "s"}`, {
    label: "Undo",
    run: () => {
      for (const m of before.manual) act({ t: "manEdit", v: m }, { quiet: true });
      for (const [id, c] of before.catFix) act({ t: "catFix", id, cats: c ?? [] }, { quiet: true });
      refreshManual();
      toast("Put back as it was");
    },
  });
  return true;
}
