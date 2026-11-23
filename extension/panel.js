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

chrome.storage.local.get("info").then((s) => {
  info = s.info || {};
  draw();
});

/** Watch a reel at the top of the panel (Facebook's embedded player); null closes it. */
let watching = null;
function watch(id) {
  watching = id;
  const box = $("player");
  box.hidden = !id;
  box.replaceChildren();
  if (id) {
    const f = document.createElement("iframe");
    f.src = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(`https://www.facebook.com/reel/${id}/`)}&show_text=false&autoplay=true&width=270`;
    f.title = "Facebook reel";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.allowFullscreen = true;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕ Close";
    close.onclick = () => watch(null);
    box.append(f, close);
    box.scrollIntoView({ block: "nearest" });
  }
  draw();
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
  const list = data.reels.filter((r) => r.views >= min && (!q || r.id.includes(q) || textOf(r.id).toLowerCase().includes(q)));
  const sort = $("sort").value;
  if (sort === "most") list.sort((a, b) => b.views - a.views);
  else if (sort === "least") list.sort((a, b) => a.views - b.views);
  else list.sort((a, b) => a.pos - b.pos);
  return list;
}

function draw() {
  const ul = $("list");
  const page = data?.page;
  $("pageName").textContent = page?.name || "Reel Feed collector";
  $("scrollBtn").disabled = !data;
  $("scrollBtn").textContent = data?.running ? "Stop scrolling" : "Keep scrolling";
  if (!data) {
    ul.replaceChildren();
    $("counts").textContent = "";
    updateSend();
    return;
  }
  const n = data.reels.length;
  $("status").textContent = data.running
    ? `Scrolling slowly… ${n} reels so far`
    : n
      ? `${n} reels found${n >= data.cap ? ` (the most it collects: ${data.cap})` : ""}. Scroll the page (or "Keep scrolling") to find more.`
      : page?.reelsTab
        ? "No reels yet — scroll the page a little."
        : "Open this page's Reels tab to collect its reels.";
  const list = shown();
  void fillInfo(list);
  $("counts").textContent = `${list.length} shown · ${picked.size} selected`;
  const items = list.map((r) => {
    const li = document.createElement("li");
    li.className = picked.has(r.id) ? "on" : "";
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = picked.has(r.id);
    box.onchange = () => {
      if (box.checked) picked.add(r.id);
      else picked.delete(r.id);
      li.className = box.checked ? "on" : "";
      $("counts").textContent = `${list.length} shown · ${picked.size} selected`;
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
    box.setAttribute("aria-label", `Select ${known?.t || `reel ${r.id}`}, ${views.textContent}`);
    label.append(box, img, box2);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "watch";
    play.textContent = watching === r.id ? "■" : "▶";
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

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const changed = tab?.id !== tabId;
  tabId = tab?.id ?? null;
  const isFb = /^https:\/\/(www|web)\.facebook\.com\//.test(tab?.url || "");
  const snap = isFb ? await ask({ t: "get" }) : null;
  if (snap && data && snap.key !== data.key) picked.clear();
  if (changed && !snap) picked.clear();
  data = snap;
  draw();
  if (!snap) $("status").textContent = isFb ? "Reload this Facebook tab once so the extension can read it." : "Open a Facebook page's Reels tab.";
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
for (const id of ["search", "minViews", "sort"]) $(id).addEventListener("input", draw);
$("allBtn").onclick = () => {
  for (const r of shown()) picked.add(r.id);
  draw();
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
