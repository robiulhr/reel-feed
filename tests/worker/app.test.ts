/**
 * The app's Worker (worker/src/app.ts): /api pass-through to the sync Worker, and link previews for
 * shared Shorts. Runs in-process with fake ASSETS/SYNC bindings and a fake YouTube oEmbed — no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import app, { type AppEnv, isPreviewBot, withPreview } from "../../worker/src/app";

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <title>Ecomgy Reel Feed</title>
    <meta name="description" content="General" />
    <meta property="og:title" content="Ecomgy Reel Feed" />
  </head>
  <body></body>
</html>`;

const WHATSAPP = "WhatsApp/2.23.20.0 A";
const FACEBOOK = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";

function env() {
  const sync: Request[] = [];
  const e: AppEnv = {
    ASSETS: { fetch: async () => new Response(PAGE, { headers: { "Content-Type": "text/html" } }) } as unknown as Fetcher,
    SYNC: {
      fetch: async (r: Request) => {
        const path = new URL(r.url).pathname;
        if (path === "/session") {
          // the sync Worker says whether the session in the cookie is still good
          return r.headers.get("Authorization") === "Bearer good-token" ? Response.json({ ok: true }) : Response.json({}, { status: 401 });
        }
        if (path === "/login") {
          const { password } = (await r.json()) as { password: string };
          return password === "pw" ? Response.json({ session: "good-token" }) : Response.json({ error: "Wrong password" }, { status: 401 });
        }
        sync.push(r);
        return Response.json({ ok: true });
      },
    } as unknown as Fetcher,
  };
  return { e, sync };
}
/** A request from someone signed in (they have the cookie) unless headers say otherwise. */
const get = (path: string, ua = CHROME, headers: Record<string, string> = {}) =>
  new Request(`https://reel.test${path}`, { headers: { "User-Agent": ua, Cookie: "rf=good-token", ...headers } });
const anon = (path: string, ua = CHROME, headers: Record<string, string> = {}) =>
  new Request(`https://reel.test${path}`, { headers: { "User-Agent": ua, ...headers } });

function fakeOembed(body: unknown, status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("link previews", () => {
  it("recognises the apps that draw preview cards, not people's browsers", () => {
    for (const ua of [
      WHATSAPP,
      FACEBOOK,
      "TelegramBot (like TwitterBot)",
      "Slackbot-LinkExpanding 1.0",
      "Mozilla/5.0 (compatible; Discordbot/2.0)",
    ])
      expect(isPreviewBot(ua), ua).toBe(true);
    for (const ua of [CHROME, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", ""]) expect(isPreviewBot(ua), ua).toBe(false);
  });

  it("a shared Short shows its title, channel and thumbnail (the general tags are replaced)", async () => {
    const oembed = fakeOembed({ title: "Why brands win", author_name: "Ads Lab" });
    const { e } = env();
    const r = await app.fetch(anon("/v/abcDEF12345", WHATSAPP), e);
    const html = await r.text();
    expect(String(oembed.mock.calls[0][0])).toContain(encodeURIComponent("https://www.youtube.com/shorts/abcDEF12345"));
    expect(html).toContain('<meta property="og:title" content="Why brands win" />');
    expect(html).toContain('<meta property="og:description" content="Ads Lab · Ecomgy Reel Feed" />');
    expect(html).toContain('<meta property="og:image" content="https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg" />');
    expect(html).toContain('<meta property="og:url" content="https://reel.test/v/abcDEF12345" />');
    expect(html).toContain("<title>Why brands win</title>");
    expect(html.match(/og:title/g)).toHaveLength(1); // the general one is gone
    expect(html).not.toContain('content="General"');
  });

  it("titles can't break out of the page (escaped)", () => {
    const html = withPreview(PAGE, { id: "abcDEF12345", title: `"><script>alert(1)</script>`, channel: "A & B" }, "https://x/v/1");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#34;&#62;&#60;script&#62;");
    expect(html).toContain("A &#38; B · Ecomgy Reel Feed");
  });

  it("if YouTube doesn't answer, the card still has the thumbnail and a general title", async () => {
    fakeOembed({ error: "Not Found" }, 404);
    const { e } = env();
    const html = await (await app.fetch(anon("/v/abcDEF12345", FACEBOOK), e)).text();
    expect(html).toContain('og:title" content="A Short on Ecomgy Reel Feed"');
    expect(html).toContain("hqdefault.jpg");
  });

  it("signed-in people opening the link get the normal app, with no call to YouTube", async () => {
    const oembed = fakeOembed({});
    const { e } = env();
    const html = await (await app.fetch(get("/v/abcDEF12345"), e)).text();
    expect(html).toBe(PAGE);
    expect(oembed).not.toHaveBeenCalled();
  });
});

describe("/api → sync Worker", () => {
  it("passes the request on without /api and says it comes from this site", async () => {
    const { e, sync } = env();
    await app.fetch(get("/api/state?x=1", CHROME, { Authorization: "Bearer t" }), e);
    expect(new URL(sync[0].url).pathname).toBe("/state");
    expect(new URL(sync[0].url).search).toBe("?x=1");
    expect(sync[0].headers.get("Origin")).toBe("https://reel.test");
    expect(sync[0].headers.get("Authorization")).toBe("Bearer t");
  });

  it("keeps another site's Origin (so the sync Worker refuses it)", async () => {
    const { e, sync } = env();
    await app.fetch(get("/api/state", CHROME, { Origin: "https://evil.example" }), e);
    expect(sync[0].headers.get("Origin")).toBe("https://evil.example");
  });
});

describe("password gate", () => {
  const PAGE_REQUEST = { Accept: "text/html,application/xhtml+xml", "Sec-Fetch-Dest": "document" };

  it("without the password a browser gets only the login page (no app, no data)", async () => {
    const { e, sync } = env();
    const r = await app.fetch(anon("/", CHROME, PAGE_REQUEST), e);
    expect(r.status).toBe(401);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain("Enter the password");
    expect(html).not.toBe(PAGE);
    expect(sync).toHaveLength(0);
  });

  it("the app's own service worker re-fetches pages without asking for HTML — it still gets the login page", async () => {
    const { e } = env();
    for (const path of ["/", "/saved", "/channel/@hook", "/v/abcDEF12345?x=1".replace("/v/abcDEF12345", "/menu")]) {
      const r = await app.fetch(anon(path, CHROME, { Accept: "*/*" }), e);
      expect(r.status, path).toBe(401);
      expect(r.headers.get("Content-Type"), path).toContain("text/html");
    }
  });

  it("scripts, data and the API answer 401 without the password — nothing is served or passed on", async () => {
    const { e, sync } = env();
    for (const path of ["/assets/index-abc.js", "/data/cache.json", "/api/state2", "/api/fb/lookup?id=1", "/sw.js"]) {
      const r = await app.fetch(anon(path), e);
      expect(r.status, path).toBe(401);
    }
    expect(sync).toHaveLength(0);
  });

  it("a wrong or old cookie doesn't count", async () => {
    const { e } = env();
    for (const cookie of ["rf=forged.token", "rf=", "other=good-token"]) {
      const r = await app.fetch(anon("/", CHROME, { ...PAGE_REQUEST, Cookie: cookie }), e);
      expect(r.status, cookie).toBe(401);
    }
  });

  it("the install icon and manifest stay open", async () => {
    const { e } = env();
    expect((await app.fetch(anon("/manifest.webmanifest"), e)).status).toBe(200);
    expect((await app.fetch(anon("/icon.svg"), e)).status).toBe(200);
  });

  it("the right password sets a private cookie (HttpOnly, Secure) and hands back the session; a wrong one doesn't", async () => {
    const { e } = env();
    const login = (password: string) =>
      app.fetch(new Request("https://reel.test/gate/login", { method: "POST", body: JSON.stringify({ password }) }), e);
    const bad = await login("nope");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("Set-Cookie")).toBeNull();
    const good = await login("pw");
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ session: "good-token" });
    const cookie = good.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("rf=good-token");
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("signing out clears the cookie", async () => {
    const { e } = env();
    const r = await app.fetch(new Request("https://reel.test/gate/logout", { method: "POST" }), e);
    expect(r.headers.get("Set-Cookie")).toMatch(/rf=; Max-Age=0/);
  });

  it("a shared Short: chat apps still get the preview card; people without the password go to YouTube", async () => {
    fakeOembed({ title: "Why brands win", author_name: "Ads Lab" });
    const { e } = env();
    const bot = await app.fetch(anon("/v/abcDEF12345", WHATSAPP), e);
    expect(await bot.text()).toContain("Why brands win");
    const person = await app.fetch(anon("/v/abcDEF12345"), e);
    expect(person.status).toBe(302);
    expect(person.headers.get("Location")).toBe("https://www.youtube.com/shorts/abcDEF12345");
  });

  it("signed in, the app and its files are served", async () => {
    const { e } = env();
    expect(await (await app.fetch(get("/", CHROME, PAGE_REQUEST), e)).text()).toBe(PAGE);
  });
});
