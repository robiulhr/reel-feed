/**
 * Error catcher: if something unexpected breaks, the app tells you (with a Reload button) instead of
 * silently freezing, and quietly reports it to the sync server so the cause can be found
 * (`npx wrangler tail`, or the last 50 reports kept in Cloudflare KV under "errlog").
 */
import { addLocalLog } from "./locallog";
import * as sync from "./sync";
import { toastError } from "./ui";

const seen = new Set<string>();
let reportsThisSession = 0;

/** Noise that isn't a real problem in our app. */
function ignorable(msg: string) {
  return /ResizeObserver loop|^Script error\.?$|AbortError|The play\(\) request was interrupted|Load failed|NotAllowedError/i.test(msg);
}

export function report(msg: string, where: string, stack?: string) {
  if (!msg || ignorable(msg)) return;
  const key = `${msg}|${where}`;
  if (seen.has(key)) return;
  seen.add(key);
  addLocalLog("error", false, `${msg.slice(0, 200)} (${where})`);
  console.error("[reel-feed]", msg, where, stack ?? "");
  toastError("Something went wrong. If the app misbehaves, reload it.", () => location.reload());
  if (!sync.isConnected() || reportsThisSession >= 10) return;
  reportsThisSession++;
  sync
    .call("/log", {
      method: "POST",
      body: JSON.stringify({ msg, where, stack: stack?.slice(0, 1500), ver: typeof __BUILD__ === "string" ? __BUILD__ : "" }),
    })
    .catch(() => {
      /* reporting must never cause more errors */
    });
}

export function installErrorCatcher() {
  window.addEventListener("error", (e) => {
    const where = e.filename ? `${e.filename.split("/").pop()}:${e.lineno}:${e.colno}` : "window";
    report(e.message || String(e.error), where, e.error?.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    report(r instanceof Error ? r.message : String(r), "promise", r instanceof Error ? r.stack : undefined);
  });
}
