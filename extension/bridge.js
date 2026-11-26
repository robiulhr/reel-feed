/**
 * Runs only on Freed's own site (see manifest.json) — never on Facebook or any other site.
 * The app posts the numbers of the Facebook videos you've already added; this keeps them for the side
 * panel, which marks those reels. Nothing else is read from the page, and nothing is sent anywhere.
 *
 * The panel also puts this script into Freed tabs that were already open when the extension was
 * installed or reloaded (Chrome only adds it to tabs opened afterwards) — so it can run twice in a
 * tab: a copy that's still connected just asks the app again.
 */
(() => {
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false; // the extension was reloaded: this copy is cut off
    }
  };
  const hello = () => window.postMessage({ source: "reel-feed-ext", t: "hello" }, location.origin);

  const prev = window.__reelFeedBridge;
  if (prev && typeof prev.alive === "function" && prev.alive()) return hello(); // already listening

  const onMessage = (e) => {
    if (!alive()) return window.removeEventListener("message", onMessage); // stop quietly after a reload
    if (e.source !== window || e.origin !== location.origin) return; // only this page, from this site
    const d = e.data;
    if (!d || d.source !== "reel-feed-app" || d.t !== "library" || !Array.isArray(d.ids)) return;
    const ids = d.ids.filter((x) => typeof x === "string" && /^\d{5,25}$/.test(x)).slice(0, 50000);
    try {
      chrome.storage.local.set({ library: { ids, at: Date.now() } });
    } catch {}
  };
  window.addEventListener("message", onMessage);
  window.__reelFeedBridge = { alive };
  hello(); // the app may have opened before this script was there: ask it to send the list
})();
