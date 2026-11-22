import { afterEach, describe, expect, it, vi } from "vitest";
import { call, channelsOnGitHub, login, setup } from "./harness";

afterEach(() => vi.unstubAllGlobals());

describe("access", () => {
  it("rejects other websites", async () => {
    const f = setup();
    const r = await call(f, "GET", "/channels", { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("wrong password → 401, right password → session", async () => {
    const f = setup();
    expect((await call(f, "POST", "/login", { body: { password: "nope" } })).status).toBe(401);
    expect(await login(f)).toMatch(/\./);
  });

  it("no session or a forged session → 401", async () => {
    const f = setup();
    expect((await call(f, "GET", "/channels")).status).toBe(401);
    const s = await login(f);
    const forged = `${s.split(".")[0]}.AAAAAAAA`;
    expect((await call(f, "GET", "/channels", { session: forged })).status).toBe(401);
  });

  it("allows the request-ID header (CORS preflight)", async () => {
    const f = setup();
    const r = await call(f, "OPTIONS", "/channels");
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Headers")).toContain("X-Request-Id");
  });
});

describe("channel list edits", () => {
  it("add → remove → restore → remove → delete", async () => {
    const f = setup();
    const s = await login(f);
    const add = { t: "add", channel: { name: "Pricing Lab", handle: "@pricinglab", id: "UCpricing00000000000000a", cat: "ads" } };
    expect((await call(f, "POST", "/channels", { session: s, body: { ops: [add] } })).status).toBe(200);
    expect(channelsOnGitHub(f).map((c) => c.handle)).toContain("@pricinglab");

    expect((await call(f, "POST", "/channels", { session: s, body: { ops: [add] } })).status).toBe(409); // already listed

    await call(f, "POST", "/channels", { session: s, body: { ops: [{ t: "remove", h: "@PRICINGLAB" }] } });
    expect(channelsOnGitHub(f).find((c) => c.handle === "@pricinglab").status).toBe("removed");

    await call(f, "POST", "/channels", { session: s, body: { ops: [{ t: "restore", h: "@pricinglab" }] } });
    expect(channelsOnGitHub(f).find((c) => c.handle === "@pricinglab").status).toBeUndefined();

    // delete is only allowed after remove (the "second deletion")
    expect((await call(f, "POST", "/channels", { session: s, body: { ops: [{ t: "delete", h: "@pricinglab" }] } })).status).toBe(400);
    await call(f, "POST", "/channels", {
      session: s,
      body: {
        ops: [
          { t: "remove", h: "@pricinglab" },
          { t: "delete", h: "@pricinglab" },
        ],
      },
    });
    expect(channelsOnGitHub(f).some((c) => c.handle === "@pricinglab")).toBe(false);
  });

  it("accepts Bangla (non-English) handles", async () => {
    const f = setup();
    const s = await login(f);
    const r = await call(f, "POST", "/channels", {
      session: s,
      body: { ops: [{ t: "add", channel: { name: "দোকানের গল্প", handle: "@দোকানেরগল্প", cat: "bangla" } }] },
    });
    expect(r.status).toBe(200);
  });

  it("rejects unknown categories and bad handles", async () => {
    const f = setup();
    const s = await login(f);
    expect((await call(f, "POST", "/channels", { session: s, body: { ops: [{ t: "cat", h: "@hook", cat: "hacker" }] } })).status).toBe(400);
    expect(
      (
        await call(f, "POST", "/channels", {
          session: s,
          body: { ops: [{ t: "add", channel: { name: "x", handle: "no-at-sign", cat: "ads" } }] },
        })
      ).status,
    ).toBe(400);
  });

  it("several changes in one request = one GitHub commit", async () => {
    const f = setup();
    const s = await login(f);
    const before = f.ghWrites();
    await call(f, "POST", "/channels", {
      session: s,
      body: {
        ops: [
          { t: "cat", h: "@hook", cat: "ads" },
          { t: "cat", h: "@hook", cat: "books" },
        ],
      },
    });
    expect(f.ghWrites() - before).toBe(1);
    // an older app's single category is translated to the new list
    expect(channelsOnGitHub(f)[0].cats).toEqual(["growth", "money"]);
    expect(channelsOnGitHub(f)[0].cat).toBeUndefined();
  });

  it("saves several categories per channel (main first) and checks them", async () => {
    const f = setup();
    const s = await login(f);
    const ok = await call(f, "POST", "/channels", { session: s, body: { ops: [{ t: "cats", h: "@hook", cats: ["sales", "marketing"] }] } });
    expect(ok.status).toBe(200);
    expect(channelsOnGitHub(f)[0].cats).toEqual(["sales", "marketing"]);
    const add = await call(f, "POST", "/channels", {
      session: s,
      body: { ops: [{ t: "add", channel: { name: "Quran Daily", handle: "@qurandaily", cats: ["quran", "waz"] } }] },
    });
    expect(add.status).toBe(200);
    expect(channelsOnGitHub(f).find((c) => c.handle === "@qurandaily")?.cats).toEqual(["quran", "waz"]);
    for (const cats of [["sales", "hacker"], []]) {
      const bad = await call(f, "POST", "/channels", { session: s, body: { ops: [{ t: "cats", h: "@hook", cats }] } });
      expect(bad.status, JSON.stringify(cats)).toBe(400);
    }
    // more than 3 → only the first 3 are kept
    await call(f, "POST", "/channels", { session: s, body: { ops: [{ t: "cats", h: "@hook", cats: ["ads", "ecom", "sales", "ai"] }] } });
    expect(channelsOnGitHub(f)[0].cats).toEqual(["ads", "ecom", "sales"]);
  });
});

describe("duplicate protection (request IDs)", () => {
  it("the same request ID twice is applied once; the repeat gets the saved answer", async () => {
    const f = setup();
    const s = await login(f);
    const body = { ops: [{ t: "cat", h: "@hook", cat: "ads" }] };
    const a = await call(f, "POST", "/channels", { session: s, body, rid: "req-1234567890" });
    const writes = f.ghWrites();
    const b = await call(f, "POST", "/channels", { session: s, body, rid: "req-1234567890" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get("X-Repeat")).toBe("1");
    expect(f.ghWrites()).toBe(writes);
  });

  it("two identical requests at the same moment are applied once", async () => {
    const f = setup();
    const s = await login(f);
    const before = f.ghWrites();
    const body = { ops: [{ t: "remove", h: "@hook" }] };
    const [a, b] = await Promise.all([
      call(f, "POST", "/channels", { session: s, body, rid: "same-moment-123" }),
      call(f, "POST", "/channels", { session: s, body, rid: "same-moment-123" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(f.ghWrites() - before).toBe(1);
  });

  it("a request that failed can be retried with the same ID once the problem is gone", async () => {
    const f = setup();
    const s = await login(f);
    const saved = f.files.get("me/code/channels.json")!;
    f.files.delete("me/code/channels.json"); // first attempt fails (list unavailable)
    const body = { ops: [{ t: "remove", h: "@hook" }] };
    const first = await call(f, "POST", "/channels", { session: s, body, rid: "retry-me-12345" });
    expect(first.status).toBe(404);
    f.files.set("me/code/channels.json", saved); // problem fixed
    const again = await call(f, "POST", "/channels", { session: s, body, rid: "retry-me-12345" });
    expect(again.status).toBe(200);
    expect(again.headers.get("X-Repeat")).toBeNull(); // really ran this time
    expect(channelsOnGitHub(f)[0].status).toBe("removed");
  });
});

describe("YouTube lookups, previews, searches + quota guard", () => {
  it("looks up a channel from many link styles", async () => {
    const f = setup();
    const s = await login(f);
    for (const q of [
      "@pricinglab",
      "pricinglab",
      "https://www.youtube.com/@pricinglab/shorts",
      "youtube.com/channel/UCpricing00000000000000a",
    ]) {
      const r = await call(f, "POST", "/lookup", { session: s, body: { q } });
      expect(r.status, q).toBe(200);
      expect(r.body.results[0]?.name, q).toBe("Pricing Lab");
      expect(r.body.results[0].suggestedCats.length).toBeGreaterThan(0);
      expect(r.body.results[0].suggestedCat).toBe(r.body.results[0].suggestedCats[0]); // for older app versions
    }
  });

  it("a plain name doesn't search until asked (searches cost 100)", async () => {
    const f = setup();
    const s = await login(f);
    const r = await call(f, "POST", "/lookup", { session: s, body: { q: "pricing lab channel" } });
    expect(r.body.needsSearch).toBe(true);
    expect(f.ytUnits()).toBe(0);
  });

  it("channel preview: first time costs units, second time is free (cached)", async () => {
    const f = setup();
    const s = await login(f);
    const a = await call(f, "POST", "/channel-shorts", { session: s, body: { id: "UCpricing00000000000000a" } });
    expect(a.body.units).toBeGreaterThan(0);
    expect(a.body.shorts.length).toBe(12);
    const b = await call(f, "POST", "/channel-shorts", { session: s, body: { id: "UCpricing00000000000000a" } });
    expect(b.body.units).toBe(0);
    expect(b.body.cached).toBe(true);
  });

  it("search filters out long videos and is free when repeated in any word order", async () => {
    const f = setup();
    const s = await login(f);
    const a = await call(f, "POST", "/search-shorts", { session: s, body: { q: "pricing psychology" } });
    expect(a.status).toBe(200);
    expect(a.body.results.some((r: any) => r.id.startsWith("long"))).toBe(false);
    const units = f.ytUnits();
    const b = await call(f, "POST", "/search-shorts", { session: s, body: { q: "Psychology PRICING" } });
    expect(b.body.cached).toBe(true);
    expect(f.ytUnits()).toBe(units);
  });

  it("the daily budget is enforced by the server", async () => {
    const f = setup();
    const s = await login(f);
    expect((await call(f, "POST", "/quota", { session: s, body: { budget: 9000 } })).status).toBe(400); // above max
    expect((await call(f, "POST", "/quota", { session: s, body: { budget: 120 } })).status).toBe(200);
    expect((await call(f, "POST", "/search-shorts", { session: s, body: { q: "pricing psychology" } })).status).toBe(200); // 102 units
    const over = await call(f, "POST", "/search-shorts", { session: s, body: { q: "brand stories" } });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/budget/i);
    // cached results stay free even over budget
    expect((await call(f, "POST", "/search-shorts", { session: s, body: { q: "psychology pricing" } })).status).toBe(200);
    const q = await call(f, "GET", "/quota", { session: s });
    expect(q.body.used).toBeGreaterThanOrEqual(100);
    expect(q.body.savedWeek).toBeGreaterThan(0);
  });
});

describe("synced data (user-state.json)", () => {
  it("first save creates the file; a stale save gets 409 (another device saved first)", async () => {
    const f = setup();
    const s = await login(f);
    const g = await call(f, "GET", "/state", { session: s });
    expect(g.body).toEqual({ data: null, sha: null });
    const p1 = await call(f, "PUT", "/state", { session: s, body: { data: { v: 1, saved: ["a"] }, sha: null } });
    expect(p1.status).toBe(200);
    const stale = await call(f, "PUT", "/state", { session: s, body: { data: { v: 1, saved: ["b"] }, sha: "old" } });
    expect(stale.status).toBe(409);
  });
});

describe("refresh", () => {
  it("starts the workflow and reports status", async () => {
    const f = setup();
    const s = await login(f);
    expect((await call(f, "POST", "/refresh", { session: s })).body).toEqual({ ok: true });
    expect((await call(f, "GET", "/status", { session: s })).body.run.conclusion).toBe("success");
  });
});
