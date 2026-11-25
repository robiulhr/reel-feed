/** Long videos (data/long.json) read like Shorts, with one extra number: the length in seconds. */
import { describe, expect, it } from "vitest";
import { CAT_IDS, LANG_CODES } from "../../src/categories";
import { parse, type RawData } from "../../src/data";

const channel = {
  h: "@Mentor",
  n: "Mentor",
  cats: ["growth"],
  mix: [],
  bn: false,
  subs: 10,
  thumb: "",
  id: "UC1",
  st: "active",
  cnt: 2,
  last: 9,
};
const raw = (videos: unknown[][]): RawData => ({ generatedAt: 5, cats: CAT_IDS, langs: LANG_CODES, channels: [channel], videos });

describe("reading long.json", () => {
  it("keeps the length of a long video, and Shorts have none", () => {
    const long = ["abcdefghijk", 0, "Arabic grammar, lesson 4", 100, 5000, 100, 10, 0.5, 0.5, 0.5, 0.5, [0], 0, 0, 2530];
    const short = ["bcdefghijkl", 0, "A Short", 100, 5000, 100, 10, 0.5, 0.5, 0.5, 0.5, [0], 0, 0];
    const ds = parse(raw([long, short]));
    expect(ds.videos[0].d).toBe(2530);
    expect(ds.videos[1].d).toBeUndefined();
    expect(ds.videos[0].k).toEqual([CAT_IDS[0]]);
  });

  it("ignores a length that isn't a positive number", () => {
    const odd = ["abcdefghijk", 0, "x", 100, 1, 1, 1, 0, 0, 0, 0, [0], 0, 0, "soon"];
    expect(parse(raw([odd])).videos[0].d).toBeUndefined();
  });
});
