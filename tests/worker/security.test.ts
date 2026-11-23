import { afterEach, describe, expect, it, vi } from "vitest";
import { call, login, setup, TOKEN_EXPIRY } from "./harness";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("login attempt limit", () => {
  it("5 wrong passwords lock that connection for 15 minutes — even the right password", async () => {
    const f = setup();
    for (let i = 1; i <= 5; i++) {
      const r = await call(f, "POST", "/login", { body: { password: `guess${i}` }, ip: "9.9.9.9" });
      expect(r.status).toBe(401);
    }
    const locked = await call(f, "POST", "/login", { body: { password: "correct horse" }, ip: "9.9.9.9" });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/15 minutes/);
    // another connection is not affected
    expect((await call(f, "POST", "/login", { body: { password: "correct horse" }, ip: "8.8.8.8" })).status).toBe(200);
  }, 30_000);

  it("tells you how many tries are left, and a correct login resets the count", async () => {
    const f = setup();
    const r = await call(f, "POST", "/login", { body: { password: "nope" }, ip: "7.7.7.7" });
    expect(r.body.error).toMatch(/4 tries left/);
    expect((await call(f, "POST", "/login", { body: { password: "correct horse" }, ip: "7.7.7.7" })).status).toBe(200);
    expect(f.kv.map.has("login-fail:7.7.7.7")).toBe(false);
  });
});

describe("security headers", () => {
  it("every answer carries them", async () => {
    const f = setup();
    const r = await call(f, "POST", "/login", { body: { password: "correct horse" } });
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("health + token expiry", () => {
  it("reports when the GitHub token expires (read from GitHub's own response)", async () => {
    const f = setup();
    const s = await login(f);
    const h = await call(f, "GET", "/health", { session: s });
    expect(h.status).toBe(200);
    expect(h.body.ok).toBe(true);
    expect(h.body.tokenExpires).toBe(TOKEN_EXPIRY);
  });

  it("needs a login", async () => {
    const f = setup();
    expect((await call(f, "GET", "/health")).status).toBe(401);
  });
});

describe("error reports from the app", () => {
  it("are stored (newest first, max 50) and counted in health", async () => {
    const f = setup();
    const s = await login(f);
    for (let i = 0; i < 3; i++) await call(f, "POST", "/log", { session: s, body: { msg: `boom ${i}`, where: "main.ts:1", ver: "v" } });
    const log = JSON.parse(f.kv.map.get("errlog")!);
    expect(log.map((e: any) => e.msg)).toEqual(["boom 2", "boom 1", "boom 0"]);
    expect((await call(f, "GET", "/health", { session: s })).body.errorsLast7d).toBe(3);
  });

  it("are rate limited (a crash loop can't flood the server)", async () => {
    const f = setup();
    const s = await login(f);
    const results = [];
    for (let i = 0; i < 25; i++) results.push((await call(f, "POST", "/log", { session: s, body: { msg: `x${i}` } })).body.ok);
    expect(results.filter(Boolean).length).toBe(20);
  });

  it("long messages are cut to a safe size", async () => {
    const f = setup();
    const s = await login(f);
    await call(f, "POST", "/log", { session: s, body: { msg: "a".repeat(5000), stack: "b".repeat(9000) } });
    const [e] = JSON.parse(f.kv.map.get("errlog")!);
    expect(e.msg.length).toBe(300);
    expect(e.stack.length).toBe(1500);
  });
});

describe("GET /session (what the app's password gate asks)", () => {
  it("is fine for a good session and refused without one", async () => {
    const f = setup();
    const session = await login(f);
    expect((await call(f, "GET", "/session", { session })).status).toBe(200);
    expect((await call(f, "GET", "/session")).status).toBe(401);
    expect((await call(f, "GET", "/session", { session: "forged.token" })).status).toBe(401);
  });
});
