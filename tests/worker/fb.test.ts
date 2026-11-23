/**
 * Facebook video lookups (worker/src/fb.ts): reading Facebook's public pages, following share links
 * without ever leaving Facebook, and the /api/fb/* answers. Facebook is faked — no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import app, { type AppEnv } from "../../worker/src/app";
import { canonical, count, decode, handleFb, readEmbedPage, readVideoPage, resolve, titleOf, videoIdOf } from "../../worker/src/fb";

const VIDEO_PAGE = `<html><head>
<meta property="og:title" content="65K views &#xb7; 1.1K reactions | &#x9a6;&#x9be;&#x9ae; &#x9b2;&#x9c1;&#x995;&#x9be;&#x9b2;&#x9c7; &#x9b8;&#x9c7;&#x9b2; &#x995;&#x9ae;&#x9c7;,&#10;#fcommerce #onlinebusiness | Boost Marketing" />
<meta property="og:description" content="&#x9a6;&#x9be;&#x9ae; &#x9b2;&#x9c1;&#x995;&#x9be;&#x9b2;&#x9c7; &#x9b8;&#x9c7;&#x9b2; &#x995;&#x9ae;&#x9c7;,&#10;#fcommerce #onlinebusiness" />
<meta property="og:url" content="https://www.facebook.com/reel/1141407915517139/" />
<meta property="og:image" content="https://scontent.fdac24-5.fna.fbcdn.net/v/t15/x.jpg?stp=a&amp;oe=1" />
</head></html>`;
const EMBED_PAGE = `<div class="_90h_"><a title="Boost Marketing" target="_blank" href="/watch/61595841376442/?ref=embed_video" id="u_0_c">Boost Marketing</a></div>`;

afterEach(() => vi.unstubAllGlobals());

/** Fake Facebook: share link → 302 to the reel; the reel page; the embed page; oEmbed. Records every address asked for. */
function fakeFacebook(o: { oembed?: number; videoStatus?: number } = {}) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const url = typeof input === "string" ? input : input.url;
    asked.push(url);
    const u = new URL(url);
    if (u.pathname.startsWith("/share/v/"))
      return new Response(null, {
        status: 302,
        headers: { Location: "https://www.facebook.com/reel/1141407915517139?rdid=x&share_url=y" },
      });
    if (u.pathname.startsWith("/share/evil"))
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/reel/123456789" } });
    if (u.pathname.startsWith("/reel/"))
      return Object.defineProperty(new Response(VIDEO_PAGE, { status: o.videoStatus ?? 200 }), "url", {
        value: "https://www.facebook.com/reel/1141407915517139/",
      });
    if (u.pathname.startsWith("/plugins/video.php")) return new Response(EMBED_PAGE);
    if (u.hostname === "graph.facebook.com") return new Response("{}", { status: o.oembed ?? 200 });
    return new Response("not found", { status: 404 });
  });
  return asked;
}

describe("reading Facebook's pages", () => {
  it("video numbers and clean addresses", () => {
    const id = (s: string) => videoIdOf(new URL(s));
    expect(id("https://www.facebook.com/reel/1141407915517139?rdid=x")).toBe("1141407915517139");
    expect(id("https://www.facebook.com/boost/videos/a-title/1234567890123/")).toBe("1234567890123");
    expect(id("https://www.facebook.com/watch/?v=1234567890")).toBe("1234567890");
    expect(id("https://www.facebook.com/share/v/1CwWegbMzR/")).toBeNull();
    expect(canonical(new URL("https://m.facebook.com/reel/123456789?x=1"), "123456789")).toBe("https://www.facebook.com/reel/123456789/");
    expect(canonical(new URL("https://www.facebook.com/boost/videos/123456789/"), "123456789")).toBe(
      "https://www.facebook.com/boost/videos/123456789/",
    );
  });

  it("caption, counts, thumbnail and page name", () => {
    const v = readVideoPage(VIDEO_PAGE);
    expect(v.caption).toBe("দাম লুকালে সেল কমে,\n#fcommerce #onlinebusiness");
    expect([v.views, v.reactions]).toEqual([65000, 1100]);
    expect(v.image).toBe("https://scontent.fdac24-5.fna.fbcdn.net/v/t15/x.jpg?stp=a&oe=1");
    expect(v.pageFromTitle).toBe("Boost Marketing");
    expect(readEmbedPage(EMBED_PAGE)).toEqual({ name: "Boost Marketing", path: "/61595841376442" });
    expect(readEmbedPage("<p>nothing</p>")).toBeNull();
    expect(titleOf("দাম লুকালে সেল কমে,\n#fcommerce")).toBe("দাম লুকালে সেল কমে,");
    expect(titleOf("#only #tags\nSecond line here")).toBe("Second line here");
    expect([count("21K"), count("1.1K"), count("2,345"), count("3M")]).toEqual([21000, 1100, 2345, 3000000]);
    expect(decode("a &amp; b &#039;c&#039; &#x9a6;")).toBe("a & b 'c' দ");
  });
});

describe("/api/fb", () => {
  const call = (path: string) => {
    const url = new URL(`https://reel.test${path}`);
    return handleFb(new Request(url), url);
  };

  it("a share link: everything filled in", async () => {
    const asked = fakeFacebook();
    const r = await call(`/api/fb/meta?url=${encodeURIComponent("https://www.facebook.com/share/v/1CwWegbMzR/")}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      id: "1141407915517139",
      url: "https://www.facebook.com/reel/1141407915517139/",
      title: "দাম লুকালে সেল কমে,",
      caption: "দাম লুকালে সেল কমে,\n#fcommerce #onlinebusiness",
      views: 65000,
      reactions: 1100,
      page: { name: "Boost Marketing", path: "/61595841376442" },
      embeddable: true,
      cats: expect.arrayContaining(["ecom"]),
    });
    for (const a of asked) expect(new URL(a).hostname).toMatch(/(^|\.)facebook\.com$/);
  });

  it("only Facebook: other sites and redirects away from Facebook are refused", async () => {
    const asked = fakeFacebook();
    expect((await call(`/api/fb/meta?url=${encodeURIComponent("https://evil.example/reel/123456789")}`)).status).toBe(422);
    expect((await call(`/api/fb/meta?url=${encodeURIComponent("https://www.facebook.com/share/evil")}`)).status).toBe(422);
    expect(asked.some((a) => a.includes("evil.example"))).toBe(false);
    expect(await resolve(new URL("http://localhost/reel/123456789"))).toBeNull();
    expect((await call("/api/fb/meta")).status).toBe(400);
  });

  it("not embeddable / page missing: still answers with what it has", async () => {
    fakeFacebook({ oembed: 400, videoStatus: 500 });
    const j = (await (
      await call(`/api/fb/meta?url=${encodeURIComponent("https://www.facebook.com/reel/1141407915517139")}`)
    ).json()) as any;
    expect(j).toMatchObject({ id: "1141407915517139", title: "", embeddable: false, page: { name: "Boost Marketing" } });
  });

  it("thumbnails: a redirect to Facebook's current image", async () => {
    fakeFacebook();
    const r = await call("/api/fb/thumb/1141407915517139");
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toMatch(/^https:\/\/scontent\.[\w.-]+\.fbcdn\.net\//);
    expect((await call("/api/fb/thumb/abc")).status).toBe(404);
  });

  it("the app's Worker answers /api/fb itself (not the sync Worker)", async () => {
    fakeFacebook();
    const sync = vi.fn(async () => Response.json({ ok: true }));
    const env = { ASSETS: { fetch: async () => new Response("") }, SYNC: { fetch: sync } } as unknown as AppEnv;
    const r = await app.fetch(new Request("https://reel.test/api/fb/thumb/1141407915517139", { headers: { Cookie: "rf=t" } }), env);
    expect(r.status).toBe(302);
    // the only thing asked of the sync Worker is whether the cookie's session is good
    expect(sync.mock.calls.map(([q]) => new URL((q as unknown as Request).url).pathname)).toEqual(["/session"]);
  });
});
