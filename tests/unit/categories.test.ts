import { beforeEach, describe, expect, it } from "vitest";
import { CAT_IDS, CATEGORIES, detectLang, normCats } from "../../src/categories";
import { channelNoise, channelPrior, ownBrand, pickCats, textScores, type VideoText } from "../../src/classify";
import { parse } from "../../src/data";
import { buildQueue, videoCats } from "../../src/rank";
import { applyOp, emptyShared, fromFile, migrateLocal, type State, toFile } from "../../src/store";
import type { Dataset, Short } from "../../src/types";
import { asFile, makeDataset, NOW } from "../fixtures/data";

const sort = (v: VideoText, prior = {}) => pickCats(textScores(v), prior);

describe("sorting a Short into categories", () => {
  it("uses the video's own words, English and Bangla", () => {
    expect(sort({ title: "How I got a 13x ROAS with Meta ads" }).cats[0]).toBe("ads");
    expect(sort({ title: "ফেসবুক অ্যাড রান করার আগে এটা জানুন" }).cats[0]).toBe("ads");
    expect(sort({ title: "Surah Al-Mulk beautiful recitation" }).cats[0]).toBe("quran");
    expect(sort({ title: "সূরা আর-রহমান তিলাওয়াত" }).cats[0]).toBe("quran");
    expect(sort({ title: "ChatGPT prompt that saves 2 hours" }).cats[0]).toBe("ai");
    expect(sort({ title: "Maher Zain - Rahmatun Lil'Alameen (Official Music Video)" }).cats[0]).toBe("nasheed");
  });

  it("is confident with a clear title word, guesses without one", () => {
    expect(sort({ title: "Shopify dropshipping in 2026" }).guessed).toBe(false);
    const g = sort({ title: "Have a nice day :)" }, channelPrior({}, ["growth"]));
    expect(g).toEqual({ cats: ["growth"], guessed: true });
    expect(sort({ title: "Have a nice day :)" })).toEqual({ cats: [], guessed: true });
  });

  it("whole-word Bangla terms don't match inside other words (বস ≠ ব্যবসা)", () => {
    const s = textScores({ title: "বন্ধুরা মিলে ব্যবসা করবে" });
    expect(s.workfun ?? 0).toBe(0);
  });

  it("office words are office fun only with a joke; otherwise career", () => {
    expect(sort({ title: "When your boss calls a meeting on Friday 😂" }).cats).toContain("workfun");
    const plain = textScores({ title: "How to talk to your manager about a promotion" });
    expect(plain.workfun ?? 0).toBe(0);
    expect(plain.career).toBeGreaterThan(0);
  });

  it("keeps at most 3 categories, main first, and a second one only with real evidence", () => {
    const r = sort({
      title: "Meta ads + Shopify store: sales funnel for ecommerce brands",
      tags: ["facebook ads", "ecommerce", "sales", "marketing", "chatgpt"],
    });
    expect(r.cats.length).toBeLessThanOrEqual(3);
    expect(["ads", "ecom"]).toContain(r.cats[0]);
    expect(sort({ title: "Meta ads mistakes" }).cats).toEqual(["ads"]);
  });

  it("the channel's habits break near-ties but don't override clear words", () => {
    const prior = channelPrior({ waz: 1 }, []);
    expect(sort({ title: "Facebook ads budget mistakes" }, prior).cats[0]).toBe("ads");
  });

  it("ignores boilerplate a channel puts on every video", () => {
    const vids: VideoText[] = Array.from({ length: 10 }, (_, i) => ({
      title: `Video ${i}`,
      desc: `Episode ${i}\nJoin my Meta ads course: link below`,
      tags: ["my channel", `topic${i}`],
    }));
    const noise = channelNoise(vids);
    expect(noise.lines.has("join my meta ads course: link below")).toBe(true);
    expect(textScores(vids[0], noise).ads ?? 0).toBe(0);
    expect(textScores(vids[0]).ads).toBeGreaterThan(0); // without the filter it would wrongly count
  });

  it("a brand's own channel: every Short is that brand's ad first", () => {
    const r = ownBrand(sort({ title: "Internet offer: 30 GB in 99 taka" }), ["brandads", "brandfun"]);
    expect(r.cats[0]).toBe("brandads");
    expect(r.guessed).toBe(false);
    expect(ownBrand(sort({ title: "Meta ads mistakes" }), ["marketing"]).cats).toEqual(["ads"]);
  });

  it("detects the language", () => {
    expect(detectLang("দাম কমানো ভুল")).toBe("bn");
    expect(detectLang("Business kivabe korben")).toBe("bn");
    expect(detectLang("पैसे कैसे बचाएं")).toBe("hi");
    expect(detectLang("Pricing psychology")).toBe("en");
    expect(detectLang("Pricing psychology", "", true)).toBe("bn"); // English title on a Bangla channel
  });

  it("cleans category lists and translates the old single categories", () => {
    expect(normCats(["ads", "nope", "ads", "ai", "sales", "money"])).toEqual(["ads", "ai", "sales"]);
    expect(normCats(undefined, "books")).toEqual(["growth", "money"]);
    expect(normCats(undefined, "bangla")).toEqual([]);
    expect(normCats([], "ai")).toEqual(["ai"]);
    expect(new Set(CAT_IDS).size).toBe(CATEGORIES.length);
  });
});

describe("old saved data still works", () => {
  it("a phone's settings from before: one category → several, Bangla → language filter", () => {
    expect(migrateLocal({ sv: 2, cat: "bangla" } as never)).toMatchObject({ cats: [], lang: "bn", sv: 3 });
    expect(migrateLocal({ sv: 2, cat: "ads" } as never)).toMatchObject({ cats: ["ads", "ecom"], lang: "all" });
    expect(migrateLocal({ sv: 2, cat: "all" } as never)).toMatchObject({ cats: [] });
    expect("cat" in migrateLocal({ sv: 2, cat: "ai" } as never)).toBe(false);
  });

  it("library files from before categories: videos borrow the channel's categories (as guesses)", () => {
    const ds = makeDataset();
    const old = {
      generatedAt: ds.generatedAt,
      channels: ds.channels.map(({ cats: _c, mix: _m, ...c }, i) => ({
        ...c,
        cat: ["stories", "bangla", "ads", "founders", "books", "ai"][i],
      })),
      videos: ds.videos.map((s) => [s.id, s.ch, s.t, s.p, s.v, s.l, s.c, s.o, s.e, s.tr, s.r]),
    };
    const p = parse(old);
    expect(p.channels[2].cats).toEqual(["ads", "ecom"]);
    const v = p.videos.find((s) => s.ch === 2)!;
    expect(v).toMatchObject({ k: ["ads", "ecom"], g: true });
    expect(p.videos.find((s) => s.ch === 1)!.lg).toBe("bn");
  });

  it("the current file format round-trips", () => {
    const ds = makeDataset();
    const p = parse(asFile(ds));
    expect(p.videos.map((s) => [s.k, s.lg, s.g])).toEqual(ds.videos.map((s) => [s.k, s.lg, s.g]));
  });

  it("category fixes sync (and an empty fix means back to automatic)", () => {
    const s = emptyShared();
    applyOp(s, { t: "catFix", id: "abc", cats: ["comedy", "nope" as never] });
    expect(s.catFix.abc).toEqual(["comedy"]);
    expect(fromFile(toFile(s)).catFix).toEqual({ abc: ["comedy"] });
    applyOp(s, { t: "catFix", id: "abc", cats: [] });
    expect(s.catFix.abc).toBeUndefined();
  });
});

describe("category feeds", () => {
  let ds: Dataset;
  let st: State;
  const opts = () => ({ prevVisit: NOW - 86400, exclude: new Set<string>() });
  const islamic = (id: string, ch: number): Short => ({
    id,
    ch,
    t: "Surah Yasin",
    p: NOW - 3600,
    v: 9_000_000,
    l: 1,
    c: 1,
    o: 1,
    e: 1,
    tr: 1,
    r: 1,
    k: ["quran"],
    lg: "en",
    g: false,
  });
  beforeEach(() => {
    ds = makeDataset();
    ds.videos.push(islamic("islam000001", 0));
    st = { ...migrateLocal({}), ...emptyShared() };
  });

  it("All leaves out Islamic Shorts; their chip shows them", () => {
    expect(buildQueue(ds, st, opts(), 50).items.some((s) => s.id === "islam000001")).toBe(false);
    st.cats = ["quran"];
    expect(buildQueue(ds, st, opts(), 50).items.map((s) => s.id)).toEqual(["islam000001"]);
  });

  it("picking several categories shows Shorts in any of them", () => {
    st.cats = ["ads", "growth"];
    const items = buildQueue(ds, st, opts(), 50).items;
    expect(items.length).toBeGreaterThan(0);
    for (const s of items) expect(videoCats(s, st).some((c) => c === "ads" || c === "growth")).toBe(true);
  });

  it("your fix wins over the automatic categories", () => {
    const target = ds.videos.find((s) => !s.k.includes("comedy"))!;
    st.catFix = { [target.id]: ["comedy"] };
    st.cats = ["comedy"];
    expect(buildQueue(ds, st, opts(), 50).items.map((s) => s.id)).toContain(target.id);
  });

  it("Most viewed puts the highest view count first", () => {
    st.tab = "top";
    st.cats = ["quran"];
    ds.videos.push({ ...islamic("islam000002", 1), v: 10 });
    const items = buildQueue(ds, st, opts(), 2).items;
    expect(items[0].id).toBe("islam000001");
  });
});
