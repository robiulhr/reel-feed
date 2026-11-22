/**
 * The categories: names, groups, the old → new mapping, and language detection.
 * Small on purpose — this part ships to phones. The keyword rules that sort each Short live in
 * classify.ts (used only by the fetch script, the sync Worker and tests).
 */
export const GROUPS = [
  { id: "biz", label: "Business & growth" },
  { id: "fun", label: "Fun & brand-able" },
  { id: "islam", label: "Islamic" },
] as const;
export type GroupId = (typeof GROUPS)[number]["id"];

export const CATEGORIES = [
  { id: "ads", label: "Meta & Google Ads", short: "Ads", group: "biz" },
  { id: "marketing", label: "Marketing & Branding", short: "Marketing", group: "biz" },
  { id: "ecom", label: "E-commerce", short: "E-com", group: "biz" },
  { id: "sales", label: "Sales & Customers", short: "Sales", group: "biz" },
  { id: "stories", label: "Business Stories", short: "Stories", group: "biz" },
  { id: "founders", label: "Founders & Leaders", short: "Founders", group: "biz" },
  { id: "money", label: "Money & Investing", short: "Money", group: "biz" },
  { id: "growth", label: "Self-growth", short: "Growth", group: "biz" },
  { id: "career", label: "Career & Skills", short: "Career", group: "biz" },
  { id: "ai", label: "AI & Tech Tools", short: "AI", group: "biz" },
  { id: "creative", label: "Content & Design", short: "Design", group: "biz" },
  { id: "brandads", label: "Famous Brand Ads", short: "Brand ads", group: "fun" },
  { id: "brandfun", label: "Funny Brand Content", short: "Brand fun", group: "fun" },
  { id: "workfun", label: "Office & Work Fun", short: "Office fun", group: "fun" },
  { id: "comedy", label: "Comedy", short: "Comedy", group: "fun" },
  { id: "facts", label: "Facts & Knowledge", short: "Facts", group: "fun" },
  { id: "quran", label: "Quran Tilawat", short: "Quran", group: "islam" },
  { id: "waz", label: "Waz & Islamic Talks", short: "Waz", group: "islam" },
  { id: "nasheed", label: "Nasheed & Gajal", short: "Nasheed", group: "islam" },
] as const satisfies readonly { id: string; label: string; short: string; group: GroupId }[];

export type CatId = (typeof CATEGORIES)[number]["id"];
export const CAT_IDS: CatId[] = CATEGORIES.map((c) => c.id);
const CAT_SET = new Set<string>(CAT_IDS);
export const isCat = (x: unknown): x is CatId => typeof x === "string" && CAT_SET.has(x);
export const catInfo = (id: string) => CATEGORIES.find((c) => c.id === id);
export const catLabel = (id: string) => catInfo(id)?.label ?? id;
export const groupOf = (id: string): GroupId | undefined => catInfo(id)?.group;

/** Categories kept out of the "All" feed by default (they have their own chips). */
export const PERSONAL_GROUP: GroupId = "islam";

/** Old single categories (before multi-category) → new ones. "bangla" was a language, not a topic. */
export const LEGACY: Record<string, CatId[]> = {
  bangla: [],
  ads: ["ads", "ecom"],
  stories: ["stories"],
  founders: ["founders"],
  books: ["growth", "money"],
  ai: ["ai"],
  other: [],
};
/** Cleans a category list from any source (old single `cat`, user input, the Worker). */
export function normCats(cats: unknown, legacyCat?: unknown): CatId[] {
  const out: CatId[] = [];
  const push = (c: unknown) => {
    if (isCat(c) && !out.includes(c) && out.length < 3) out.push(c);
  };
  if (Array.isArray(cats)) for (const c of cats) push(c);
  if (!out.length && typeof legacyCat === "string") for (const c of LEGACY[legacyCat] ?? (isCat(legacyCat) ? [legacyCat] : [])) push(c);
  return out;
}

// ---------- language ----------
export type Lang = "bn" | "en" | "hi";
/** Order used in shorts.json (a video stores its language as an index into this list). */
export const LANG_CODES: Lang[] = ["bn", "en", "hi"];
export const LANGS: { id: Lang; label: string }[] = [
  { id: "bn", label: "বাংলা" },
  { id: "en", label: "English" },
  { id: "hi", label: "हिन्दी/اردو" },
];
const BENGALI = /[ঀ-৿]/;
const DEVANAGARI = /[ऀ-ॿ]/;
const URDU = /[ٹڈڑںھہے]/; // letters used in Urdu but not Arabic
const ROMAN_BN =
  /\b(kivabe|kibhabe|korben|korte|koren|korbo|apnar|amader|amar|tumi|bhai|taka|kemne|hobe|parben|valo|bhalo|ekhon|keno|kintu|bangla)\b/i;
const ROMAN_HI = /\b(kaise|kya|kyun|nahi|nahin|paisa|karo|karna|hindi|bhai log|yaar|kaam|apna|mera|tera|hai)\b/i;

/** Language of a video from its title (and description when the title has no clue). */
export function detectLang(title: string, desc = "", channelBn = false): Lang {
  if (BENGALI.test(title)) return "bn";
  if (DEVANAGARI.test(title) || URDU.test(title)) return "hi";
  if (ROMAN_BN.test(title)) return "bn";
  if (ROMAN_HI.test(title)) return "hi";
  const d = desc.slice(0, 300);
  if ((d.match(/[ঀ-৿]/g)?.length ?? 0) > 15) return "bn";
  if ((d.match(/[ऀ-ॿ]/g)?.length ?? 0) > 15) return "hi";
  return channelBn ? "bn" : "en";
}
