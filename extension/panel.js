/**
 * The side panel: shows the reels collected from the Facebook tab you're on, lets you filter, sort,
 * search and pick, then opens Reel Feed with the picked ones ("#add=id,id,…"), where you choose
 * categories and lists and add them.
 */
const APP = "https://reel-feed.robiulhr2201.workers.dev/";
const MAX_SEND = 60; // the app adds up to 60 at a time

const $ = (id) => document.getElementById(id);
let tabId = null;
let data = null; // the content script's snapshot
const picked = new Set();
let info = {}; // id -> { t: title, d: rest of the caption } (kept on this computer)
let fetching = false;

let added = new Set(); // numbers of the reels you've already added in Reel Feed (the app sends them)
let libraryAt = 0; // when the app last sent that list (ms); 0 = never

function setLibrary(lib) {
  added = new Set(Array.isArray(lib?.ids) ? lib.ids : []);
  libraryAt = lib?.at || 0;
  for (const id of added) picked.delete(id); // can't add what you already have
}
let link = "unknown"; // Reel Feed: unknown | checking | ok (it answers) | closed (no tab) | silent (open, no answer)
let appTabIds = [];
let connecting = false;

/** Gets in touch with Reel Feed: puts the bridge script into every open Reel Feed tab (Chrome only adds
 *  it to tabs opened after the extension was installed or reloaded) and waits for the app's answer. */
async function connect() {
  if (connecting) return;
  connecting = true;
  link = "checking";
  draw();
  const before = libraryAt;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `${APP}*` });
  } catch {}
  appTabIds = tabs.map((t) => t.id);
  for (const t of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["bridge.js"] });
    } catch {}
  }
  if (tabs.length) await new Promise((r) => setTimeout(r, 1500));
  link = !tabs.length ? "closed" : libraryAt > before ? "ok" : "silent";
  connecting = false;
  draw();
}

chrome.storage.local.get(["info", "library"]).then((s) => {
  info = s.info || {};
  setLibrary(s.library);
  draw();
  void connect();
});
// The app (open in any tab) sends the list again whenever it changes: marks update at once.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.library) return;
  setLibrary(ch.library.newValue);
  link = "ok"; // it just answered
  draw();
});

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
/** Watch a reel here, at the top of the panel: Facebook's player, shown through a small page on Reel
 *  Feed's own site (Facebook's player doesn't take to sitting directly in an extension page). */
let watching = null;
function watch(id) {
  watching = id;
  const box = $("player");
  box.hidden = !id;
  box.replaceChildren();
  if (id) {
    const f = document.createElement("iframe");
    f.src = `${APP}embed/fb?id=${encodeURIComponent(id)}`; // (the site answers /embed/fb.html with a redirect to this)
    f.title = "Facebook reel";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen"; // (the allow list already covers fullscreen: Chrome warns if allowFullscreen is set too)
    const row = document.createElement("div");
    row.className = "row";
    const win = document.createElement("button");
    win.type = "button";
    win.textContent = "↗ Open in a window";
    win.title = "If it doesn't play here, watch it in a window of its own";
    win.onclick = () => void openWindow(id);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕ Close";
    close.onclick = () => watch(null);
    row.append(win, close);
    box.append(f, row);
    box.scrollIntoView({ block: "nearest" });
  }
  draw();
}

/** The same reel on Facebook, in a small window next to the panel (the next one reuses it). */
let watchWin = null;
async function openWindow(id) {
  const url = `https://www.facebook.com/reel/${id}/`;
  try {
    if (watchWin != null) {
      const w = await chrome.windows.get(watchWin, { populate: true });
      await chrome.tabs.update(w.tabs[0].id, { url });
      await chrome.windows.update(watchWin, { focused: true });
      return;
    }
  } catch {
    watchWin = null; // you closed it: open a new one
  }
  try {
    const w = await chrome.windows.create({ url, type: "popup", width: 460, height: 820 });
    watchWin = w.id;
  } catch {
    window.open(url, "_blank"); // a plain new tab if a window can't be made
  }
}

const textOf = (id) => (info[id] ? `${info[id].t} ${info[id].d}` : "");

function parseNum(text) {
  const m = /^\s*([\d.]+)\s*([KMB])?\s*$/i.exec(text || "");
  if (!m) return 0;
  return Math.round(Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1));
}

function compact(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** The reels after search, min views and sort. */
function shown() {
  if (!data) return [];
  const q = $("search").value.trim().toLowerCase();
  const min = parseNum($("minViews").value);
  const show = $("show").value;
  const list = data.reels.filter(
    (r) =>
      r.views >= min &&
      (show === "all" || (show === "added") === added.has(r.id)) &&
      (!q || r.id.includes(q) || textOf(r.id).toLowerCase().includes(q)),
  );
  const sort = $("sort").value;
  if (sort === "most") list.sort((a, b) => b.views - a.views);
  else if (sort === "least") list.sort((a, b) => a.views - b.views);
  else list.sort((a, b) => a.pos - b.pos);
  return list;
}

let guideFolded = false; // folded once by itself (after that it stays as you left it)

function draw() {
  const ul = $("list");
  const page = data?.page;
  $("pageName").textContent = page?.name || "Reel Feed collector";
  $("scrollBtn").disabled = !data;
  $("scrollBtn").textContent = data?.running ? "Stop scrolling" : "Keep scrolling";
  // With nothing to list the guide is open and the rest is hidden; once reels appear it folds away
  // (open it again any time with "How to use this").
  const empty = !data || !data.reels.length;
  document.body.classList.toggle("empty", empty);
  if (empty) $("guide").open = true;
  else if (!guideFolded) {
    $("guide").open = false;
    guideFolded = true;
  }
  if (!data) {
    ul.replaceChildren();
    $("counts").textContent = "";
    updateSend();
    return;
  }
  const n = data.reels.length;
  const nAdded = data.reels.filter((r) => added.has(r.id)).length;
  const linked = libraryAt > 0;
  $("status").textContent = data.running
    ? `Scrolling slowly… ${n} reels so far${linked ? ` · ${nAdded} already added` : ""}`
    : n
      ? `${n} reels found${n >= data.cap ? ` (the most it collects: ${data.cap})` : ""}${linked ? ` · ${nAdded} already added · ${n - nAdded} not added yet` : ""}. Scroll the page (or "Keep scrolling") to find more.`
      : "No reels found yet. Scroll the page a little (or click Keep scrolling).";
  // Where the "already added" marks come from, and what to do when they can't
  const since = linked ? ` (updated ${ago(libraryAt)})` : "";
  const note = {
    checking: "Checking Reel Feed…",
    ok: `✓ Reel Feed says you've added ${added.size} video${added.size === 1 ? "" : "s"}${since}.`,
    closed: linked
      ? `Reel Feed isn't open in a tab, so these marks may be out of date${since}.`
      : "Reel Feed isn't open in a tab, so I can't see what you've added yet. Open it:",
    silent: "Reel Feed is open but didn't answer (it may be an older version). Reload that tab:",
  };
  $("syncNote").textContent = note[link] ?? "Looking for Reel Feed…";
  const action = { ok: "↻ Refresh", closed: "Open Reel Feed", silent: "Reload Reel Feed tab" }[link];
  $("openApp").hidden = !action;
  if (action) $("openApp").textContent = action;
  $("openApp").disabled = connecting; // (a check is already running)
  // What the panel sees, in plain text, to read out when the marks don't match what you expect
  const sample = (ids) => [...ids].slice(0, 3).join(", ") || "none";
  $("diagText").textContent = [
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `Reel Feed tabs found: ${appTabIds.length}   (check: ${link})`,
    `Last list from Reel Feed: ${libraryAt ? ago(libraryAt) : "never"}   · videos it reports: ${added.size}`,
    `Reel Feed's ids (first 3): ${sample(added)}`,
    `Reels on this page: ${n}   · marked as added: ${nAdded}`,
    `This page's ids (first 3): ${sample(data.reels.map((r) => r.id))}`,
  ].join("\n");
  const list = shown();
  void fillInfo(list);
  const counts = () => `${list.length} shown · ${picked.size} selected`;
  $("counts").textContent = counts();
  const items = list.map((r) => {
    const isAdded = added.has(r.id);
    const li = document.createElement("li");
    li.className = isAdded ? "added" : picked.has(r.id) ? "on" : "";
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !isAdded && picked.has(r.id);
    box.disabled = isAdded; // already in Reel Feed
    box.onchange = () => {
      if (box.checked) picked.add(r.id);
      else picked.delete(r.id);
      li.className = box.checked ? "on" : "";
      $("counts").textContent = counts();
      updateSend();
    };
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    if (r.thumb) img.src = r.thumb;
    const box2 = document.createElement("div");
    box2.className = "info";
    const views = document.createElement("div");
    views.className = "views";
    views.textContent = r.views ? `${compact(r.views)} views` : r.viewsText || "views unknown";
    const known = info[r.id];
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = known?.t || (known || failed.has(r.id) ? `Reel ${r.id}` : "Getting its title…");
    box2.append(title);
    if (known?.d) {
      const desc = document.createElement("div");
      desc.className = "cap";
      desc.textContent = known.d;
      box2.append(desc);
    }
    box2.append(views);
    if (isAdded) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "✓ Added";
      views.append(" ", badge);
    }
    box.setAttribute("aria-label", `${isAdded ? "Already added: " : "Select "}${known?.t || `reel ${r.id}`}, ${views.textContent}`);
    label.append(box, img, box2);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "watch";
    play.textContent = watching === r.id ? "■" : "▶";
    play.title = watching === r.id ? "Close the player" : "Watch it here";
    play.setAttribute("aria-label", `${watching === r.id ? "Stop" : "Watch"} ${known?.t || `reel ${r.id}`}`);
    play.onclick = () => watch(watching === r.id ? null : r.id);
    li.append(label, play);
    return li;
  });
  ul.replaceChildren(...items);
  updateSend();
}

function updateSend() {
  const n = picked.size;
  const btn = $("sendBtn");
  btn.disabled = !n || n > MAX_SEND;
  btn.textContent = n ? `Add ${n} to Reel Feed` : "Add to Reel Feed";
  $("footNote").textContent =
    n > MAX_SEND
      ? `Reel Feed adds up to ${MAX_SEND} at a time — unselect ${n - MAX_SEND}.`
      : n
        ? "Reel Feed opens; pick categories and lists there, then Add."
        : "";
}

async function ask(msg) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null; // not a Facebook tab, or opened before the extension was installed
  }
}

/** Where the current tab is: a page's Reels tab, some other Facebook page, or not Facebook. */
function placeOf(url) {
  let u;
  try {
    u = new URL(url || "");
  } catch {
    return "other";
  }
  if (!/^(www|web)\.facebook\.com$/.test(u.hostname) || u.protocol !== "https:") return "other";
  return /\/reels\/?$/.test(u.pathname) || u.searchParams.get("sk") === "reels_tab" ? "reels" : "facebook";
}

const WHERE = {
  other: "This tab isn't Facebook. Open a Facebook page, then click its Reels tab.",
  facebook: "You're on Facebook, but not on a page's Reels tab. Open the page and click its “Reels” tab.",
  reels: "Couldn't read this tab. Reload it once, then open this panel again.",
};

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const changed = tab?.id !== tabId;
  tabId = tab?.id ?? null;
  const place = placeOf(tab?.url);
  let snap = null;
  if (place === "reels") {
    // The collector is put into the tab only now, and only on a Reels tab — never on other pages.
    snap = await ask({ t: "get" });
    if (!snap) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        snap = await ask({ t: "get" });
      } catch {}
    }
  }
  if (snap && data && snap.key !== data.key) picked.clear();
  if (changed && !snap) picked.clear();
  data = snap;
  draw();
  if (!snap) $("status").textContent = WHERE[place];
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.t !== "reels" || sender.tab?.id !== tabId) return;
  if (data && msg.key !== data.key) picked.clear();
  data = msg;
  draw();
});
chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && (info.status === "complete" || info.url)) void refresh();
});

$("scrollBtn").onclick = () => void ask({ t: data?.running ? "stop" : "scroll" }).then(() => refresh());
for (const id of ["search", "minViews", "sort", "show"]) $(id).addEventListener("input", draw);
// The most viewed reels that aren't added yet (among those the filters show), as many as Reel Feed adds at once.
// Add them, and the next press picks the next 60: the ones just added are marked and skipped.
$("topBtn").textContent = `Select top ${MAX_SEND} new`;
$("topBtn").onclick = () => {
  const best = shown()
    .filter((r) => !added.has(r.id))
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, MAX_SEND);
  picked.clear();
  for (const r of best) picked.add(r.id);
  draw();
};
$("allBtn").onclick = () => {
  for (const r of shown()) if (!added.has(r.id)) picked.add(r.id); // not the ones you already have
  draw();
};
$("openApp").onclick = async () => {
  if (link === "closed") {
    await chrome.tabs.create({ url: `${APP}added` }); // the bridge is put in when it loads and the marks arrive by themselves
    setTimeout(connect, 4000);
  } else if (link === "silent") {
    for (const id of appTabIds) await chrome.tabs.reload(id);
    setTimeout(connect, 4000);
  } else void connect();
};
$("noneBtn").onclick = () => {
  picked.clear();
  draw();
};

/** Look up the title and caption of the shown reels that have none yet, 2 at a time, through Reel
 *  Feed's own lookup. Runs by itself as reels appear; saved on this computer. */
const failed = new Set();
let redraw = 0;
async function fillInfo(list) {
  if (fetching) return;
  const queue = list.filter((r) => !info[r.id] && !failed.has(r.id));
  if (!queue.length) return;
  fetching = true;
  const one = async (r) => {
    try {
      const res = await fetch(`${APP}api/fb/meta?url=${encodeURIComponent(`https://www.facebook.com/reel/${r.id}/`)}`);
      const j = await res.json();
      if (!j || j.error) throw new Error();
      const t = (j.title || "").trim();
      const cap = (j.caption || "").trim();
      info[r.id] = { t, d: (t && cap.startsWith(t) ? cap.slice(t.length) : cap).trim() };
    } catch {
      failed.add(r.id); // not again this time
    }
    redraw ||= window.setTimeout(() => {
      redraw = 0;
      if (!fetching) return;
      draw();
    }, 600);
  };
  await Promise.all(
    [0, 1].map(async () => {
      for (let r = queue.shift(); r; r = queue.shift()) await one(r);
    }),
  );
  const ids = Object.keys(info);
  if (ids.length > 3000) for (const id of ids.slice(0, ids.length - 3000)) delete info[id];
  await chrome.storage.local.set({ info });
  fetching = false;
  draw(); // and any reels that came meanwhile
}

$("sendBtn").onclick = () => {
  const ids = (data?.reels || []).filter((r) => picked.has(r.id)).map((r) => r.id);
  if (!ids.length) return;
  chrome.tabs.create({ url: `${APP}added#add=${ids.join(",")}` });
  picked.clear();
  draw();
};

void refresh();
