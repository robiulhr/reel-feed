/**
 * Picking categories (for a channel, or to fix a Short): up to 3, the first one you pick is the main one.
 */
import { CATEGORIES, type CatId, catLabel, GROUPS } from "./categories";
import { btn, el } from "./dom";
import { confirmDialog } from "./ui";

export const MAX_PICK = 3;

/** "Marketing + 2" style summary for buttons and lists. */
export function catSummary(cats: readonly string[], empty = "No category") {
  if (!cats.length) return empty;
  return cats.length === 1 ? catLabel(cats[0]) : `${catLabel(cats[0])} + ${cats.length - 1}`;
}

/** The category chips (all groups), for a dialog. `set` replaces the choice (e.g. a fresh guess). */
export function catChooser(o: { current: readonly CatId[]; note?: string; emptyLabel?: string; onChange?: (cats: CatId[]) => void }) {
  let picked: CatId[] = [...o.current];
  const box = el("div", "catpick");
  if (o.note) box.append(el("p", "ch-note", o.note));
  const status = el("p", "ch-note catpick-status");
  status.setAttribute("aria-live", "polite");
  const buttons = new Map<CatId, HTMLButtonElement>();
  const render = () => {
    for (const [id, b] of buttons) {
      const i = picked.indexOf(id);
      b.classList.toggle("on", i >= 0);
      b.setAttribute("aria-pressed", String(i >= 0));
      b.dataset.n = i >= 0 ? (i === 0 ? "main" : String(i + 1)) : "";
      b.disabled = i < 0 && picked.length >= MAX_PICK;
    }
    status.textContent = picked.length
      ? `Main: ${catLabel(picked[0])}${picked.length > 1 ? ` · also ${picked.slice(1).map(catLabel).join(", ")}` : ""}`
      : (o.emptyLabel ?? "Nothing picked");
  };
  for (const g of GROUPS) {
    const row = el("div", "catpick-group");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", g.label);
    row.append(el("div", "catpick-head", g.label));
    const chips = el("div", "catpick-chips");
    for (const c of CATEGORIES.filter((c) => c.group === g.id)) {
      const b = btn(
        c.label,
        () => {
          picked = picked.includes(c.id) ? picked.filter((x) => x !== c.id) : [...picked, c.id];
          render();
          o.onChange?.(picked);
        },
        "chip",
      );
      buttons.set(c.id, b);
      chips.append(b);
    }
    row.append(chips);
    box.append(row);
  }
  box.append(el("p", "ch-note", `Up to ${MAX_PICK}. The first one you pick is the main category.`), status);
  render();
  return {
    box,
    picked: () => picked,
    set(cats: readonly CatId[]) {
      picked = cats.slice(0, MAX_PICK);
      render();
    },
  };
}

/** Opens the picker. Resolves with the new list (main first), or null if cancelled. */
export function pickCategories(o: { title: string; current: readonly CatId[]; note?: string; allowEmpty?: boolean; emptyLabel?: string }) {
  const c = catChooser(o);
  return confirmDialog({ title: o.title, extra: c.box, confirm: "Save" }).then((ok) => {
    if (!ok) return null;
    if (!c.picked().length && !o.allowEmpty) return null;
    return c.picked();
  });
}
