/**
 * Put into a Facebook tab by the side panel, and only when that tab is a page's Reels tab (it is never
 * loaded on other pages). Reads the reel tiles that are on screen as you scroll:
 * link, view count, thumbnail. Nothing is sent anywhere — the side panel asks for the list.
 * "Keep scrolling" scrolls this one page slowly, like a person would, and only when you click it.
 */
(() => {
  /** False once the extension was reloaded or updated: this copy is cut off from it and must stop. */
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  // Already a working copy in this tab? Then leave it. A dead one (from before a reload) is replaced.
  const prev = window.__reelFeedCollector;
  if (prev && typeof prev.alive === "function" && prev.alive()) return;
  window.__reelFeedCollector = { alive };
  let observer = null;
  /** Stop everything (the extension was reloaded). */
  function shutdown() {
    running = false;
    observer?.disconnect();
    if (window.__reelFeedCollector?.alive === alive) window.__reelFeedCollector = null;
  }
  const CAP = 300; // most reels collected from one page
  const reels = new Map(); // id -> { id, views, viewsText, thumb, pos }
  let key = "";
  let running = false;

  const BN = "০১২৩৪৫৬৭৮৯";
  /** "3.9M" → 3900000, "812" → 812, "1,204" → 1204 (Bangla digits too); 0 if unknown. */
  function parseViews(text) {
    const t = text.replace(/[০-৯]/g, (d) => String(BN.indexOf(d))).replace(/\s+/g, "");
    const m = /^([\d.,]+)([KMB])?$/i.exec(t);
    if (!m) return 0;
    const n = m[2] ? Number.parseFloat(m[1].replace(",", ".")) : Number(m[1].replace(/[.,]/g, ""));
    return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1)) || 0;
  }

  /** Which page we're on (reels found on another page aren't mixed in). */
  function pageKey() {
    const id = new URLSearchParams(location.search).get("id");
    const path = location.pathname.replace(/\/(reels|videos)\/?$/, "/");
    return id ? `id:${id}` : path;
  }

  function isReelsTab() {
    return /\/reels\/?$/.test(location.pathname) || new URLSearchParams(location.search).get("sk") === "reels_tab";
  }

  function pageInfo() {
    const h1 = document.querySelector("h1");
    const name = (h1?.innerText || document.title.replace(/\s*\|\s*Facebook\s*$/i, "").replace(/\s+Reels$/i, "")).trim();
    const id = new URLSearchParams(location.search).get("id");
    let url = `https://www.facebook.com${location.pathname.replace(/\/(reels|videos)\/?$/, "/")}`;
    if (id && location.pathname === "/profile.php") url = `https://www.facebook.com/profile.php?id=${id}`;
    return { name, url, reelsTab: isReelsTab() };
  }

  function collect() {
    if (!isReelsTab()) return 0; // on any other Facebook page it does nothing
    const k = pageKey();
    if (k !== key) {
      key = k;
      reels.clear();
      running = false;
    }
    let added = 0;
    for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
      const m = /\/reel\/(\d+)/.exec(a.getAttribute("href") || "");
      if (!m || reels.has(m[1]) || reels.size >= CAP) continue;
      const img = a.querySelector("img");
      if (!img) continue; // only the tiles (with a picture), not links in posts' text
      const viewsText = (a.innerText || "").trim().split("\n").pop() || "";
      reels.set(m[1], { id: m[1], views: parseViews(viewsText), viewsText, thumb: img.currentSrc || img.src || "", pos: reels.size });
      added++;
    }
    return added;
  }

  function snapshot() {
    return { t: "reels", key, page: pageInfo(), reels: [...reels.values()], running, cap: CAP };
  }

  function push() {
    if (!alive()) return shutdown();
    try {
      chrome.runtime.sendMessage(snapshot()).catch(() => {}); // the panel may be closed
    } catch {} // the extension was reloaded while this tab stayed open: reload the tab
  }

  let pending = 0;
  observer = new MutationObserver(() => {
    if (!alive()) return shutdown();
    if (pending || !isReelsTab()) return;
    pending = window.setTimeout(() => {
      pending = 0;
      if (collect()) push();
    }, 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Scroll down slowly until no new reels come 3 times in a row, the cap, or Stop. */
  async function keepScrolling() {
    if (running) return;
    running = true;
    const k = key;
    push();
    let idle = 0;
    while (running && alive() && isReelsTab() && key === k && idle < 3 && reels.size < CAP) {
      const before = reels.size;
      window.scrollBy({ top: Math.round(window.innerHeight * (0.6 + Math.random() * 0.4)), behavior: "smooth" });
      await sleep(1500 + Math.random() * 1000);
      collect();
      idle = reels.size > before ? 0 : idle + 1;
      push();
    }
    running = false;
    push();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.t === "get") {
      collect();
      reply(snapshot());
    } else if (msg?.t === "scroll") {
      void keepScrolling();
      reply({ ok: true });
    } else if (msg?.t === "stop") {
      running = false;
      reply(snapshot());
    }
  });

  collect();
})();
