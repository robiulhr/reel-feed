/**
 * The rules that sort each Short into categories (see categories.ts for the list itself).
 * Used by the fetch script (scripts/fetch.ts), the sync Worker and tests — not shipped to phones.
 *
 * How a Short is sorted (no AI runs here, no extra API cost):
 *  1. Its title, hashtags/tags and description are matched against a keyword list per category
 *     (English, Bangla, a little Arabic/Hindi). A title hit counts most, a tag next, the description least.
 *     Lines and tags a channel puts on (almost) every video are ignored — they say nothing about this video.
 *  2. The channel's usual topics (its "content mix", plus the categories you gave the channel) break ties.
 *  3. Main category = best score. Up to 2 more if they're nearly as strong (a lower bar for close
 *     topics like Stories/Founders, a higher one for unrelated topics).
 *  4. Nothing in the text? The video takes the channel's usual topic and is marked "guessed".
 *  5. A guess can be replaced by a label from a one-off AI pass, saved in ai-cats.json (see README).
 */

import { CAT_IDS, type CatId, groupOf, normCats } from "./categories";

/** Topics close enough that a video sitting between them may go in both. */
const CLOSE: [CatId, CatId][] = [
  ["stories", "founders"],
  ["stories", "marketing"],
  ["ads", "marketing"],
  ["ads", "ecom"],
  ["ecom", "sales"],
  ["marketing", "sales"],
  ["marketing", "creative"],
  ["marketing", "brandads"],
  ["brandads", "brandfun"],
  ["brandch", "brandads"],
  ["brandch", "marketing"],
  ["brandfun", "comedy"],
  ["workfun", "comedy"],
  ["workfun", "career"],
  ["growth", "career"],
  ["growth", "founders"],
  ["growth", "money"],
  ["money", "founders"],
  ["ai", "creative"],
  ["ai", "career"],
  ["facts", "stories"],
  ["marketing", "branding"],
  ["branding", "brandads"],
  ["branding", "creative"],
  ["hooks", "vidcreate"],
  ["hooks", "vidgrow"],
  ["hooks", "ads"],
  ["hooks", "marketing"],
  ["vidcreate", "vidgrow"],
  ["vidcreate", "creative"],
  ["vidgrow", "marketing"],
  ["bizlearn", "founders"],
  ["bizlearn", "stories"],
  ["bizlearn", "ecom"],
  ["bizlearn", "sales"],
  ["bizlearn", "money"],
  ["tutorial", "ai"],
  ["tutorial", "creative"],
  ["tutorial", "vidcreate"],
  ["tutorial", "ads"],
  ["tutorial", "ecom"],
  ["tutorial", "bizlearn"],
  ["tutorial", "career"],
  ["quran", "waz"],
  ["waz", "nasheed"],
  ["politics", "geopolitics"],
  ["geopolitics", "facts"],
  ["politics", "facts"],
  ["bizideas", "stories"],
  ["bizideas", "founders"],
  ["bizideas", "bizlearn"],
  ["bizideas", "ecom"],
  ["quranlearn", "quran"],
  ["quranlearn", "waz"],
  ["quranlearn", "arabic"],
  ["english", "tutorial"],
  ["arabic", "tutorial"],
  ["quranlearn", "tutorial"],
];
const closeSet = new Set(CLOSE.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
export const areClose = (a: string, b: string) => closeSet.has(`${a}|${b}`);

/*
 * Keyword lists. Plain text = "starts a word" match for Latin script (so "advertis" matches
 * "advertising"), substring match for Bangla/Arabic/Devanagari and emoji.
 *   "=word"  whole word only (short words like "ai", "cv", "hr")
 *   "~word"  weak hit (counts half) — common words that only hint at a topic
 */
// biome-ignore format: keyword lists read better packed
const LEX: Record<CatId, string[]> = {
  ads: [
    "meta ads", "facebook ads", "facebook ad", "fb ads", "=fb ad", "instagram ads", "google ads", "youtube ads",
    "tiktok ads", "ads manager", "ad account", "ad creative", "ad set", "adset", "ad copy", "ad spend", "adspend",
    "=roas", "=cpm", "=cpc", "=ctr", "=cpa", "=cac", "media buy", "paid ads", "paid traffic", "paid social",
    "retarget", "remarket", "pixel", "conversion api", "=capi", "targeting", "lookalike", "boost post", "boosting",
    "performance market", "~campaign", "andromeda", "advantage+", "metaads", "facebookads", "googleads", "~ads",
    "=ad", "ফেসবুক অ্যাড", "ফেসবুক এড", "ফেসবুক বিজ্ঞাপন", "মেটা অ্যাড", "মেটা এড", "অ্যাড রান", "এড রান", "বুস্ট",
    "ক্যাম্পেইন", "টার্গেটিং", "পিক্সেল", "অ্যাডস", "এডস", "পেইড অ্যাড", "অ্যাড সেট", "এড সেট", "অ্যাড ক্রিয়েটিভ",
    "~বিজ্ঞাপন",
  ],
  marketing: [
    "marketing", "~brand", "copywrit", "storytelling", "funnel",
    "~audience", "consumer", "buyer psychology", "marketing psychology", "~psychology", "=niche",
    "content marketing", "social media", "=usp", "value proposition", "growth hack", "word of mouth",
    "influencer", "packaging", "marketer", "email list", "email marketing", "newsletter", "landing page", "=seo",
    "মার্কেটিং", "~ব্র্যান্ড", "~ব্রান্ড", "কন্টেন্ট মার্কেটিং", "অডিয়েন্স", "কপিরাইটিং", "ডিজিটাল মার্কেটিং",
    "প্যাকেজিং", "ইনফ্লুয়েন্সার",
  ],
  // Brand identity, positioning, naming. (General marketing stays in `marketing`.)
  branding: [
    "branding", "brand identity", "brand strategy", "brand positioning", "positioning", "rebrand", "brand building",
    "build a brand", "building a brand", "personal brand", "brand voice", "brand name", "brand image", "brand value",
    "brand awareness", "brand loyalty", "brand trust", "brand guideline", "brand colour", "brand color", "tagline",
    "slogan", "brand design", "brand", "ব্র্যান্ডিং", "ব্রান্ডিং", "ব্র্যান্ড আইডেন্টিটি", "ব্র্যান্ড বিল্ডিং",
    "ব্র্যান্ড ভ্যালু", "পজিশনিং", "পার্সোনাল ব্র্যান্ড", "ব্র্যান্ড ইমেজ", "ব্র্যান্ডের নাম", "স্লোগান", "ব্র্যান্ড",
    "ব্রান্ড",
  ],
  // Openers that make people stop scrolling.
  hooks: [
    "=hook", "hooks", "hook idea", "hook formula", "video hook", "opening line", "opening hook", "first 3 seconds",
    "first three seconds", "first 3 sec", "scroll stopp", "stop the scroll", "stop scrolling", "grab attention",
    "attention grab", "pattern interrupt", "curiosity gap", "intro line", "retention hook", "viral hook", "=হুক",
    "হুকের", "হুকে", "হুকটা", "ওপেনিং লাইন", "প্রথম ৩ সেকেন্ড", "প্রথম তিন সেকেন্ড", "স্ক্রল থামা", "স্ক্রল স্টপ",
  ],
  // Making videos: ideas, scripts, shooting, editing, tools.
  vidcreate: [
    "video editing", "edit video", "editing tip", "editing app", "editing software", "editing trick", "capcut",
    "premiere", "after effects", "davinci", "kinemaster", "inshot", "filmmak", "filming", "shooting", "~shoot",
    "~camera", "lighting", "b-roll", "broll", "voice over", "voiceover", "script writing", "scriptwriting",
    "video script", "write a script", "~script", "storyboard", "vlog", "microphone", "gimbal", "teleprompter",
    "green screen", "subtitle", "captions", "transition", "content creat", "content idea", "reel idea", "reels idea",
    "video idea", "shorts idea", "post idea", "what to post", "short form", "~reels", "~editing", "~edit", "editor",
    "creator", "youtuber", "youtube channel", "ভিডিও এডিটিং", "ভিডিও এডিট", "এডিটিং", "ক্যাপকাট", "শুটিং",
    "~ক্যামেরা", "লাইটিং", "স্ক্রিপ্ট", "ভয়েসওভার", "ভয়েস ওভার", "কন্টেন্ট ক্রিয়েশন", "কন্টেন্ট আইডিয়া",
    "রিলস আইডিয়া", "ভিডিও আইডিয়া", "ভ্লগ", "ক্রিয়েটর", "ইউটিউবার", "ইউটিউব চ্যানেল", "~কন্টেন্ট", "~রিলস",
  ],
  // Getting views, followers and reach for videos and pages.
  vidgrow: [
    "go viral", "~viral", "algorithm", "~reach", "get views", "more views", "million views", "~views", "views on",
    "grow your channel", "grow your account", "grow your page", "grow on instagram", "grow on youtube",
    "grow on tiktok", "grow on facebook", "channel growth", "youtube growth", "reels growth", "instagram growth",
    "tiktok growth", "page growth", "social media growth", "followers", "subscribers", "~subscriber", "monetiz",
    "youtube seo", "watch time", "~retention", "hashtag", "posting time", "best time to post", "content strategy",
    "content calendar", "faceless", "~engagement", "~ভাইরাল", "=রিচ", "অ্যালগরিদম", "এলগরিদম", "=ভিউ", "=ভিউজ",
    "ভিউ বাড়", "ফলোয়ার", "সাবস্ক্রাইবার", "মনিটাইজ", "চ্যানেল গ্রোথ", "পেজ গ্রোথ", "ইউটিউব গ্রোথ", "ফেসবুক রিচ",
  ],
  // Start, run and grow a business: the basics and the ideas.
  bizlearn: [
    "start a business", "starting a business", "start your business", "start business", "small business",
    "business idea", "business plan", "business tip", "business advice", "business lesson", "business strategy",
    "business mistake", "business growth", "business owner", "run a business", "running a business",
    "grow your business", "scale your business", "scaling", "cash flow", "business skill", "business basics",
    "micro business", "side business", "home business", "~profit margin", "~management", "~operations", "~business",
    "entrepreneur", "startup", "start-up", "ব্যবসা শুরু", "ব্যবসার আইডিয়া", "বিজনেস আইডিয়া", "বিজনেস প্ল্যান",
    "বিজনেস টিপস", "ছোট ব্যবসা", "ব্যবসা পরিচালনা", "ক্যাশ ফ্লো", "মুনাফা", "~ব্যবসা", "~বিজনেস", "উদ্যোক্তা",
    "স্টার্টআপ", "~ম্যানেজমেন্ট",
  ],
  // Step-by-step guides and how-tos (the format, whatever the topic).
  tutorial: [
    "tutorial", "step by step", "step-by-step", "walkthrough", "walk through", "for beginners", "beginner",
    "complete guide", "full guide", "beginners guide", "how to set up", "how to setup", "full course", "crash course",
    "masterclass", "~how to", "~guide", "~setup", "~learn", "টিউটোরিয়াল", "স্টেপ বাই স্টেপ", "গাইডলাইন", "~গাইড",
    "শিখুন", "শিখে নিন", "শিখবেন", "বিগিনার", "সেটআপ", "~কিভাবে", "~কীভাবে", "মাস্টারক্লাস", "ক্র্যাশ কোর্স",
  ],
  // Ideas for small businesses and what real (often small, local) entrepreneurs are doing, how they started and earn
  bizideas: [
    "business idea", "business ideas", "small business", "startup idea", "home based business", "home business",
    "low investment", "low capital", "small capital", "cottage industry", "how he started", "how she started", "how they started",
    "entrepreneur", "small entrepreneur", "local entrepreneur", "women entrepreneur", "success story", "local business",
    "start a business", "starting a business", "side hustle", "income idea", "earn from home", "work from home", "profitable business",
    "business model", "small shop", "street food business", "~startup", "~business", "~income",
    "ব্যবসার আইডিয়া", "বিজনেস আইডিয়া", "ব্যবসা আইডিয়া", "ছোট ব্যবসা", "ছোট উদ্যোগ", "ক্ষুদ্র ব্যবসা", "কুটির শিল্প", "উদ্যোক্তা", "উদ্দোক্তা",
    "উদ্যোগ", "ক্ষুদ্র উদ্যোক্তা", "নারী উদ্যোক্তা", "স্বল্প পুঁজি", "কম পুঁজি", "কম পুঁজিতে", "পুঁজিতে ব্যবসা", "বাড়িতে বসে আয়",
    "ঘরে বসে আয়", "ঘরে বসে ইনকাম", "সফল উদ্যোক্তা", "সাফল্যের গল্প", "সফলতার গল্প", "ব্যবসা শুরু", "নতুন ব্যবসা", "লাভজনক ব্যবসা",
    "আয়ের উৎস", "আয়ের সুযোগ", "অন্যরকম", "~ব্যবসা", "~ইনকাম", "~ব্যবসায়ী",
  ],
  politics: [
    "politics", "political", "politician", "election", "elections", "parliament", "prime minister", "president",
    "government", "minister", "opposition", "voting", "ballot", "interim government", "chief adviser", "caretaker",
    "constitution", "coalition", "manifesto", "lawmaker", "senate", "congress", "democracy", "dictator", "corruption scandal",
    "=bnp", "awami league", "=ncp", "~party", "~vote", "~policy", "~reform",
    "রাজনীতি", "রাজনৈতিক", "রাজনীতিবিদ", "নির্বাচন", "সংসদ", "প্রধানমন্ত্রী", "রাষ্ট্রপতি", "সরকার", "মন্ত্রী", "বিরোধী দল", "আওয়ামী লীগ",
    "বিএনপি", "অন্তর্বর্তী সরকার", "প্রধান উপদেষ্টা", "গণতন্ত্র", "সংবিধান", "~ভোট", "~দল", "~ক্ষমতা",
  ],
  geopolitics: [
    "geopolitic", "geopolitical", "foreign policy", "diplomacy", "diplomatic", "sanction", "=nato", "united nations", "=un",
    "brics", "superpower", "cold war", "world war", "trade war", "ukraine", "russia", "taiwan", "israel", "palestine", "gaza",
    "middle east", "iran", "india pakistan", "south china sea", "indo-pacific", "world order", "global south", "border dispute",
    "invasion", "ceasefire", "treaty", "bilateral", "regime change", "military base", "arms race", "world affairs",
    "~china", "~war", "~america", "~europe", "~russian",
    "ভূরাজনীতি", "ভূ-রাজনীতি", "বিশ্ব রাজনীতি", "আন্তর্জাতিক রাজনীতি", "পররাষ্ট্রনীতি", "কূটনীতি", "নিষেধাজ্ঞা", "ইউক্রেন", "রাশিয়া", "ইসরায়েল",
    "ফিলিস্তিন", "গাজা", "মধ্যপ্রাচ্য", "ইরান", "বিশ্বযুদ্ধ", "যুদ্ধবিরতি", "মহাশক্তি", "বিশ্ব ব্যবস্থা", "~চীন", "~যুদ্ধ", "~আমেরিকা",
  ],
  explainer: [
    "explained", "explainer", "explain", "breakdown", "break down", "the truth about", "the real reason", "behind the scenes",
    "history of", "the story behind", "how it works", "how does", "how do",
    "ব্যাখ্যা", "বিশ্লেষণ", "আসল কারণ", "কীভাবে কাজ করে", "কিভাবে কাজ করে",
  ],
  interview: [
    "interview", "podcast", "conversation with", "in conversation", "fireside", "q&a", "q & a", "ask me anything", "=ama",
    "live session", "panel discussion", "keynote", "ted talk", "=tedx", "talks about", "sits down with", "guest",
    "সাক্ষাৎকার", "পডকাস্ট", "ইন্টারভিউ", "প্রশ্নোত্তর", "আড্ডা", "লাইভ সেশন", "আলোচনা",
  ],
  review: [
    "review", "unboxing", "comparison", "compared", "=vs", "versus", "which is better", "worth it", "honest opinion",
    "pros and cons", "i tried", "tested", "best of", "~top 5", "~top 10", "~best",
    "রিভিউ", "আনবক্সিং", "তুলনা", "ভার্সেস", "কোনটি ভালো", "কোনটা ভালো",
  ],
  speech: [
    "motivational speech", "motivational", "motivation", "inspirational", "inspiring speech", "speech", "never give up",
    "believe in yourself", "wake up call", "pep talk", "~inspire", "মোটিভেশনাল", "মোটিভেশন", "অনুপ্রেরণা", "বক্তৃতা", "স্পিচ",
    "হাল ছাড়বেন না", "নিজেকে বিশ্বাস",
  ],
  english: [
    "learn english", "english learning", "spoken english", "english speaking", "speak english", "english grammar",
    "english vocabulary", "vocabulary", "ielts", "toefl", "=pte", "=gre", "pronunciation", "improve your english",
    "english fluency", "fluent english", "english conversation", "english lesson", "english class", "english tips",
    "english words", "idiom", "phrasal verb", "english sentence", "daily english", "english course", "english for",
    "~english", "ইংরেজি শেখা", "ইংরেজি শিখুন", "ইংরেজি শিখতে", "স্পোকেন ইংলিশ", "ইংলিশ স্পিকিং", "ইংরেজিতে কথা",
    "ইংরেজি গ্রামার", "ইংলিশ গ্রামার", "ভোকাবুলারি", "আইইএলটিএস", "ইংলিশ শিখ", "ইংরেজি ভাষা", "~ইংরেজি", "~ইংলিশ",
  ],
  arabic: [
    "learn arabic", "arabic language", "arabic grammar", "arabic vocabulary", "arabic speaking", "speak arabic",
    "arabic lesson", "arabic course", "arabic words", "arabic for beginners", "spoken arabic", "madinah arabic",
    "madina arabic", "nahw", "=sarf", "arabic alphabet", "arabic letters", "arabic sentence", "~arabic",
    "আরবি শেখা", "আরবি শিখুন", "আরবি ভাষা", "আরবি গ্রামার", "আরবী ভাষা", "আরবি শব্দ", "স্পোকেন আরবি", "আরবি বলা", "নাহু",
    "সরফ", "~আরবি", "~আরবী", "تعلم العربية", "اللغة العربية", "تعلم اللغة",
  ],
  quranlearn: [
    "learn quran", "quran learning", "learn to read quran", "tajweed", "tajwid", "quran translation", "quran meaning",
    "meaning of quran", "tafsir", "tafseer", "noorani qaida", "nurani qaida", "=qaida", "makharij", "quran memoriz",
    "memorize quran", "hifz", "quran lesson", "quran class", "quran study", "understand quran", "quran with translation",
    "তাজবিদ", "তাজউইদ", "তাফসীর", "তাফসির", "কুরআন শিক্ষা", "কোরআন শিক্ষা", "কুরআন শেখা", "কোরআন শেখা", "নূরানী", "নুরানী",
    "মাখরাজ", "হিফজ", "কুরআনের অর্থ", "কুরআন শিখ", "কোরআন শিখ", "تجويد", "تفسير", "تعلم القرآن", "حفظ القرآن",
  ],
  ecom: [
    "ecommerce", "e-commerce", "=ecom", "shopify", "dropship", "amazon fba", "=fba", "=d2c", "=dtc", "online store",
    "online business", "product research", "winning product", "supplier", "alibaba", "inventory", "=cod",
    "cash on delivery", "courier", "~delivery", "returns", "f-commerce", "fcommerce", "f commerce", "~orders",
    "checkout", "~store", "aov", "cart", "warehouse", "fulfil", "sourcing", "wholesale", "=etsy", "tiktok shop",
    "ই-কমার্স", "ইকমার্স", "ই কমার্স", "অনলাইন ব্যবসা", "অনলাইন বিজনেস", "এফ-কমার্স", "এফ কমার্স", "এফকমার্স",
    "~অর্ডার", "ডেলিভারি", "কুরিয়ার", "রিটার্ন", "~প্রোডাক্ট", "সাপ্লায়ার", "ক্যাশ অন ডেলিভারি", "পাইকারি",
    "সোর্সিং", "~স্টক", "~পেজ", "ওয়েবসাইট",
  ],
  sales: [
    "sales", "~sell", "selling", "salesman", "closing", "close the deal", "close deals", "cold call", "cold email",
    "negotiat", "objection", "pricing", "~price", "~offer", "upsell", "customer service", "~customer", "~client",
    "discount", "persuade", "persuasion", "=pitch", "follow up", "lead gen", "leads", "~sale", "সেলস", "বিক্রি",
    "~সেল", "কাস্টমার", "ক্লায়েন্ট", "~দাম", "প্রাইস", "প্রাইসিং", "~অফার", "ডিসকাউন্ট", "নেগোশিয়েশন", "গ্রাহক",
    "ক্রেতা", "বিক্রেতা",
  ],
  stories: [
    "story of", "the story", "rise and fall", "case study", "history of", "bankrupt", "collapse", "empire",
    "billion dollar company", "dollar company", "how this company", "this company", "brand story", "~company",
    "~companies", "acquired", "acquisition", "monopoly", "went from", "secret behind", "business model",
    "strategy behind", "genius strategy", "~business idea", "genius move", "~billion", "~million", "=ipo",
    "market share", "competitor", "~compan", "কোম্পানির গল্প", "~গল্প", "~ইতিহাস", "কাহিনী", "দেউলিয়া", "সাম্রাজ্য",
    "~কোম্পানি", "উত্থান", "পতন", "কেস স্টাডি", "বিজনেস মডেল", "বিলিয়ন", "মিলিয়ন", "প্রতিযোগী",
  ],
  founders: [
    "founder", "=ceo", "~entrepreneur", "~podcast", "~interview", "billionaire", "self-made", "self made", "~startup",
    "~start-up", "elon musk", "jeff bezos", "steve jobs", "bill gates", "zuckerberg", "jack ma", "hormozi", "garyvee",
    "gary vee", "naval", "~business owner", "~owner", "~boss", "~উদ্যোক্তা", "ফাউন্ডার", "সিইও", "~পডকাস্ট",
    "~উদ্যোগ", "ইন্টারভিউ", "~স্টার্টআপ", "বিলিয়নিয়ার", "~ব্যবসায়ী", "~মালিক",
  ],
  money: [
    "money", "invest", "stock", "share market", "stock market", "crypto", "bitcoin", "finance", "financial",
    "wealth", "~rich", "salary", "saving", "budget", "debt", "loan", "interest rate", "inflation", "economy",
    "economic", "=tax", "taxes", "passive income", "real estate", "~dollar", "=gold", "income", "millionaire",
    "net worth", "compound", "retire", "bank", "mutual fund", "dividend", "~টাকা", "বিনিয়োগ", "ইনভেস্ট",
    "শেয়ার বাজার", "শেয়ার", "~স্টক", "সঞ্চয়", "ধনী", "বড়লোক", "অর্থনীতি", "লোন", "ঋণ", "সুদ", "বেতন",
    "মুদ্রাস্ফীতি", "ডলার", "~আয়", "ব্যাংক", "সম্পদ", "~ইনকাম",
  ],
  growth: [
    "mindset", "motivation", "motivat", "discipline", "habit", "success", "self improvement", "self-improvement",
    "productiv", "~focus", "confidence", "morning routine", "book", "~read", "~lesson", "~life", "relationship",
    "~love", "marriage", "happiness", "happy", "stress", "anxiety", "depress", "purpose", "~goal", "consisten",
    "dopamine", "procrastinat", "time management", "~advice", "wisdom", "stoic", "lonely", "girlfriend", "wife",
    "~regret", "~dream", "hard work", "~mind", "মোটিভেশন", "সফলতা", "~সফল", "অভ্যাস", "~জীবন", "লক্ষ্য",
    "আত্মবিশ্বাস", "~বই", "সম্পর্ক", "ভালোবাসা", "~বিয়ে", "~মন ", "শৃঙ্খলা", "টাইম ম্যানেজমেন্ট", "প্রোডাক্টিভ",
    "ডিসিপ্লিন", "হতাশা", "মানসিক", "পরিশ্রম", "স্বপ্ন",
  ],
  career: [
    "career", "=job", "=jobs", "resume", "=cv", "linkedin", "freelanc", "fiverr", "upwork", "remote work", "skill",
    "communication", "public speaking", "leadership", "~manager", "~employee", "promotion", "hiring",
    "job interview", "office politics", "~corporate", "graduate", "university", "student", "internship", "~team",
    "soft skill", "ক্যারিয়ার", "ক্যারিয়ার", "চাকরি", "চাকরী", "=জব", "সিভি", "ফ্রিল্যান্সিং", "ফ্রিল্যান্সার",
    "স্কিল", "দক্ষতা", "লিডারশিপ", "নেতৃত্ব", "কমিউনিকেশন", "~অফিস", "~কর্মী", "প্রমোশন", "ভাইভা", "শিক্ষার্থী",
    "ছাত্র", "বিশ্ববিদ্যালয়", "ইন্টার্নশিপ", "~টিম",
  ],
  ai: [
    "=ai", "=a.i", "chatgpt", "chat gpt", "=gpt", "claude", "gemini", "midjourney", "openai",
    "artificial intelligence", "automation", "automate", "=n8n", "zapier", "prompt", "~tool", "~tools", "~app",
    "~apps", "software", "=saas", "no-code", "nocode", "~tech", "robot", "=agent", "=agents", "=llm", "copilot",
    "=sora", "=veo", "deepseek", "grok", "perplexity", "nano banana", "kling", "heygen", "elevenlabs", "aitools",
    "ai tool", "website builder", "=api", "~gadget", "~laptop", "~smartphone", "~iphone", "~unboxing", "~review",
    "এআই", "এ আই", "চ্যাটজিপিটি", "~টুল", "অটোমেশন", "প্রম্পট", "সফটওয়্যার", "~অ্যাপ", "প্রযুক্তি", "রোবট",
    "~ল্যাপটপ", "~স্মার্টফোন", "~ফোন", "~গ্যাজেট", "~রিভিউ",
  ],
  creative: [
    "graphic design", "web design", "ui design", "logo design", "design tool", "designer", "canva", "~design",
    "graphic", "=logo", "logos", "typography", "~color", "~font", "photoshop", "illustrator", "figma", "=ui", "=ux",
    "thumbnail", "poster", "banner", "mockup", "illustration", "animation", "motion graphic", "ডিজাইন", "লোগো",
    "গ্রাফিক", "থাম্বনেইল", "ক্যানভা", "পোস্টার", "ব্যানার",
  ],
  brandads: [
    "commercial", "=tvc", "ad campaign", "iconic ad", "best ads", "famous ad", "funny ad", "creative ad", "advert",
    "super bowl", "guerrilla", "billboard", "brand ad", "print ad", "ogilvy", "old ad", "jingle", "adsoftheworld",
    "brilliant ad", "genius ad", "clever ad", "ads that", "this ad", "the ad", "ad by", "advertising", "campaign by",
    "টিভিসি", "বিজ্ঞাপনটি", "অ্যাডটি", "এডটি", "বিলবোর্ড", "বিজ্ঞাপন", "অ্যাড ক্যাম্পেইন",
  ],
  // Only a company's own channel puts a Short here (see ownBrand) — no words for it.
  brandch: [],
  // Picked by hand (or by an AI label) for videos that fit nowhere — no words for it.
  other: [],
  brandfun: [
    "meme", "brand meme", "marketing meme", "brands be like", "savage reply", "brand trolls", "moment marketing",
    "~parody", "duolingo", "zomato", "ryanair", "brand twitter", "~relatable", "~pov", "funny brand",
    "funny marketing", "marketer be like", "marketers be like", "agency life", "client be like", "clients be like",
    "মিম", "ট্রল", "~মার্কেটারদের",
  ],
  // Clearly office humour on their own. Plain office words (OFFICE below) only count with a humour signal.
  workfun: [
    "corporate life", "corporatelife", "corporate meme", "office life", "officelife", "office humor",
    "office humour", "office comedy", "job life", "salary day", "toxic boss", "notice period", "monday mood",
    "boss be like", "manager be like", "employees be like", "hr be like", "when your boss", "when your manager",
    "corporate humor", "অফিস লাইফ", "চাকরি জীবন", "কর্পোরেট লাইফ",
  ],
  comedy: [
    "funny", "comedy", "comedian", "stand up", "standup", "stand-up", "joke", "prank", "skit", "roast", "😂", "🤣",
    "=lol", "lmao", "hilarious", "sketch", "😆", "😅", "~fun", "laugh", "humor", "humour", "হাসির", "কমেডি", "মজার",
    "ফানি", "জোকস", "হাসতে হাসতে", "হাসি", "মজা",
  ],
  facts: [
    "facts", "=fact", "did you know", "science", "~history", "why do", "how does", "~explained", "~explain", "~news",
    "~health", "~doctor", "~cancer", "~diet", "~food", "mystery", "~world",
    "space", "universe", "animal", "ocean", "~country", "~countries", "biggest", "smallest", "most dangerous",
    "human body", "~brain", "geography", "planet", "earth", "invention", "ancient", "~weird", "strange",
    "~secret", "~truth", "physics", "chemistry", "biology", "dinosaur", "nasa", "telescope", "satellite", "engineering", "explainer", "antarctic", "=isro", "জানেন কি", "জানেন", "তথ্য",
    "বিজ্ঞান", "রহস্য", "পৃথিবী", "মহাবিশ্ব", "অবাক", "আশ্চর্য", "~দেশ", "প্রাণী", "~ইতিহাস", "অদ্ভুত",
    "~স্বাস্থ্য", "~ক্যান্সার", "~খাবার",
  ],
  quran: [
    "quran", "qur'an", "koran", "tilawat", "tilawah", "telawat", "recitation", "recite", "surah", "surath", "=sura", "ayat",
    "ayah", "qari", "qiraat", "yasin", "ar-rahman", "al-mulk", "al-kahf", "hafiz", "hifz", "কুরআন", "কোরআন",
    "কুরআনের", "তিলাওয়াত", "তেলাওয়াত", "তিলাওয়াত", "সূরা", "সুরা", "আয়াত", "আয়াত", "ক্বারী", "হাফেজ", "سورة",
    "القرآن", "قرآن", "تلاوة",
  ],
  waz: [
    "waz", "waaz", "bayan", "lecture", "dawah", "khutbah", "hadith", "sunnah", "islam", "allah", "prophet",
    "muhammad", "namaz", "salah", "=dua", "ramadan", "jannah", "jahannam", "=iman", "=deen", "sheikh", "mufti",
    "mizanur", "azhari", "=nabi", "rasul", "akhirah", "sabr", "tawbah", "hijab", "~muslim", "mosque", "masjid",
    "ওয়াজ", "ওয়াজ", "বয়ান", "বয়ান", "হাদিস", "নবী", "রাসূল", "আল্লাহ", "ইসলাম", "নামাজ", "দোয়া", "দোয়া",
    "জান্নাত", "জাহান্নাম", "ঈমান", "রমজান", "খুতবা", "আজহারী", "আজহারি", "আহমাদুল্লাহ", "মিজানুর", "শায়খ", "শায়খ", "মুফতি", "হুজুর",
    "আখিরাত", "মসজিদ", "মুসলিম", "পর্দা", "তওবা", "الله", "حديث",
  ],
  nasheed: [
    "nasheed", "nasheeds", "anasheed", "=naat", "naat sharif", "=hamd", "gojol", "gazal", "ghazal", "gajal", "gozol",
    "islamic song", "qawwali", "vocals only", "no music", "গজল", "গজল", "নাশিদ", "হামদ", "নাতে রাসূল", "ইসলামিক গান",
    "ইসলামী সংগীত", "ইসলামী গান", "সংগীত", "نشيد", "official music video", "music video", "=song", "songs", "lyrics",
    "lyric video", "vocal", "official audio", "acapella", "a cappella", "islamic music", "~singer", "গান", "কণ্ঠ",
  ],
};

// ---------- matching ----------
const LATIN = /^[\x20-\x7e]+$/;
interface Term {
  w: number; // weight (1 or 0.5)
  re?: RegExp; // Latin terms, and whole-word terms in other scripts
  sub?: string; // other scripts (substring)
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function compile(raw: string): Term {
  let t = raw;
  let w = 1;
  let whole = false;
  if (t.startsWith("~")) {
    w = 0.5;
    t = t.slice(1);
  }
  if (t.startsWith("=")) {
    whole = true;
    t = t.slice(1);
  }
  t = t.toLowerCase();
  if (!LATIN.test(t)) {
    // e.g. "=বস" (boss) must not match inside "ব্যবসা" (business)
    return whole ? { w, re: new RegExp(`(?<![\\p{L}\\p{M}])${esc(t)}(?![\\p{L}\\p{M}])`, "u") } : { w, sub: t };
  }
  // a hashtag/tag like "metaads" should still match "meta ads"
  const body = esc(t).replace(/ /g, "[\\s_-]?");
  return { w, re: new RegExp(`(?:^|[^a-z0-9])${body}${whole ? "(?![a-z0-9])" : ""}`) };
}

/** Office words: office fun when there's a joke, career talk otherwise. */
// biome-ignore format: keyword lists read better packed
const OFFICE = [
  "office", "corporate", "coworker", "co-worker", "colleague", "=boss", "manager", "=hr", "meeting", "monday",
  "9 to 5", "9-5", "=wfh", "intern", "employee", "appraisal", "deadline", "excel", "zoom call", "workplace", "অফিস",
  "=বস", "কলিগ", "মিটিং", "স্যালারি", "ডেডলাইন",
];
type Key = CatId | "office";
const TERMS: [Key, Term[]][] = [...CAT_IDS.map((c) => [c, LEX[c].map(compile)] as [Key, Term[]]), ["office", OFFICE.map(compile)]];

/** Score of one piece of text per category (each keyword counts once). */
function scoreText(text: string, weight: number, into: Partial<Record<Key, number>>) {
  if (!text) return;
  const s = text.toLowerCase();
  for (const [c, terms] of TERMS) {
    let hit = 0;
    for (const t of terms) if (t.re ? t.re.test(s) : s.includes(t.sub!)) hit += t.w;
    // diminishing returns (1 hit = 1, 2 = 1.5, 3+ = 2) so one long description can't drown the title
    if (hit) into[c] = (into[c] ?? 0) + weight * (hit <= 1 ? hit : Math.min(2, 1 + 0.5 * (hit - 1)));
  }
}

export interface VideoText {
  title: string;
  desc?: string;
  tags?: string[];
  /** YouTube's own topics for the video (Wikipedia names: "Religion", "Knowledge"…) */
  topics?: string[];
  /** YouTube video category the creator picked (23 = Comedy, 25 = News & Politics, 28 = Science & Tech…) */
  ytCat?: number;
}

/**
 * YouTube's own signals, which come from the video itself (picture and sound), not just its words.
 * Only the reliable ones count — Entertainment, Lifestyle, Society, Film and Education are on almost
 * everything. Worth less than a clear title word, so they tip close calls rather than decide alone.
 */
const TOPIC_SIGNAL: Record<string, Partial<Record<CatId, number>>> = {
  Knowledge: { facts: 1 },
  Technology: { ai: 0.6 }, // also on productivity / phone clips — a hint
  Humour: { comedy: 1.5 },
  Health: { facts: 0.3 }, // also on fitness/motivation clips — only a hint
  Politics: { politics: 1, facts: 0.3 },
  Government: { politics: 0.8 },
  Military: { geopolitics: 0.8, facts: 0.3 },
};
const YTCAT_SIGNAL: Record<number, Partial<Record<CatId, number>>> = {
  23: { comedy: 1.5 }, // Comedy
  25: { politics: 0.5, facts: 0.3 }, // News & Politics (business news uses it too)
  28: { facts: 0.3, ai: 0.3 }, // Science & Technology
};
const ISLAMIC = new Set<string>(["quran", "waz", "nasheed", "quranlearn"]);
/** Arabic or Bengali letters — "Religion" on these channels means Islamic (on Hindi/English ones it can be Hindu, Christian…). */
const ISLAMIC_SCRIPT = /[؀-ۿঀ-৿]/;
function addSignals(v: VideoText, out: Partial<Record<string, number>>) {
  const add = (m?: Partial<Record<CatId, number>>) => {
    for (const [c, w] of Object.entries(m ?? {})) out[c] = (out[c] ?? 0) + (w ?? 0);
  };
  const topics = v.topics ?? [];
  for (const t of topics) add(TOPIC_SIGNAL[t]);
  if (v.ytCat !== undefined) add(YTCAT_SIGNAL[v.ytCat]);
  if (!topics.includes("Religion")) return;
  const islamicWords = Object.entries(out).some(([c, n]) => ISLAMIC.has(c) && (n ?? 0) > 0);
  if (!islamicWords && !ISLAMIC_SCRIPT.test(v.title)) return;
  // Music on an Islamic video = nasheed / gajal; otherwise it's a talk
  const music = v.ytCat === 10 || topics.some((t) => t === "Music" || t === "Music_of_Asia");
  if (music) out.nasheed = (out.nasheed ?? 0) + 1.5;
  else out.waz = (out.waz ?? 0) + 1;
}

/** Lines/tags this channel puts on most of its videos (social links, "subscribe", course ads…). */
export interface ChannelNoise {
  lines: Set<string>;
  tags: Set<string>;
}

const normLine = (l: string) => l.trim().toLowerCase().replace(/\s+/g, " ");
const hashtags = (s: string) => [...s.matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)].map((m) => m[1]);

/** Finds the boilerplate a channel repeats, from its videos' descriptions and tags. */
export function channelNoise(videos: VideoText[]): ChannelNoise {
  const lines = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const v of videos) {
    for (const l of new Set(
      (v.desc ?? "")
        .split("\n")
        .map(normLine)
        .filter((l) => l.length > 3),
    ))
      lines.set(l, (lines.get(l) ?? 0) + 1);
    const ts = new Set([...(v.tags ?? []), ...hashtags(v.desc ?? "")].map((t) => t.toLowerCase()));
    for (const t of ts) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  const n = videos.length;
  const pick = (m: Map<string, number>, share: number) =>
    new Set(n >= 5 ? [...m].filter(([, k]) => k >= Math.max(3, n * share)).map(([x]) => x) : []);
  return { lines: pick(lines, 0.3), tags: pick(tags, 0.5) };
}

export type Scores = Partial<Record<CatId, number>>;

const W_TITLE = 3;
const W_TAGS = 2;
const W_DESC = 1;
/** Text evidence needed to call a category "confident" (one clear title word, or tag + description). */
export const CONFIDENT = 2.5;

/** How strongly the video's own words point at each category. */
export function textScores(v: VideoText, noise?: ChannelNoise): Scores {
  const out: Partial<Record<Key, number>> = {};
  const desc = (v.desc ?? "")
    .split("\n")
    .filter((l) => !noise?.lines.has(normLine(l)))
    .join("\n");
  const tags = [...(v.tags ?? []), ...hashtags(v.title), ...hashtags(desc)].map((t) => t.toLowerCase()).filter((t) => !noise?.tags.has(t));
  scoreText(v.title.replace(/#[\p{L}\p{M}\p{N}_]+/gu, " "), W_TITLE, out);
  scoreText([...new Set(tags)].join(" | "), W_TAGS, out);
  scoreText(desc.replace(/#[\p{L}\p{M}\p{N}_]+/gu, " "), W_DESC, out);
  addSignals(v, out);
  // Office words + a joke = office fun; office words alone = (a hint of) career talk
  if (out.office) {
    if ((out.comedy ?? 0) >= 1.5) out.workfun = (out.workfun ?? 0) + out.office;
    else out.career = (out.career ?? 0) + 0.5 * out.office;
    delete out.office;
  }
  return out as Scores;
}

/** The channel's usual topics as shares that add up to about 1. */
export type Prior = Partial<Record<CatId, number>>;

/** Prior from the channel's content mix and the categories you set for it. */
export function channelPrior(mix: Prior, userCats: CatId[]): Prior {
  const out: Prior = {};
  const mixTotal = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
  const wMix = mixTotal > 0 ? (userCats.length ? 0.6 : 1) : 0;
  const wUser = userCats.length ? 1 - wMix : 0;
  for (const [c, v] of Object.entries(mix)) out[c as CatId] = (out[c as CatId] ?? 0) + (wMix * (v ?? 0)) / (mixTotal || 1);
  for (const c of userCats) out[c] = (out[c] ?? 0) + wUser / userCats.length;
  return out;
}

const PRIOR_W = 2;
const MAX_CATS = 3;

export interface Sorted {
  cats: CatId[]; // main first; empty = couldn't tell at all (shows only under "All" and on the channel)
  guessed: boolean;
}

const top = (s: Scores) => (Object.entries(s) as [CatId, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

/** A video's topic comes before its type: a tutorial about ads is Ads first, Tutorial second. */
function topicFirst(cats: CatId[]): CatId[] {
  if (groupOf(cats[0]) !== "type") return cats;
  const i = cats.findIndex((c) => groupOf(c) !== "type");
  return i < 0 ? cats : [cats[i], ...cats.filter((_, j) => j !== i)];
}

/** Picks a video's categories from its text scores and the channel's usual topics. */
export function pickCats(text: Scores, prior: Prior): Sorted {
  const best = top(text)[0]?.[1] ?? 0;
  if (best > 0) {
    // the video's own words decide; the channel's habits only break near-ties
    const combined = top(
      Object.fromEntries((Object.keys(text) as CatId[]).map((c) => [c, (text[c] ?? 0) + PRIOR_W * (prior[c] ?? 0)])) as Scores,
    );
    const [main, mainScore] = combined[0];
    const cats: CatId[] = [main];
    for (const [c, sc] of combined.slice(1)) {
      if (cats.length >= MAX_CATS) break;
      const own = text[c] ?? 0;
      const bar = areClose(main, c) ? 0.5 : 0.8;
      if (own >= 1.5 && sc >= bar * mainScore) cats.push(c);
    }
    return { cats: topicFirst(cats), guessed: best < CONFIDENT };
  }
  const p = top(prior);
  if (!p.length) return { cats: [], guessed: true };
  return { cats: [p[0][0]], guessed: true };
}

/** Categories a channel can claim for everything it posts (when listed first in channels.json). */
const OWN_CATS: readonly CatId[] = ["brandch", "brandads"];

/**
 * A company's own channel (Banglalink, Ghorerbazar…) or a brand-ads channel: whatever it posts is that
 * brand's advertising, so its first category is the main category of every Short, sure — the words only
 * add the other categories.
 */
export function ownBrand(sorted: Sorted, userCats: readonly CatId[]): Sorted {
  const own = userCats[0];
  if (!own || !OWN_CATS.includes(own)) return sorted;
  return { cats: [own, ...sorted.cats.filter((c) => c !== own)].slice(0, 3), guessed: false };
}

/**
 * A label from the one-off AI pass (ai-cats.json, "ads,ecom") replaces a guess. Never words the
 * rules were sure of, and a brand channel's own Shorts stay as they are.
 */
export function withAiLabel(sorted: Sorted, label: string | undefined): Sorted {
  if (!label || (!sorted.guessed && sorted.cats.length)) return sorted;
  const cats = normCats(label.split(","));
  return cats.length ? { cats, guessed: false } : sorted;
}
