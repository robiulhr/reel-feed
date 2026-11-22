/**
 * Accuracy check for the category rules: sorts every cached video exactly like `scripts/fetch.ts`, then
 * prints a random sample (same sample every run) to judge by hand, plus overall numbers.
 *   npx tsx scripts/sample-cats.ts [count=150] [seed=7]
 * Needs data/cache.json (from a local fetch run).
 */
import { readFileSync } from "node:fs";
import { type CatId, normCats } from "../src/categories";
import { channelNoise, channelPrior, ownBrand, pickCats, type Prior, textScores } from "../src/classify";

interface V {
  ch: string;
  t: string;
  v: number;
  d?: string;
  tg?: string[];
}
const cache = JSON.parse(readFileSync("data/cache.json", "utf8")) as { videos: Record<string, V>; channels: Record<string, unknown> };
const list = JSON.parse(readFileSync("channels.json", "utf8")) as {
  name: string;
  handle: string;
  id?: string;
  cats?: CatId[];
  cat?: string;
}[];

const byChannel = new Map<string, [string, V][]>();
for (const [id, v] of Object.entries(cache.videos)) {
  const a = byChannel.get(v.ch) ?? [];
  a.push([id, v]);
  byChannel.set(v.ch, a);
}
const userCatsOf = (h: string) => {
  const e = list.find((c) => c.handle.toLowerCase() === h.toLowerCase());
  return { name: e?.name ?? h, cats: normCats(e?.cats, e?.cat) };
};

const rows: { id: string; ch: string; t: string; tags: string; cats: CatId[]; g: boolean }[] = [];
for (const [chId, vids] of byChannel) {
  const { name, cats: userCats } = userCatsOf(chId);
  const texts = vids.map(([, v]) => ({ title: v.t, desc: v.d, tags: v.tg }));
  const noise = channelNoise(texts);
  const scores = texts.map((t) => textScores(t, noise));
  const counted: Prior = {};
  let confident = 0;
  for (const sc of scores) {
    const r = pickCats(sc, {});
    if (r.guessed || !r.cats[0]) continue;
    counted[r.cats[0]] = (counted[r.cats[0]] ?? 0) + 1;
    confident++;
  }
  const mix: Prior = {};
  for (const [k, n] of Object.entries(counted)) mix[k as CatId] = (n ?? 0) / confident;
  const prior = channelPrior(confident >= 5 ? mix : {}, userCats);
  vids.forEach(([id, v], i) => {
    const s = ownBrand(pickCats(scores[i], prior), userCats);
    rows.push({ id, ch: name, t: v.t, tags: (v.tg ?? []).slice(0, 4).join(", "), cats: s.cats, g: s.guessed });
  });
}

const count = Number(process.argv[2] ?? 150);
let seed = Number(process.argv[3] ?? 7);
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const sample = [...rows]
  .sort((a, b) => a.id.localeCompare(b.id))
  .sort(() => rand() - 0.5)
  .slice(0, count);
const g = rows.filter((r) => r.g).length;
console.log(
  `${rows.length} videos · confident ${Math.round(((rows.length - g) / rows.length) * 100)}% · guessed ${Math.round((g / rows.length) * 100)}%`,
);
sample.forEach((r, i) => {
  console.log(
    `${i + 1}\t${r.cats.join("+") || "-"}${r.g ? " ?" : ""}\t${r.ch.slice(0, 22)}\t${r.t.slice(0, 90).replace(/\s+/g, " ")}${r.tags ? `\t[${r.tags.slice(0, 60)}]` : ""}`,
  );
});
