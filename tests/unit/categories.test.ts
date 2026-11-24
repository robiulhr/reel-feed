import { beforeEach, describe, expect, it } from "vitest";
import { CAT_IDS, CATEGORIES, detectLang, groupOf, isPersonalGroup, normCats } from "../../src/categories";
import { channelNoise, channelPrior, ownBrand, pickCats, textScores, type VideoText, withAiLabel } from "../../src/classify";
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

  it("content creation: hooks, making videos, growing them", () => {
    expect(sort({ title: "Use these hooks to turn 100 likes into 100K" }).cats[0]).toBe("hooks");
    expect(sort({ title: "কনটেন্টে হুক করার জন্য এই দুইটা কাজ অবশ্যই করতে হবে।" }).cats[0]).toBe("hooks");
    expect(sort({ title: "5 Best Free Editing Apps In Mobile #capcut" }).cats[0]).toBe("vidcreate");
    expect(sort({ title: "69 B-roll shots to film" }).cats[0]).toBe("vidcreate");
    expect(sort({ title: "Why Facebook posts with external links get low reach" }).cats[0]).toBe("vidgrow");
    expect(sort({ title: "ফেসবুক পেইজে কখন পোস্ট করলে রিচ বেশি পাবেন?" }).cats[0]).toBe("vidgrow");
    // "ইন্টারভিউ" contains "ভিউ" (views) and "রিচার্জ" contains "রিচ" (reach): whole words only
    expect(textScores({ title: "জব ইন্টারভিউ টিপস" }).vidgrow ?? 0).toBe(0);
    expect(textScores({ title: "মোবাইল রিচার্জ অফার" }).vidgrow ?? 0).toBe(0);
    for (const c of ["hooks", "vidcreate", "vidgrow"]) expect(groupOf(c)).toBe("content");
  });

  it("business learning, branding and tutorials are their own topics", () => {
    expect(sort({ title: "How to start a small business with 10,000 taka" }).cats).toContain("bizlearn");
    expect(sort({ title: "ছোট ব্যবসা শুরু করার ৫টি টিপস" }).cats[0]).toBe("bizlearn");
    expect(sort({ title: "Liquid Death's $1B Brand Strategy" }).cats[0]).toBe("branding");
    expect(sort({ title: "ব্র্যান্ডিং কী? ব্র্যান্ড আইডেন্টিটি বুঝুন" }).cats[0]).toBe("branding");
    expect(sort({ title: "Canva poster design step-by-step tutorial for beginners" }).cats).toContain("tutorial");
    expect(sort({ title: "ভিডিও এডিটিং টিউটোরিয়াল" }).cats).toContain("tutorial");
    // "entrepreneur" is a hint for founders, not the whole topic
    expect(sort({ title: "Elon Musk on being a founder" }).cats[0]).toBe("founders");
  });

  it("AI and self-growth are in different main categories; groups are in order", () => {
    expect(groupOf("ai")).toBe("tech");
    expect(groupOf("growth")).toBe("grow");
    expect(groupOf("branding")).toBe("mkt");
    expect(groupOf("bizlearn")).toBe("biz");
    expect(groupOf("tutorial")).toBe("type"); // a kind of video, not a topic
    // "Other" is picked by hand: no words sort a video into it
    expect(Object.keys(textScores({ title: "other other other" }))).not.toContain("other");
    expect(normCats(undefined, "other")).toEqual(["other"]);
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

  it("a company channel (Ghorerbazar, NVIDIA…): its Shorts go under Company Channels, in Brands & Companies", () => {
    const r = ownBrand(sort({ title: "Meta ads mistakes" }), ["brandch", "ai"]);
    expect(r.cats[0]).toBe("brandch");
    expect(r.cats).toContain("ads");
    expect(groupOf("brandch")).toBe("brands");
    expect(groupOf("comedy")).toBe("fun");
  });

  it("an AI label replaces only a guess, never words the rules were sure of", () => {
    const guess = sort({ title: "Have a nice day :)" }, channelPrior({}, ["growth"]));
    expect(withAiLabel(guess, "sales,ecom")).toEqual({ cats: ["sales", "ecom"], guessed: false });
    expect(withAiLabel(sort({ title: "Have a nice day :)" }), "facts")).toEqual({ cats: ["facts"], guessed: false });
    expect(withAiLabel(sort({ title: "Meta ads mistakes" }), "comedy").cats).toEqual(["ads"]);
    expect(withAiLabel(guess, undefined)).toBe(guess);
    expect(withAiLabel(guess, "nope")).toBe(guess); // unknown ids are ignored
  });

  it("YouTube's own topics tip vague titles, but don't beat clear words", () => {
    expect(sort({ title: "আজ রাতে কথা গুলো ভাবুন", topics: ["Religion", "Society"] }).cats[0]).toBe("waz");
    // "Religion" on a Hindu / other video is not Islamic
    expect(sort({ title: "Gita in action: the easiest way", topics: ["Religion"] }).cats).not.toContain("waz");
    expect(sort({ title: "Why bridges don't break", topics: ["Knowledge"] }).cats[0]).toBe("facts");
    expect(sort({ title: "Coaches corner", ytCat: 23 }).cats[0]).toBe("comedy");
    expect(sort({ title: "Rahmatun Lil’Alameen | رحمةٌ للعالمين", topics: ["Religion", "Music_of_Asia"] }).cats[0]).toBe("nasheed");
    // vague topics count for nothing
    expect(textScores({ title: "x", topics: ["Entertainment", "Lifestyle_(sociology)", "Society", "Business"] })).toEqual({});
    // a clear title wins over a topic
    expect(sort({ title: "Facebook ads targeting for dentists", topics: ["Knowledge"] }).cats[0]).toBe("ads");
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

describe("business ideas and local entrepreneurs", () => {
  const first = (title: string) => sort({ title }).cats;
  it("sorts small-business ideas and entrepreneur stories into their own category", () => {
    expect(groupOf("bizideas")).toBe("biz");
    expect(first("Low investment business idea you can start at home")[0]).toBe("bizideas");
    expect(first("ছোট ব্যবসা: কম পুঁজিতে লাভজনক ব্যবসার আইডিয়া")[0]).toBe("bizideas");
    expect(first("কুটির শিল্প থেকে সফল উদ্যোক্তা হয়ে ওঠার গল্প")[0]).toBe("bizideas");
    expect(first("অন্যরকম উদ্যোক্তা: ঘরে বসে আয়ের নতুন উপায়")[0]).toBe("bizideas");
  });
  it("does not swallow other business topics", () => {
    expect(first("Facebook ads targeting for dentists")[0]).toBe("ads");
    expect(first("How Nike built its brand identity and positioning")[0]).not.toBe("bizideas");
  });
});

describe("learning and video-type categories", () => {
  const first = (title: string, extra: Partial<VideoText> = {}) => sort({ title, ...extra }).cats;

  it("English, Arabic and Quran learning are sorted by what the video teaches", () => {
    expect(first("Learn English speaking in 30 days | spoken English grammar")[0]).toBe("english");
    expect(first("IELTS vocabulary: 20 words for a band 8")[0]).toBe("english");
    expect(first("ইংরেজি শেখা সহজ করার ৫টি উপায় | স্পোকেন ইংলিশ")[0]).toBe("english");
    expect(first("Learn Arabic for beginners: the Arabic alphabet and letters")[0]).toBe("arabic");
    expect(first("আরবি ভাষা শেখা: প্রথম ক্লাস")[0]).toBe("arabic");
    expect(first("Tajweed rules for beginners: makharij of the letters")[0]).toBe("quranlearn");
    expect(first("কুরআন শিক্ষা: তাজবিদ ও মাখরাজ")[0]).toBe("quranlearn");
    expect(first("Surah Rahman beautiful recitation tilawat")[0]).toBe("quran"); // listening is not learning
  });

  it("they are personal categories: kept out of the All feed, like Islamic", () => {
    for (const c of ["english", "arabic", "quranlearn", "quran"]) expect(isPersonalGroup(groupOf(c)), c).toBe(true);
    for (const c of ["tutorial", "ads", "growth"]) expect(isPersonalGroup(groupOf(c)), c).toBe(false);
  });

  it("video types come after the topic: a tutorial about ads is Ads first", () => {
    const c = first("Facebook ads tutorial step by step for beginners | meta ads manager");
    expect(c[0]).toBe("ads");
    expect(c).toContain("tutorial");
    expect(groupOf("tutorial")).toBe("type");
  });

  it("explainers, interviews, reviews and speeches are recognised", () => {
    expect(first("Podcast interview with the founder: his full story")).toContain("interview");
    expect(first("iPhone vs Samsung comparison: which is better? honest review")).toContain("review");
    expect(first("Motivational speech: never give up on your dreams")).toContain("speech");
    expect(first("How it works: the real reason prices rise, explained")).toContain("explainer");
  });

  it("an old saved choice of the Tutorial category still works", () => {
    expect(normCats(["tutorial", "ads"])).toEqual(["tutorial", "ads"]);
  });
});
