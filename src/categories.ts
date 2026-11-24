/**
 * The categories: names, groups, the old → new mapping, and language detection.
 * Small on purpose — this part ships to phones. The keyword rules that sort each Short live in
 * classify.ts (used only by the fetch script, the sync Worker and tests).
 */
/** Main categories, in the order they're shown. Each topic below belongs to one. */
export const GROUPS = [
  { id: "mkt", label: "Marketing & Ads", icon: "📣" },
  { id: "content", label: "Content Creation", icon: "🎬" },
  { id: "sell", label: "Selling", icon: "🛒" },
  { id: "biz", label: "Business & Learning", icon: "🏢" },
  { id: "money", label: "Money & Career", icon: "💰" },
  { id: "grow", label: "Mindset & Growth", icon: "🧠" },
  { id: "tech", label: "AI & Tech", icon: "🤖" },
  { id: "brands", label: "Brands & Companies", icon: "🏷️" },
  { id: "fun", label: "Comedy & Fun", icon: "😂" },
  { id: "facts", label: "Facts & Knowledge", icon: "💡" },
  { id: "world", label: "Politics & World", icon: "🌍" },
  { id: "type", label: "Video type", icon: "🎞️" },
  { id: "learn", label: "Learn", icon: "🎓" },
  { id: "islam", label: "Islamic", icon: "🕌" },
] as const;
export type GroupId = (typeof GROUPS)[number]["id"];

export const CATEGORIES = [
  { id: "ads", label: "Meta & Google Ads", short: "Ads", group: "mkt" },
  { id: "marketing", label: "Marketing Strategy", short: "Marketing", group: "mkt" },
  { id: "branding", label: "Branding & Positioning", short: "Branding", group: "mkt" },
  { id: "creative", label: "Design & Creative", short: "Design", group: "mkt" },
  { id: "hooks", label: "Hook Ideas", short: "Hooks", group: "content" },
  { id: "vidcreate", label: "Video Creation Tips", short: "Making", group: "content" },
  { id: "vidgrow", label: "Video Growth Tips", short: "Reach", group: "content" },
  { id: "ecom", label: "E-commerce", short: "E-com", group: "sell" },
  { id: "sales", label: "Sales & Customers", short: "Sales", group: "sell" },
  { id: "bizlearn", label: "Business Learning", short: "Biz learn", group: "biz" },
  { id: "bizideas", label: "Business Ideas & Local Entrepreneurs", short: "Ideas", group: "biz" },
  { id: "stories", label: "Business Stories", short: "Stories", group: "biz" },
  { id: "founders", label: "Founders & Leaders", short: "Founders", group: "biz" },
  { id: "money", label: "Money & Investing", short: "Money", group: "money" },
  { id: "career", label: "Career & Skills", short: "Career", group: "money" },
  { id: "growth", label: "Self-growth", short: "Growth", group: "grow" },
  { id: "ai", label: "AI & Tech Tools", short: "AI", group: "tech" },
  { id: "brandads", label: "Famous Brand Ads", short: "Brand ads", group: "brands" },
  { id: "brandfun", label: "Funny Brand Content", short: "Brand fun", group: "brands" },
  { id: "brandch", label: "Company Channels", short: "Companies", group: "brands" },
  { id: "workfun", label: "Office & Work Fun", short: "Office fun", group: "fun" },
  { id: "comedy", label: "Comedy", short: "Comedy", group: "fun" },
  { id: "facts", label: "Facts & Knowledge", short: "Facts", group: "facts" },
  { id: "other", label: "Other", short: "Other", group: "facts" },
  // news and world affairs (kept out of the All feed, like Islamic and Learn: pick them to follow the news)
  { id: "politics", label: "Politics", short: "Politics", group: "world" },
  { id: "geopolitics", label: "Geopolitics & World Affairs", short: "Geopolitics", group: "world" },
  // what kind of video it is (a Short can be a tutorial about ads: topic first, type second)
  { id: "tutorial", label: "Tutorials & How-tos", short: "Tutorials", group: "type" },
  { id: "explainer", label: "Explainers", short: "Explainers", group: "type" },
  { id: "interview", label: "Interviews & Talks", short: "Interviews", group: "type" },
  { id: "review", label: "Reviews & Comparisons", short: "Reviews", group: "type" },
  { id: "speech", label: "Motivational Speeches", short: "Speeches", group: "type" },
  // things you are learning (kept out of the All feed, like Islamic: pick them to study)
  { id: "english", label: "English Learning", short: "English", group: "learn" },
  { id: "arabic", label: "Arabic Learning", short: "Arabic", group: "learn" },
  { id: "quranlearn", label: "Quran Learning (Tajweed & Meaning)", short: "Learn Quran", group: "learn" },
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
export const groupInfo = (id: string) => GROUPS.find((g) => g.id === id);
/** The topics in a main category, in display order. */
export const groupCats = (g: GroupId): CatId[] => CATEGORIES.filter((c) => c.group === g).map((c) => c.id);

/** Main categories kept out of the "All" feed by default (they have their own chips): what you pick to follow, study or pray. */
export const PERSONAL_GROUPS: readonly GroupId[] = ["world", "learn", "islam"];
export const isPersonalGroup = (g: string | undefined) => !!g && (PERSONAL_GROUPS as readonly string[]).includes(g);

/** Old single categories (before multi-category) → new ones. "bangla" was a language, not a topic. */
export const LEGACY: Record<string, CatId[]> = {
  bangla: [],
  ads: ["ads", "ecom"],
  stories: ["stories"],
  founders: ["founders"],
  books: ["growth", "money"],
  ai: ["ai"],
  other: ["other"],
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
