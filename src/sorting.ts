/**
 * Menu → Sorting: Shorts whose categories were only guessed (their title, tags and description said
 * nothing), most viewed first. Confirm the guess or pick the right categories — your answer is final,
 * syncs to your other devices, and shows which keywords the rules are missing.
 */
import type { AppApi } from "./app";
import { catLabel } from "./categories";
import { pickCategories } from "./catpicker";
import { btn, el } from "./dom";
import { isGuessed, videoCats } from "./rank";
import { act, state } from "./store";
import { longNow } from "./data";
import type { Dataset, Short } from "./types";

const PAGE = 30;
let shownCount = PAGE;

export function renderSorting(body: HTMLElement, app: AppApi, rerender: () => void) {
  const ds = app.ds;
  // Shorts and long videos alike (each from its own data set, with its own channel list)
  const sets: Dataset[] = [ds, longNow()].filter((x): x is Dataset => !!x);
  const dsOf = new Map<Short, Dataset>();
  const total = sets.reduce((n, d) => n + d.videos.length, 0);
  const guessed: Short[] = [];
  for (const d of sets)
    for (const s of d.videos)
      if (d.channels[s.ch]?.st === "active" && isGuessed(s, state)) {
        guessed.push(s);
        dsOf.set(s, d);
      }
  guessed.sort((a, b) => b.v - a.v);
  const fixed = Object.keys(state.catFix).length;

  body.append(
    el(
      "p",
      "ch-note",
      `${guessed.length} of ${total} ${sets.length > 1 ? "videos" : "Shorts"} (${Math.round((guessed.length / Math.max(1, total)) * 100)}%) are sorted by a guess from their channel — their own words said nothing. Most viewed first.${fixed ? ` You've sorted ${fixed} yourself.` : ""}`,
    ),
  );
  if (!guessed.length) {
    body.append(el("p", "ch-note", "Nothing to sort 🎉"));
    return;
  }
  const items = guessed.slice(0, shownCount);
  const shorts = items.filter((s) => !s.d);
  if (shorts.length) body.append(btn("▶ Play these", () => app.playList("Needs sorting", shorts, 0, rerender), "btn sm primary"));

  const list = el("div", "h-list");
  items.forEach((s) => {
    const row = el("div", "h-row sort-row");
    const play = el("button", "sort-play") as HTMLButtonElement;
    play.type = "button";
    play.setAttribute("aria-label", `Play ${s.t}`);
    const img = el("img", "h-thumb") as HTMLImageElement;
    img.loading = "lazy";
    img.alt = "";
    app.thumb(img, s.id);
    play.append(img);
    play.onclick = () =>
      s.d ? app.playList("Needs sorting", [s], 0, rerender) : app.playList("Needs sorting", shorts, shorts.indexOf(s), rerender);

    const cats = videoCats(s, state);
    const txt = el("div", "h-txt");
    txt.append(
      el("div", "h-title", s.t),
      el("div", "ch-note", `${dsOf.get(s)?.channels[s.ch]?.n ?? ""} · ${app.fmt(s.v)} views`),
      el("div", "h-status", `Guess: ${cats.map(catLabel).join(", ") || "none"}`),
    );
    const acts = el("div", "sort-acts");
    if (cats.length)
      acts.append(
        btn("✓ Right", () => {
          act({ t: "catFix", id: s.id, cats });
          rerender();
        }),
      );
    acts.append(
      btn("Change", async () => {
        const picked = await pickCategories({
          title: s.d ? "Categories for this video" : "Categories for this Short",
          current: cats,
          note: s.t,
        });
        if (picked) {
          act({ t: "catFix", id: s.id, cats: picked });
          rerender();
        }
      }),
    );
    txt.append(acts);
    row.append(play, txt);
    list.append(row);
  });
  body.append(list);
  if (guessed.length > shownCount)
    body.append(
      btn(`Show ${Math.min(PAGE, guessed.length - shownCount)} more`, () => {
        shownCount += PAGE;
        rerender();
      }),
    );
}
