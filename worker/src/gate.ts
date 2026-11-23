/**
 * The password gate (used by app.ts). The whole site is private: without the password the only thing
 * anyone gets is a login page. Signing in sets a cookie holding the same signed session the sync
 * Worker issues; that Worker (service binding) says whether it's still good, so there is one password,
 * one lockout (5 wrong tries → 15 minutes) and one place that decides.
 */
import type { AppEnv } from "./app";

const COOKIE = "rf";
const COOKIE_SECONDS = 180 * 86400; // same as the session itself
const KEY = "ecomgy-reel-feed.sync"; // where the app keeps its login on this device (src/sync.ts)

/** Sessions the sync Worker confirmed recently: not asked again for a minute. */
const known = new Map<string, number>();

export const cookieOf = (req: Request) => /(?:^|;\s*)rf=([\w.-]+)/.exec(req.headers.get("Cookie") ?? "")?.[1] ?? "";

export async function isSignedIn(req: Request, url: URL, env: AppEnv): Promise<boolean> {
  const token = cookieOf(req);
  if (!token) return false;
  if ((known.get(token) ?? 0) > Date.now()) return true;
  known.delete(token);
  try {
    const r = await env.SYNC.fetch(
      new Request("https://sync.internal/session", { headers: { Authorization: `Bearer ${token}`, Origin: url.origin } }),
    );
    if (!r.ok) return false;
  } catch {
    return false; // can't tell → keep the door shut
  }
  if (known.size > 50) known.clear();
  known.set(token, Date.now() + 60_000);
  return true;
}

const setCookie = (value: string, seconds: number) => `${COOKIE}=${value}; Max-Age=${seconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;

/** POST /gate/login {password} → the sync Worker checks it (and counts wrong tries); on success the cookie is set. */
export async function gateLogin(req: Request, url: URL, env: AppEnv): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("Origin", url.origin);
  const r = await env.SYNC.fetch(new Request("https://sync.internal/login", { method: "POST", headers, body: await req.text() }));
  const out = new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!r.ok) return out;
  const text = await out.clone().text();
  const session = (JSON.parse(text) as { session?: string }).session;
  if (!session) return Response.json({ error: "Couldn't sign in." }, { status: 502 });
  out.headers.append("Set-Cookie", setCookie(session, COOKIE_SECONDS));
  return out;
}

export const gateLogout = () =>
  new Response(null, { status: 204, headers: { "Set-Cookie": setCookie("", 0), "Cache-Control": "no-store" } });

/** True when a browser is asking for a page (not a script or data file). */
export const wantsPage = (req: Request) =>
  req.method === "GET" && (req.headers.get("Sec-Fetch-Dest") === "document" || (req.headers.get("Accept") ?? "").includes("text/html"));

export const loginPage = () =>
  new Response(LOGIN_HTML, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });

const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta name="theme-color" content="#14151a" />
<title>Ecomgy Reel Feed</title>
<style>
  :root { color-scheme: dark light; --bg: #14151a; --fg: #fff; --muted: #a0a3b1; --card: #22232b; --line: #3a3c48; --accent: #ff3b5c; }
  @media (prefers-color-scheme: light) { :root { --bg: #f5f5f7; --fg: #15161a; --muted: #5d6070; --card: #fff; --line: #cfd1da; --accent: #d6153a; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.4 system-ui, sans-serif; }
  main { width: min(360px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p { margin: 0 0 16px; color: var(--muted); font-size: 14px; }
  label { display: block; font-size: 14px; margin-bottom: 6px; }
  input, button { width: 100%; font: inherit; border-radius: 10px; padding: 12px; }
  input { border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  button { margin-top: 12px; border: 0; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  #msg { min-height: 20px; margin: 10px 0 0; font-size: 14px; color: #ff6b6b; }
  @media (prefers-color-scheme: light) { #msg { color: #b00020; } }
</style>
</head>
<body>
<main>
  <h1>Ecomgy Reel Feed</h1>
  <p>This is a private app. Enter the password to continue.</p>
  <form id="f">
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password" autofocus required />
    <button id="go" type="submit">Open the app</button>
    <div id="msg" role="alert"></div>
  </form>
</main>
<script>
  var KEY = ${JSON.stringify(KEY)};
  var f = document.getElementById("f"), pw = document.getElementById("pw"), go = document.getElementById("go"), msg = document.getElementById("msg");
  f.onsubmit = async function (e) {
    e.preventDefault();
    msg.textContent = "";
    go.disabled = true;
    try {
      var r = await fetch("/gate/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw.value }) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) { msg.textContent = j.error || "Couldn't sign in."; go.disabled = false; return; }
      // the app keeps its own copy of the login on this device, so it needn't ask again
      try {
        var c = null;
        try { c = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (x) {}
        localStorage.setItem(KEY, JSON.stringify(c ? Object.assign({}, c, { session: j.session }) : { session: j.session, merged: false }));
      } catch (x) {}
      location.reload();
    } catch (x) {
      msg.textContent = "Couldn't reach the server. Check your connection.";
      go.disabled = false;
    }
  };
</script>
</body>
</html>`;
