/**
 * Facebook's other page formats (worker/src/fb.ts): "reactions · shares" titles, full page addresses
 * in the embed, and a page's own address (name, followers, picture). Facebook is faked — no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleFb, pagePathOf, readEmbedPage, readPagePage, readVideoPage } from "../../worker/src/fb";

afterEach(() => vi.unstubAllGlobals());

const PAGE = `<meta property="og:title" content="Omar Faruk  | Dhaka" />
<meta property="og:description" content="Omar Faruk , Dhaka. 18,022 followers &#xb7; 29,032 talking about this. BRANDING &#10;| Certified Meta Ads" />
<meta property="og:url" content="https://www.facebook.com/omarfarukOfficial54" />
<meta property="og:image" content="https://scontent.fdac198-1.fna.fbcdn.net/v/t39/p.jpg?a=1&amp;b=2" />`;

describe("more of Facebook's formats", () => {
  it("a title with reactions and shares (no views)", () => {
    const v = readVideoPage(`<meta property="og:title" content="2.2K reactions &#xb7; 112 shares | Facebook ads - why so few orders?" />
<meta property="og:description" content="Facebook ads - why so few orders?" />`);
    expect([v.views, v.reactions]).toEqual([0, 2200]);
    expect(v.caption).toBe("Facebook ads - why so few orders?");
  });

  it("the embed's page link as a full address; the page from a video address", () => {
    expect(
      readEmbedPage(`<a title="Omar Faruk " target="_blank" href="https://www.facebook.com/omarfarukOfficial54?ref=embed_video">x</a>`),
    ).toEqual({ name: "Omar Faruk", path: "/omarfarukOfficial54" });
    expect(pagePathOf("https://www.facebook.com/omarfarukOfficial54/videos/some-title/1150257824610350/")).toBe("/omarfarukOfficial54");
    expect(pagePathOf("https://www.facebook.com/reel/1150257824610350/")).toBe("");
  });

  it("a page's name, followers and picture", () => {
    const p = readPagePage(PAGE);
    expect(p).toMatchObject({ name: "Omar Faruk", path: "/omarfarukOfficial54", followers: 18022 });
    expect(p.about).toMatch(/^BRANDING/);
    expect(p.image).toBe("https://scontent.fdac198-1.fna.fbcdn.net/v/t39/p.jpg?a=1&b=2");
  });

  it("/api/fb/page follows redirects on Facebook only; /api/fb/pagepic sends you to the picture", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | Request) => {
      const url = typeof input === "string" ? input : input.url;
      asked.push(url);
      const u = new URL(url);
      if (u.pathname === "/61595841376442")
        return new Response(null, { status: 301, headers: { Location: "https://www.facebook.com/omarfarukOfficial54" } });
      if (u.pathname === "/evil") return new Response(null, { status: 302, headers: { Location: "https://evil.example/x" } });
      if (u.pathname === "/omarfarukOfficial54") return new Response(PAGE);
      return new Response("no", { status: 404 });
    });
    const call = (path: string) => {
      const url = new URL(`https://reel.test${path}`);
      return handleFb(new Request(url), url);
    };
    const r = await call(`/api/fb/page?url=${encodeURIComponent("https://www.facebook.com/61595841376442")}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      name: "Omar Faruk",
      path: "/omarfarukOfficial54",
      followers: 18022,
      about: expect.stringMatching(/^BRANDING/),
    });
    expect((await call(`/api/fb/page?url=${encodeURIComponent("https://www.facebook.com/evil")}`)).status).toBe(422);
    expect(asked.some((a) => a.includes("evil.example"))).toBe(false);
    expect((await call(`/api/fb/page?url=${encodeURIComponent("https://example.com/x")}`)).status).toBe(422);

    const pic = await call("/api/fb/pagepic?path=%2FomarfarukOfficial54");
    expect(pic.status).toBe(302);
    expect(pic.headers.get("Location")).toBe("https://scontent.fdac198-1.fna.fbcdn.net/v/t39/p.jpg?a=1&b=2");
    expect((await call("/api/fb/pagepic?path=https%3A%2F%2Fevil.example")).status).toBe(404);
  });
});
