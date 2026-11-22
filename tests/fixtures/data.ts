/** Small, made-up library used by unit and browser tests (no real YouTube data needed). */
import { CAT_IDS, detectLang, LANG_CODES } from "../../src/categories";
import { channelPrior, pickCats, textScores } from "../../src/classify";
import type { Channel, Dataset, Short } from "../../src/types";

export const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

export const CHANNELS: Channel[] = [
  {
    h: "@alpha",
    n: "Alpha Biz",
    cats: ["stories", "marketing"],
    mix: [],
    bn: false,
    subs: 100000,
    thumb: "",
    id: "UCalpha000000000000000aa",
    st: "active",
    cnt: 6,
    last: NOW - DAY,
  },
  {
    h: "@bangla",
    n: "বাংলা ব্যবসা",
    cats: ["marketing"],
    mix: [],
    bn: true,
    subs: 50000,
    thumb: "",
    id: "UCbangla00000000000000aa",
    st: "active",
    cnt: 6,
    last: NOW - 2 * DAY,
  },
  {
    h: "@ads",
    n: "Ads Lab",
    cats: ["ads", "ecom"],
    mix: [],
    bn: false,
    subs: 20000,
    thumb: "",
    id: "UCads0000000000000000aaa",
    st: "active",
    cnt: 6,
    last: NOW - 3 * DAY,
  },
  {
    h: "@founder",
    n: "Founder Talk",
    cats: ["founders"],
    mix: [],
    bn: false,
    subs: 900000,
    thumb: "",
    id: "UCfounder000000000000aaa",
    st: "active",
    cnt: 6,
    last: NOW - DAY,
  },
  {
    h: "@books",
    n: "Book Bits",
    cats: ["growth", "money"],
    mix: [],
    bn: false,
    subs: 300000,
    thumb: "",
    id: "UCbooks00000000000000aaa",
    st: "active",
    cnt: 6,
    last: NOW - 40 * DAY,
  },
  {
    h: "@gone",
    n: "Removed Channel",
    cats: ["ai"],
    mix: [],
    bn: false,
    subs: 1000,
    thumb: "",
    id: "UCgone000000000000000aaa",
    st: "removed",
    cnt: 0,
    last: 0,
  },
];

const TITLES: Record<string, string[]> = {
  "@alpha": [
    "How Rolex controls its prices",
    "Pricing psychology secrets",
    "Why Apple never discounts",
    "Brand story of Nike",
    "Coca-Cola marketing trick",
    "Amazon customer obsession",
  ],
  "@bangla": ["ব্যবসায় দাম কমানো ভুল", "কাস্টমার ধরে রাখার উপায়", "ফেসবুক বিজ্ঞাপন টিপস", "উদ্যোক্তার ভুল", "প্রোডাক্ট প্রাইসিং", "অফার দেওয়ার নিয়ম"],
  "@ads": [
    "Meta ads scaling in 2026",
    "Creative testing framework",
    "Pricing psychology for ecommerce",
    "Retargeting that works",
    "Shopify conversion tips",
    "Facebook ads budget mistakes",
  ],
  "@founder": [
    "Founder mindset on failure",
    "How I built a million dollar brand",
    "Hiring your first employee",
    "Pricing your product right",
    "Sales calls that close",
    "Why most startups fail",
  ],
  "@books": [
    "Atomic habits summary",
    "Psychology of money",
    "Zero to one lessons",
    "Deep work ideas",
    "Influence by Cialdini",
    "Rich dad poor dad",
  ],
};

/** 30 Shorts: 6 per active channel, varied age/views so ranking has something to do. */
export function makeDataset(): Dataset {
  const videos: Short[] = [];
  CHANNELS.forEach((ch, ci) => {
    (TITLES[ch.h] ?? []).forEach((t, k) => {
      const i = ci * 10 + k;
      videos.push({
        id: `vid${String(i).padStart(8, "0")}`, // 11 chars like a real YouTube ID
        ch: ci,
        t,
        p: NOW - (k + 1) * 3 * DAY,
        v: 1000 * (k + 1) * (ci + 1),
        l: 50 * (k + 1),
        c: 5 * k,
        o: (k % 3) / 2,
        e: ((k + ci) % 4) / 3,
        tr: (5 - k) / 5,
        r: 0.6,
        // sorted by the real rules, like the fetch script does
        ...(() => {
          const sorted = pickCats(textScores({ title: t }), channelPrior({}, ch.cats));
          return { k: sorted.cats, lg: detectLang(t, "", ch.bn), g: sorted.guessed };
        })(),
      });
    });
  });
  return { generatedAt: NOW, units: 17, usage: [], channels: structuredClone(CHANNELS), videos };
}

/** The same dataset in the compact file format the site downloads (shorts.json / starter.json). */
export function asFile(ds: Dataset) {
  return {
    generatedAt: ds.generatedAt,
    units: ds.units,
    usage: ds.usage,
    cats: CAT_IDS,
    langs: LANG_CODES,
    channels: ds.channels.map((c) => ({ ...c, mix: c.mix.map(([k, pct]) => [CAT_IDS.indexOf(k), pct]) })),
    videos: ds.videos.map((s) => [
      s.id,
      s.ch,
      s.t,
      s.p,
      s.v,
      s.l,
      s.c,
      s.o,
      s.e,
      s.tr,
      s.r,
      s.k.map((c) => CAT_IDS.indexOf(c)),
      LANG_CODES.indexOf(s.lg),
      s.g ? 1 : 0,
    ]),
  };
}
