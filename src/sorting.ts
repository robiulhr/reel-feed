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
import type { Short } from "./types";

const PAGE = 30;
let shownCount = PAGE;

export function renderSorting(body: HTMLElement, app: AppApi, rerender: () => void) {
  const ds = app.ds;
  const total = ds.videos.length;
  const live = (s: Short) => ds.channels[s.ch]?.st === "active";
  const guessed = ds.videos.filter((s) => live(s) && isGuessed(s, state)).sort((a, b) => b.v - a.v);
  const fixed = Object.keys(state.catFix).length;

  body.append(
    el(
      "p",
      "ch-note",
      `${guessed.length} of ${total} Shorts (${Math.round((guessed.length / Math.max(1, total)) * 100)}%) are sorted by a guess from their channel — their own words said nothing. Most viewed first.${fixed ? ` You've sorted ${fixed} yourself.` : ""}`,
    ),
  );
  if (!guessed.length) {
    body.append(el("p", "ch-note", "Nothing to sort 🎉"));
    return;
  }
  const items = guessed.slice(0, shownCount);
  body.append(btn("▶ Play these", () => app.playList("Needs sorting", items, 0, rerender), "btn sm primary"));

  const list = el("div", "h-list");
  items.forEach((s, i) => {
    const row = el("div", "h-row sort-row");
    const play = el("button", "sort-play") as HTMLButtonElement;
    play.type = "button";
    play.setAttribute("aria-label", `Play ${s.t}`);
    const img = el("img", "h-thumb") as HTMLImageElement;
    img.loading = "lazy";
    img.alt = "";
    app.thumb(img, s.id);
    play.append(img);
    play.onclick = () => app.playList("Needs sorting", items, i, rerender);

    const cats = videoCats(s, state);
    const txt = el("div", "h-txt");
    txt.append(
      el("div", "h-title", s.t),
      el("div", "ch-note", `${ds.channels[s.ch]?.n ?? ""} · ${app.fmt(s.v)} views`),
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
        const picked = await pickCategories({ title: "Categories for this Short", current: cats, note: s.t });
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
