/**
 * Runs only on Reel Feed's own site (see manifest.json) — never on Facebook or any other site.
 * The app posts the numbers of the Facebook videos you've already added; this keeps them for the side
 * panel, which marks those reels. Nothing else is read from the page, and nothing is sent anywhere.
 */
(() => {
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return; // only this page, from this site
    const d = e.data;
    if (!d || d.source !== "reel-feed-app" || d.t !== "library" || !Array.isArray(d.ids)) return;
    const ids = d.ids.filter((x) => typeof x === "string" && /^\d{5,25}$/.test(x)).slice(0, 50000);
    try {
      chrome.storage.local.set({ library: { ids, at: Date.now() } });
    } catch {} // the extension was reloaded while this tab stayed open: reload the tab
  });
  // The app may have opened before this script was there: ask it to send the list again.
  window.postMessage({ source: "reel-feed-ext", t: "hello" }, location.origin);
})();
