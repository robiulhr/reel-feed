import { describe, expect, it } from "vitest";
import { parse, type Route, toPath } from "../../src/router";

describe("page addresses", () => {
  const cases: [string, Route][] = [
    ["/", { k: "feed" }],
    ["/v/dQw4w9WgXcQ", { k: "feed", v: "dQw4w9WgXcQ" }],
    ["/saved", { k: "panel", tab: "saved" }],
    ["/usage", { k: "panel", tab: "api" }],
    ["/channel/AdsLab", { k: "channel", h: "AdsLab" }],
    ["/similar/dQw4w9WgXcQ", { k: "similar", id: "dQw4w9WgXcQ" }],
  ];
  it.each(cases)("%s ↔ route", (p, r) => {
    expect(parse(p, "/")).toEqual(r);
    expect(toPath(r, "/")).toBe(p);
  });

  it("works under a folder (GitHub Pages)", () => {
    expect(parse("/reel-feed/saved", "/reel-feed/")).toEqual({ k: "panel", tab: "saved" });
    expect(toPath({ k: "channel", h: "@x" }, "/reel-feed/")).toBe("/reel-feed/channel/x");
    expect(toPath({ k: "feed" }, "/reel-feed/")).toBe("/reel-feed/");
  });

  it("anything unknown or broken is just the feed", () => {
    for (const p of ["/nope", "/v/", "/v/<script>", "/similar/x", "/api", "/%E0%A4%A"]) expect(parse(p, "/")).toEqual({ k: "feed" });
  });

  it("channel links: no @ (old @ and %40 links still work), odd names escaped", () => {
    expect(toPath({ k: "channel", h: "@AdsLab" }, "/")).toBe("/channel/AdsLab");
    expect(parse("/channel/@AdsLab", "/")).toEqual({ k: "channel", h: "AdsLab" });
    expect(parse("/channel/%40AdsLab", "/")).toEqual({ k: "channel", h: "AdsLab" });
    expect(toPath({ k: "channel", h: "@a b/c" }, "/")).toBe("/channel/a%20b%2Fc");
    expect(parse("/channel/a%20b%2Fc", "/")).toEqual({ k: "channel", h: "a b/c" });
    expect(parse("/channel/@", "/")).toEqual({ k: "feed" });
  });
});
