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
  const CAP = 5000; // most reels collected from one page (was 300; the panel lists 400 at a time, so a long list stays quick)
  const reels = new Map(); // id -> { id, views, viewsText, thumb, pos }

  // ---- a guard on the auto-scroll, so a long session can't get your Facebook account in trouble.
  // It counts what the auto-scroll does (steps, minutes, reels found), warns at 80%, stops at the limit
  // and asks for a break; and stops at once if Facebook shows a warning of its own. Your own scrolling and
  // clicking are never limited. The numbers are cautious on purpose.
  const LIMITS = { steps: 150, dayReels: 3000, dayMs: 30 * 60000, cooldownMs: 10 * 60000, warnAt: 0.8 };
  const FB_WARNING =
    /temporarily (blocked|restricted|locked)|try again later|going too fast|too many requests|slow down|suspicious activity|confirm (that )?you.?re (a )?human|we limit how often|security check|আপনি খুব দ্রুত|পরে আবার চেষ্টা করুন|সাময়িকভাবে/i;
  const dayKey = () => new Date().toLocaleDateString("en-CA");
  let guard = { day: dayKey(), reels: 0, ms: 0, cooldownUntil: 0, reason: "" }; // today's totals (saved in the browser)
  let guardNote = null; // { level: "warn" | "stop", text }
  chrome.storage.local.get("guard").then((s) => {
    if (s.guard?.day === dayKey()) guard = s.guard;
    push();
  });
  const saveGuard = () => chrome.storage.local.set({ guard }).catch(() => {});
  const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));
  /** Facebook's own "slow down" messages (in a dialog or an alert, or a checkpoint page). */
  function facebookWarns() {
    if (/\/checkpoint\b/.test(location.pathname)) return true;
    for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')) {
      if (FB_WARNING.test((el.innerText || "").slice(0, 600))) return true;
    }
    return false;
  }
  function guardView() {
    if (!running) {
      // the note follows the state: a break that is over clears itself
      const b = mayNotScroll();
      if (b) guardNote = b;
      else if (guardNote?.level === "stop") guardNote = null;
    }
    return {
      reels: guard.reels,
      ms: guard.ms,
      limits: { dayReels: LIMITS.dayReels, dayMs: LIMITS.dayMs, steps: LIMITS.steps },
      cooldownUntil: guard.cooldownUntil,
      note: guardNote,
    };
  }
  /** Why the auto-scroll may not start (or go on) right now, or null. */
  function mayNotScroll() {
    if (guard.day !== dayKey()) guard = { day: dayKey(), reels: 0, ms: 0, cooldownUntil: 0, reason: "" };
    const wait = guard.cooldownUntil - Date.now();
    if (wait > 0 && guard.reason === "facebook")
      return { level: "stop", text: `Facebook showed a warning, so auto-scroll is paused for ${minutes(wait)} more min. Scroll by hand until then.` };
    if (wait > 0) return { level: "stop", text: `Take a break: you can use Keep scrolling again in ${minutes(wait)} min. (Scrolling by hand is always fine.)` };
    if (guard.reels >= LIMITS.dayReels)
      return { level: "stop", text: `That's ${LIMITS.dayReels.toLocaleString()} reels collected by auto-scroll today. Stop for today, and carry on tomorrow (scrolling by hand is fine).` };
    if (guard.ms >= LIMITS.dayMs)
      return { level: "stop", text: `That's ${minutes(LIMITS.dayMs)} minutes of auto-scroll today. Stop for today, and carry on tomorrow (scrolling by hand is fine).` };
    return null;
  }
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
    return { t: "reels", key, page: pageInfo(), reels: [...reels.values()], running, cap: CAP, guard: guardView() };
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
    const block = mayNotScroll();
    if (block) {
      guardNote = block;
      return push();
    }
    guardNote = null;
    running = true;
    const k = key;
    push();
    let idle = 0;
    let steps = 0;
    let stopped = null; // why the guard ended this run
    const started = Date.now();
    const foundAtStart = reels.size;
    const settle = () => {
      // what this run used is added to today's totals
      guard.ms += Date.now() - started;
      guard.reels += Math.max(0, reels.size - foundAtStart);
      if (stopped?.fb) {
        guard.cooldownUntil = Date.now() + 60 * 60000; // Facebook said slow down: an hour off
        guard.reason = "facebook";
      } else if (stopped || steps >= 60) {
        guard.cooldownUntil = Date.now() + LIMITS.cooldownMs; // a long run needs a rest
        guard.reason = "";
      }
      void saveGuard();
    };
    while (running && alive() && isReelsTab() && key === k && idle < 3 && reels.size < CAP) {
      const before = reels.size;
      window.scrollBy({ top: Math.round(window.innerHeight * (0.6 + Math.random() * 0.4)), behavior: "smooth" });
      await sleep(1500 + Math.random() * 1000);
      collect();
      steps++;
      idle = reels.size > before ? 0 : idle + 1;
      // the guard: Facebook's own warning, this run's limit, today's limits
      const usedMs = guard.ms + (Date.now() - started);
      const usedReels = guard.reels + (reels.size - foundAtStart);
      if (facebookWarns()) {
        stopped = { level: "stop", fb: true, text: "Facebook is showing a warning, so auto-scroll stopped. It stays off for an hour; scroll by hand until then." };
      } else if (steps >= LIMITS.steps) {
        stopped = { level: "stop", text: `That was a long run (${steps} steps). Take a ${minutes(LIMITS.cooldownMs)}-minute break before Keep scrolling again.` };
      } else if (usedReels >= LIMITS.dayReels || usedMs >= LIMITS.dayMs) {
        stopped = mayNotScrollAfter(usedReels, usedMs);
      } else if (usedReels >= LIMITS.dayReels * LIMITS.warnAt || usedMs >= LIMITS.dayMs * LIMITS.warnAt) {
        guardNote = { level: "warn", text: "You're close to today's limit for auto-scroll. Finish this page and take a break." };
      }
      if (stopped) {
        guardNote = stopped;
        running = false;
      }
      push();
    }
    settle();
    running = false;
    push();
  }
  /** The note for hitting a daily limit during a run. */
  function mayNotScrollAfter(reelsUsed, msUsed) {
    return reelsUsed >= LIMITS.dayReels
      ? { level: "stop", text: `That's ${LIMITS.dayReels.toLocaleString()} reels collected by auto-scroll today. Stop for today, and carry on tomorrow (scrolling by hand is fine).` }
      : { level: "stop", text: `That's ${minutes(LIMITS.dayMs)} minutes of auto-scroll today. Stop for today, and carry on tomorrow (scrolling by hand is fine).` };
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
