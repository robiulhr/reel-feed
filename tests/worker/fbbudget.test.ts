/**
 * The budget for the app's requests to Facebook (worker/src/fbbudget.ts): too many in a minute or a day are
 * refused with a plain answer; counts are reported; with no store nothing is limited.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import app, { type AppEnv } from "../../worker/src/app";
import { FB_LIMITS, fbUse, spendFb } from "../../worker/src/fbbudget";
import { memKV } from "./harness";

const NOW = Date.parse("2026-11-25T10:30:20Z");
const kvOf = () => memKV() as unknown as KVNamespace;

afterEach(() => vi.unstubAllGlobals());

describe("spending the Facebook budget", () => {
  it("allows requests up to the per-minute limit, then says how long to wait", async () => {
    const kv = kvOf();
    for (let i = 0; i < FB_LIMITS.lookup.minute; i++) expect((await spendFb(kv, "lookup", NOW)).ok).toBe(true);
    const r = await spendFb(kv, "lookup", NOW);
    expect(r).toMatchObject({ ok: false, why: "minute" });
    if (!r.ok) {
      expect(r.wait).toBe(40); // 20 s into the minute
      expect(r.message).toContain("Slow down");
    }
    expect((await spendFb(kv, "lookup", NOW + 60_000)).ok).toBe(true); // the next minute is free again
  });

  it("stops at the daily limit until midnight (UTC)", async () => {
    const kv = kvOf();
    let t = NOW;
    for (let i = 0; i < FB_LIMITS.lookup.day; i++) {
      expect((await spendFb(kv, "lookup", t)).ok).toBe(true);
      t += 61_000 / 2; // spread over minutes so the per-minute limit never trips
    }
    const r = await spendFb(kv, "lookup", t);
    expect(r).toMatchObject({ ok: false, why: "day" });
    if (!r.ok) expect(r.message).toContain("used up");
    expect((await spendFb(kv, "lookup", Date.parse("2026-11-26T00:00:30Z"))).ok).toBe(true);
  });

  it("pictures and lookups have separate budgets", async () => {
    const kv = kvOf();
    for (let i = 0; i < FB_LIMITS.lookup.minute; i++) await spendFb(kv, "lookup", NOW);
    expect((await spendFb(kv, "lookup", NOW)).ok).toBe(false);
    expect((await spendFb(kv, "image", NOW)).ok).toBe(true);
  });

  it("reports the counts, and with no store nothing is limited", async () => {
    const kv = kvOf();
    await spendFb(kv, "lookup", NOW);
    await spendFb(kv, "lookup", NOW);
    expect(await fbUse(kv, "lookup", NOW)).toMatchObject({ minute: 2, day: 2 });
    for (let i = 0; i < 500; i++) expect((await spendFb(undefined, "lookup", NOW)).ok).toBe(true);
  });
});

describe("the app's Worker answers /api/fb/* within the budget", () => {
  const SIGNED = { Cookie: "rf=good-token", "User-Agent": "Mozilla/5.0 Chrome/131" };
  const withStore = () => {
    const kv = kvOf();
    const e: AppEnv = {
      ASSETS: { fetch: async () => new Response("") } as unknown as Fetcher,
      SYNC: { fetch: async () => Response.json({ ok: true }) } as unknown as Fetcher,
      QUOTA: kv,
    };
    return e;
  };
  const get = (path: string) => new Request(`https://reel.test${path}`, { headers: SIGNED });

  it("refuses a lookup over the limit with a 429 and a Retry-After; the usage endpoint shows the counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html></html>", { status: 200 })),
    );
    const e = withStore();
    for (let i = 0; i < FB_LIMITS.lookup.minute; i++) {
      const r = await app.fetch(get("/api/fb/meta?url=https%3A%2F%2Fwww.facebook.com%2Freel%2F1141407915517139%2F"), e);
      expect(r.status).not.toBe(429);
    }
    const over = await app.fetch(get("/api/fb/meta?url=https%3A%2F%2Fwww.facebook.com%2Freel%2F1141407915517139%2F"), e);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await over.json()) as { error: string }).error).toContain("Slow down");

    const usage = (await (await app.fetch(get("/api/fb/usage"), e)).json()) as { lookup: { minute: number; limits: { minute: number } } };
    expect(usage.lookup.minute).toBe(FB_LIMITS.lookup.minute);
    expect(usage.lookup.limits.minute).toBe(40);
  });

  it("the usage endpoint needs the password like everything else", async () => {
    const r = await app.fetch(new Request("https://reel.test/api/fb/usage", { headers: { "User-Agent": "Mozilla/5.0" } }), withStore());
    expect(r.status).toBe(401);
  });
});
