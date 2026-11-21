# Ecomgy Reel Feed

A personal, YouTube-Shorts-style feed that shows **only Shorts from a hand-picked list of channels** (business, marketing, e-commerce, founders, Bangla business creators…). Built for Ecomgy research: see what's working in short-form business content, save good examples, and let the feed learn what you like.

> This file is the single source of truth for how the app works, where everything lives, and why it was built this way. Keep it updated when something changes.

---

## 1. At a glance

| Thing | Where |
|---|---|
| Live site | `https://robiulhr.github.io/reel-feed/` |
| Code repo (public) | `https://github.com/robiulhr/reel-feed` |
| Personal data repo (**private**) | `https://github.com/robiulhr/reel-feed-data` → `user-state.json` |
| Sync server | Cloudflare Worker `reel-feed-sync` → `https://reel-feed-sync.robiulhr2201.workers.dev` (code in `worker/`) |
| Shorts refresh | GitHub Actions, every 4 hours (`.github/workflows/deploy.yml`) |
| Local folder | `Ecomgy/3 or 5 or 7 facts about big companies and entroponeours/reel-feed` |
| Cost | $0 (GitHub free, Cloudflare Workers free, YouTube API free quota) |

```
            every 4h, on channel edits, or "Refresh now"
GitHub Actions ───────────► YouTube (RSS + Data API) ──► shorts.json ──► build ──► GitHub Pages (public site)
  (uses secret YOUTUBE_API_KEY)

Phone / laptop ── password login ──► Cloudflare Worker ──┬──► private repo: user-state.json (saves, history, learning)
                  (180-day session,   (holds GitHub token, ├──► code repo: channels.json (Channels panel edits → triggers refresh)
                   not the password)   password, YouTube   ├──► YouTube Data API (channel lookups when adding)
                                       key as secrets)     └──► GitHub Actions (Refresh now / status)
```

---

## 2. What the app does

- **Vertical full-screen feed**: swipe (phone), scroll wheel / ↑↓ / j k (desktop). Tap = pause, double-tap = save.
- **Tabs**
  - **For You** (default): blended recommendation (see §5).
  - **Trending**: fastest-growing (views per day since upload).
  - **Popular**: biggest hits relative to each channel's normal views.
  - **Newest**: pure upload order.
- **Filters**: time range (`All time` default, 30 days, 7 days, Today) + categories (All, Bangla, Ads & E-com, Biz Stories, Founders, Books & Money, AI & Brand).
- **Actions** (bottom bar): sound, save ♡, **share ⤴** (phone share sheet with the YouTube Shorts link; on desktop it copies the link), **⋯** → More like this (§6d), Explore this channel (§6c), Hide this channel, Open on YouTube. Tapping the **channel name** also opens the channel explorer.
- **Menu ☰**: **Channels** (control panel, §6a), Saved list, Hidden channels (unhide), Sync (log in / status), **API usage** (§6b), About (stats, reset learning, clear history).
- **NEW badge**: Shorts uploaded since your last visit (a gap of 30+ minutes counts as a new visit).
- Never shows the same Short twice (until you've seen everything in a filter); never the same channel twice in a row; max 3 per channel in any 20.
- Videos play through YouTube's **official embedded player** (views count for creators; nothing is downloaded or re-hosted).

---

### Speed & weak networks
- **Instant swipe** (`src/pool.ts`): 3 YouTube players — the current one, the **next one already loaded and paused on its first frame**, and the previous one for swiping back. Swiping switches players instead of loading. The video **follows your finger** and snaps (≥15% of the screen or a quick flick); rubber-band at the ends. **Swipe left** = channel page.
- **Fast start** (`src/data.ts`): the library is saved on the device (IndexedDB) → later visits start instantly and only download `meta.json` (~40 bytes) to check for news. First visit loads `starter.json` (~400 best Shorts, ~46 KB gzipped) → first video in about a second, while `shorts.json` (2.3 MB) downloads in the background. Requests time out and retry instead of hanging.
- **Works offline / installable**: `public/sw.js` keeps the app files on the device; `manifest.webmanifest` makes it installable (browser menu → *Add to Home screen* / *Install app*). Offline you still get History, Saved, lists; videos need a connection.
- **Data saver** (About → Data saver: Auto / On / Off): on slow connections (2G/3G, *Save data*, < 1.2 Mbps) uses small thumbnails (~15 KB instead of ~150 KB) and preloads less (1 extra player, none on 2G).
- **Status messages**: spinner while buffering; after 7 s "Slow connection — still loading… [Skip]"; an offline banner; "Slow connection — data saver on" once per session.

### Refresh
- **↻ button** (top bar, or key `r`): loads new data if published, otherwise reshuffles the feed and offers **Get newer** (starts the GitHub fetch; the app checks every 45 s and shows a banner when ready).
- **Automatic check** when you open the app, when you come back to it, and every 10 minutes → banner **"✨ N new Shorts — tap to load"** (never interrupts the video you're watching).

### History & continue
- **Menu → History** (`src/history.ts`): every Short you watched, newest first, grouped Today / Yesterday / date, with *✓ Watched*, *N% watched* or *Skipped*; search; tap to replay (swipe through history); ✕ to remove; **Clear all**; **Pause history** (per device). Synced across devices (up to 600 entries).
- **Continue watching**: if you left a Short unfinished in the last 24 h, the app offers **Resume**.
- Saved and History also work for Shorts found outside your library (title/channel are remembered).

### App updates (installed app included)
- The page is always fetched fresh (bypassing the browser cache). On a slow connection the saved copy opens after 3 s **and** the new version keeps downloading in the background.
- The app checks for a new version when opened, when you come back to it, and every 30 min. A new version reloads automatically if you just opened the app, otherwise shows **"🆕 New version of the app — tap to update"**.
- **Menu → About → App version** shows the build time; **Check for app update** forces a check.
- If an old copy ever sticks: close the app fully (swipe it away), open it again with internet. Last resort: Chrome → Settings → Site settings → robiulhr.github.io → *Clear & reset* (you'll need to log in again; your data is safe in GitHub).

### Playback controls
- **Double-tap left / right third** of the video = **10 s back / forward** (keep tapping to skip more); double-tap the middle = save; single tap = pause.
- **Press and hold** = **2×** while held (mouse too).
- **Progress bar**: drag it (large touch area) to jump; shows `0:57 / 1:54` while dragging.
- **Speed**: ⋯ → 0.5× – 2× (remembered per device; shown in the info line when not 1×). Keys `<` / `>`.
- Keys: `←/→` (or `h/l`) 10 s, `↑/↓` (or `j/k`) previous/next, `c` channel, `f` full screen.
- Skipped seconds don't count as "watched" for learning or history.

### Robustness (engineering Phase 1) — `src/ui.ts`, `src/sync.ts`, Worker `withRequestId`
- **Buttons lock while working** (`busy()`): Add, Remove, Restore, Delete, Refresh now, Search, Log in, Sync now, Check for app update… show "…"/"Adding…" and ignore extra taps.
- **Channel changes are queued**: they show instantly; changes within 0.4 s are **combined into one save** (= one GitHub commit, one refresh); saves go one at a time; a change that no longer makes sense (e.g. deleting something already deleted) is dropped instead of failing the save. On failure everything is put back on screen, with **Try again**.
- **Duplicate protection on the server**: every change carries an `X-Request-Id`; the Worker remembers each ID for 10 min (KV `rid:*`) and returns the saved answer for a repeat (`X-Repeat: 1`). Two identical requests at the same moment → applied once (the second waits for the first). Tested.
- **Time limits + retries** on every sync-server call (15–25 s; reads retried up to 2×, changes 1× — safe thanks to the request ID). Plain messages: "too slow", "offline", "couldn't reach GitHub or YouTube — nothing was changed".
- **Newest request wins**: an older lookup/search answer that arrives late is ignored; repeating the same lookup while it runs is ignored.
- **Message queue**: messages no longer overwrite each other; errors are red, stay longer, have ✕ and often **Try again**.
- **App dialogs** replace the browser's `confirm`/`prompt` (Delete channel, Clear history, Log out, copy-link fallback).
- Taps during the slide animation are ignored; "Get newer" can't start two fetches.

### Sound
- **Tap 🔊** = mute/unmute; unmuting shows a **volume slider** for 3 s. **Press and hold 🔊** = volume slider any time.
- Volume (with Mute) is also at the top of the **⋯** menu, next to Speed. Icon shows the level 🔇 🔈 🔉 🔊; volume is remembered per device. Keys: `+` / `−` volume, `m` mute.
- Note: on iPhone, web pages can't set the volume — use the phone's volume buttons there.

### Layout on small phones
- Top bar keeps only **↻** and **☰** (always visible); ⛶ Full screen moved into **⋯**.
- Tabs, categories and the menu's tabs **scroll sideways** instead of squeezing together, with **›** / **‹** buttons at the edges to reveal the rest. Checked at 320 / 360 / 412 px wide, including large text.
- The ⋯ menu and tips card scroll if the screen is short.

### Full screen
- **In the browser**: on phones the app goes **full screen on your first tap** (hides the address bar; Android Chrome and most Android browsers). ⋯ → ⛶ Full screen toggles it; if you leave full screen yourself it won't push it again that session. About → turn the automatic part off. iPhone Safari doesn't allow web pages to go full screen → install it instead.
- **Installed app** (browser menu → *Install app* / *Add to Home screen*): opens full screen with no browser bar (`display: fullscreen` in the manifest).

### First-time tips
Shown once (Swipe up/down, swipe left, double-tap, ⋯, ↻). About → *Show the tips again*.

## 3. Where data lives

| Data | Stored in | Sent to YouTube? |
|---|---|---|
| Shorts list + stats | `public/data/shorts.json` (generated, not committed) | – (read from YouTube) |
| Fetch cache (known IDs, stats) | `data/cache.json` (generated; cached between Action runs) | – |
| Channel list (incl. removed channels) | `channels.json` in the code repo — edited from the Channels panel via the Worker | – |
| Saves, hidden channels, watched history, learning | Browser + **private repo `user-state.json`** via the Worker | ❌ never |
| Sound on/off, current tab, filters | That device's browser only (intentionally per device) | ❌ |
| YouTube API key | `.env` locally; GitHub Actions secret `YOUTUBE_API_KEY` | – |
| GitHub token (for the data repo) | Cloudflare Worker secret `GITHUB_TOKEN` only | – |
| App password | Cloudflare Worker secret `APP_PASSWORD` only | – |

Note: because playback uses YouTube's player, YouTube counts the view, and if you're logged into YouTube in that browser it may appear in your YouTube watch history. Saves/hides/skips are **not** YouTube likes/subscriptions.

---

## 4. Secrets & accounts (never commit these)

| Secret | Lives in | Set / change with |
|---|---|---|
| `YOUTUBE_API_KEY` | `reel-feed/.env` (local) and GitHub repo secret | Google Cloud Console → Credentials. GitHub: repo Settings → Secrets and variables → Actions |
| `GITHUB_TOKEN` | Cloudflare Worker secret | `npx wrangler secret put GITHUB_TOKEN` |
| `APP_PASSWORD` | Cloudflare Worker secret | `npx wrangler secret put APP_PASSWORD` or Cloudflare dashboard |
| `SESSION_SECRET` | Cloudflare Worker secret | see §8 |
| `YOUTUBE_API_KEY` (Worker copy) | Cloudflare Worker secret — used for channel lookups in the Channels panel | `npx wrangler secret put YOUTUBE_API_KEY` |

**GitHub token settings** (fine-grained, `github.com/settings/personal-access-tokens`):
name `reel-feed-sync` · resource owner `robiulhr` · **Only select repositories → `reel-feed-data` and `reel-feed`** · Repository permissions: **Contents: Read and write**, **Actions: Read and write** (Metadata read-only is added automatically) · everything else *No access* · expiry 1 year.
Why: Contents on `reel-feed-data` = your synced data; Contents on `reel-feed` = editing `channels.json`; Actions on `reel-feed` = "Refresh now" and refresh status. The Worker code only ever touches `user-state.json` and `channels.json`.
When it expires, sync stops with "GitHub token is invalid or expired" → create a new one with the same settings and run `npx wrangler secret put GITHUB_TOKEN`.

**YouTube API key**: Google Cloud project "Ecomgy Reel Feed", YouTube Data API v3 enabled, key restricted to *YouTube Data API v3*, application restriction *None*. Free quota 10,000 units/day (resets midnight Pacific).

**Account safety** (these are the real master keys): turn on 2-factor authentication for **GitHub**, **Cloudflare** and **Google**, and keep their recovery codes safe.

**Rules**: never paste a token/password into chat, code, or an issue. If one is exposed, revoke it immediately and make a new one.

---

## 5. How recommendations work

Computed in two places:

**a) In the fetch script (`scripts/fetch.ts`)**, per Short, turned into percentiles (0–1) across the whole library:
- **Outlier (`o`)**: views vs the channel's *median* Short views → finds hits on small channels too.
- **Engagement (`e`)**: (likes + 3×comments) relative to views.
- **Trending (`tr`)**: views per day since upload.
- **Relevance (`r`)**: keyword match on title/description (English + Bangla business words) blended with the channel's category.

Per channel it keeps the best 150 older Shorts + **every** Short from the last 60 days.

**b) In the browser (`src/rank.ts`)**
- For You = `0.28·outlier + 0.14·engagement + 0.14·trending + 0.12·freshness + 0.12·relevance + 0.20·your-taste + NEW bonus 0.15 + randomness ≤0.18`
- Trending = mostly trending speed; Popular = mostly outlier + total views; Newest = upload time.
- Then diversity rules (no same channel twice in a row, ≤3 per channel per 20).

**Learning ("your taste")**, kept per channel and per category (`src/main.ts` → `finishCurrent`, `src/store.ts`):

| You… | Channel score | Category score |
|---|---|---|
| watch to the end (≥90%) | +1 | +0.5 |
| each replay | +0.5 more (max +2.5) | half |
| watch ≥50% | +0.5 | +0.25 |
| skip within 3s | −1 | −0.5 |
| save | +2 | +1 |
| hide channel | channel removed | – |

Scores are capped at ±20. Only **For You** uses them. Reset any time: Menu → About → *Reset what the feed learned*.

---

## 6. How sync works (`src/sync.ts`, `worker/src/index.ts`)

- Each device logs in **once** (Menu → Sync) with `APP_PASSWORD`. The Worker returns a signed **session valid 180 days**; the device stores only that, never the password or GitHub token.
- Every change is recorded as a small **operation** ("saved X", "skipped channel Y", "hid Z"). Every ~60 seconds, when you leave the page, and every 5 minutes, the app: reads the latest `user-state.json` → replays its own pending operations on top → writes it back. If another device saved in between (GitHub sha conflict), it re-reads and merges again. → Two devices can be used at the same time without overwriting each other.
- Offline: operations wait in the browser and sync later.
- The first login on a device merges that device's existing local data into the shared file.
- **Every sync is a commit** in `reel-feed-data` → full version history = backup. To restore an older state: open the repo on GitHub → `user-state.json` → History → copy an old version back.
- Worker protections: only `https://robiulhr.github.io` (and local dev addresses) may call it; wrong passwords are slowed down; changing `APP_PASSWORD` or `SESSION_SECRET` logs out every device.
- The Worker refuses to sync without a session; the site itself works without sync (data then stays in that browser only).

---

## 6a. Channels panel (Menu ☰ → Channels) — `src/channels.ts`

- **List** of every channel: avatar, name, @handle, status, subscribers, Shorts in your feed, latest upload, your taste score.
  Status: *Active* · *No Shorts yet* · *Not found* · *Waiting for refresh* (just added/restored) · *Removed*; plus *Hidden* if you hid it.
- **Search** (name/handle), **filter** by category and status, **sort** by name, subscribers, Shorts in feed, latest upload, your taste.
- **Add**: paste `@handle`, any YouTube link (channel, `/channel/UC…`, a Short or video link, `youtu.be/…`) or type a name.
  - Handles/links → instant lookup (**2–3 API units**). A name → **Search YouTube** button (**~100 units**, only when you press it).
  - Preview card: avatar, name, handle, subscribers, total videos, **number of Shorts**, latest Short, description; category **suggested automatically** (Bengali text → Bangla, ads/e-com words → Ads & E-com, etc.); warnings for *already in list*, *in Removed (adding restores it)*, *no Shorts yet*.
  - Lookups are remembered for the session, so repeating one costs nothing.
- **Change category** inline (feed filters update immediately).
- **Hide / Unhide**: personal (synced like your saves); the channel stays in the list.
- **Remove = soft delete**: the channel moves to **Removed**, leaves the feed immediately, and stops being fetched (saves quota). **Restore any time** — there's no time limit. A toast also offers **Undo**.
- **Delete** (permanent) exists **only for channels already in Removed** — the "second deletion". It asks for confirmation; afterwards the next refresh also purges its cached data. GitHub history still has every version of `channels.json` if you ever need it back.
- **Refresh now**: starts the GitHub Action immediately (normally every 4 hours). Every channel edit also starts a refresh automatically (it's a commit). Status line shows the latest run and the API units the last refresh used.
- Editing needs you to be logged in (Sync). Logged out = view only.
- ⚠️ Because the app commits to `channels.json`, run **`git pull`** before editing `channels.json` (or anything) on the PC.

## 6b. Saving YouTube API quota (10,000 units/day)

| What | How it's kept cheap | Typical cost |
|---|---|---|
| Detect new uploads | Each channel's public **RSS feed** (free). The Shorts playlist (1 unit) is only read when RSS shows a new upload, RSS fails, or once a week as a safety net | ~0–40 units/refresh |
| Views/likes | Refreshed **by age**: < 7 days every run, < 60 days ~daily, older weekly (1 unit per 50 Shorts) | ~10–80 units/refresh |
| Removed channels | Not fetched at all | 0 |
| Channel lookups (Add) | Handle/link 2–3 units; name search ~106 only on request; repeats cached | per use |
| Channel preview (channel not in your list) | Newest ≤200 Shorts + stats; **cached 24 h for all devices** (Cloudflare KV) | ~6–10, then 0 |
| More like this → On YouTube | One search (25 results) + stats + channel info; **same words within 7 days = free** (any word order, any device) | ~103, then 0 |
| More like this → In your feed | Computed in the browser from titles | 0 |

Measured: a normal refresh dropped from **~590 to ~17 units**. About once a week the "older Shorts" stats refresh costs a few hundred. Six refreshes a day stay well under 1,000 units/day.

**API usage page (Menu ☰ → API usage)** — `src/usage.ts`:
- **Today**: units used of 10,000, units left, and when the quota resets in your local time (midnight Pacific).
- **Where today's units went**: new-Shorts checks, views/likes updates, channel info, and Channels → Add lookups.
- **Last 7 days** table, **average per refresh** and projected daily use.
- **Recent refreshes** (with RSS/playlist/stats details; failed runs marked ✗) and **recent channel lookups**.
- **What costs what** reference table.
- Data sources: every refresh appends a record to the usage history (kept in the Actions cache, published in `shorts.json`; also saved when a run fails). Lookups are logged by the app into `user-state.json` (synced across devices).
- It's the app's own count. Google's official number: Google Cloud → YouTube Data API → Quotas. Runs made on the PC (`npm run fetch`) use the same quota but only show in the local copy.
- **Your discovery budget** section (needs login): today's used/budget meter, searches/previews left, the split of the 10,000 (reserve / budget / margin), whether refreshes are protected, units saved by caching this week, a box to change the budget, and spending tips.

### Quota guard — `src/quota.ts` + Worker
- **Split of the daily 10,000**: 🛡️ **1,500 reserved for automatic refreshes** (they really use ~100–600) · 🔍 **discovery budget, default 3,000** (searches, channel previews, lookups) — changeable 100–8,500 on the API usage page, applies to all devices · the rest is safety margin.
- **Cost card before every paid action**: what it costs, today's used vs budget (meter), what's left after it and "room for ~N more searches", **free alternatives first** (similar Shorts from your feed, a similar search from the last 7 days), and a warning for vague one-word searches.
- **Levels** (by budget used after the action): 🟢 < 50% normal · 🟡 50–80% "is this worth it?" · 🔴 80–100% **press and hold 1 s** to confirm · ⛔ over budget = no spend button (free options still work).
  Small costs (channel preview ~10) only show the card from yellow onwards; the cost is always written on the button.
- **Hard lock on the server**: the Worker keeps the day's counter in Cloudflare KV (`used:YYYY-MM-DD`, Pacific day) and **refuses** any paid request that would exceed the budget — even from an old device, a bug, or a leaked password.
- **Caching**: previews 24 h (`ch:<id>`), searches 7 days (`q:<sorted words>`), shared by all devices; cache hits cost 0 and are counted as "saved".
- **After every paid action** a toast confirms: "Used 103 units · 2,789 of your budget left today".
- KV namespace: `QUOTA` (id in `worker/wrangler.toml`), free tier.

---

## 6c. Channel explorer — `src/explore.ts`

- Open it by tapping the **channel name/avatar** under a Short, **⋯ → Explore this channel**, a channel in **More like this**, or **Preview Shorts** in Channels → Add.
- **Header**: avatar, name, handle, subscribers, Shorts count, latest upload, status (*In your list* / *Removed* / *Not in your list*, plus *Hidden*).
- **Actions**: in your list → category, Hide/Unhide, Remove · removed → Restore · not in your list → category (suggested) + **Add to my list**.
- **Grid** with **Newest · Popular · Hidden gems** (views ÷ the channel's median, shown as ×N) and **▶ Play all**.
- Tap a Short → **swipe through only this channel**; the top bar shows "← Channel · 3 of 152"; **←** (or Esc) returns to the channel page, and closing it returns to your main feed where you left it.
- Channels in your list are **free** (best 150 + all recent Shorts already loaded). Others load on request (~10 units, cached 24 h).
- Watching here **teaches For You** like the main feed.

## 6d. More like this — `src/similar.ts` (⋯ → More like this)

- **In your feed · free**: TF-IDF topic similarity over every title in your library (Bangla + English, stop-words removed), blended with quality (75% topic, 15% outlier, 10% engagement), max 3 per channel, up to 40 results. Built in the browser in < 0.5 s.
- **On YouTube · ~103 units**: search words are suggested from the Short's most distinctive title words — **edit them**. Results are Shorts only (≤ 3 min), mostly from new channels; **Channels found** lists them with how many results each had ("Good candidate" if ≥ 2) → tap to explore → Add. ▶ Play all to swipe the results.
- Everything goes through the cost card and the Worker's budget lock.

---

## 7. Everyday use

**Watch**: open the live site on any device. First time on a device: Menu → Sync → enter password.

**Add / remove channels**: use **Menu → Channels** (§6a). Editing the file by hand still works (`git pull` first, then edit, commit, push):

```json
{ "name": "Channel name", "handle": "@handle", "cat": "bangla", "id": "UC…(optional)", "status": "removed (optional)" }
```
`cat`: `bangla`, `ads`, `stories`, `founders`, `books`, `ai`. Channels with no Shorts yet are fine to keep — they appear automatically once they post Shorts.

**Run locally** (from the `reel-feed` folder; works with Node 20+):
```powershell
git pull             # the app may have changed channels.json
npm run fetch        # new Shorts + fresh stats (usually ~20–100 API units)
npm run fetch:deep   # dig further back into channel history (more quota)
npm run dev          # http://localhost:5173 ; phone on same Wi-Fi: use the "Network" address printed
```
Local dev has no sync unless `VITE_SYNC_URL` is set (e.g. in `.env.local`, git-ignored).

---

## 8. Setup / maintenance commands (Cloudflare Worker)

Wrangler needs **Node 22+**. The PC's default Node is 20; Node 24 is installed via nvm. In each new terminal window, first switch to Node 24:

- **cmd**: `set "PATH=%USERPROFILE%\.nvm\versions\node\v24.14.0\bin;%PATH%"`
- **PowerShell**: `$env:Path = "$HOME\.nvm\versions\node\v24.14.0\bin;" + $env:Path`

Then, inside `reel-feed/worker`:
```
npx wrangler login                       # one time; browser asks to Allow (normal, broad default scopes)
npx wrangler secret put GITHUB_TOKEN     # paste the fine-grained token
npx wrangler secret put APP_PASSWORD     # type the app password
npx wrangler secret put YOUTUBE_API_KEY  # paste the YouTube key (for channel lookups)
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SESSION_SECRET
npx wrangler deploy                      # prints the Worker address (https://reel-feed-sync.<name>.workers.dev)
```
`npx wrangler logout` removes the Cloudflare login from this PC.

**Forgot the app password?** Nothing is lost (data is in GitHub). Reset it: Cloudflare dashboard → Workers & Pages → `reel-feed-sync` → Settings → Variables and Secrets → edit `APP_PASSWORD`, or `npx wrangler secret put APP_PASSWORD`. All devices log out; log in again. Devices already logged in keep working until you reset.

---

## 9. Setup checklist

- [x] YouTube API key created, saved in `.env`, tested
- [x] Code pushed to `robiulhr/reel-feed`; private repo `robiulhr/reel-feed-data` created
- [x] Cloudflare account created
- [ ] Revoke the token that was pasted in chat; create a new fine-grained token (settings in §4)
- [x] `wrangler login` + set `GITHUB_TOKEN`, `APP_PASSWORD`, `SESSION_SECRET`
- [x] `npx wrangler deploy` → `https://reel-feed-sync.robiulhr2201.workers.dev`
- [x] GitHub repo `reel-feed` → Settings → Pages → Source: **GitHub Actions**
- [x] Repo secret `YOUTUBE_API_KEY` (Settings → Secrets and variables → Actions → Secrets)
- [x] Repo variable `SYNC_URL` = Worker address (same page → Variables)
- [x] Actions → *Fetch Shorts & deploy* → Run workflow → open the live site
- [x] Log in on the phone via Menu → Sync (do the same on each other device)
- [ ] Channels panel: edit the GitHub token → add repo `reel-feed`, permissions **Contents: Read and write** + **Actions: Read and write** (§4)
- [ ] Channels panel: `npx wrangler secret put YOUTUBE_API_KEY` (§8)

---

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `'Set-Location' is not recognized` | You're in **cmd**, not PowerShell — use the cmd commands in §8. |
| `Wrangler requires at least Node.js v22.12.0` | Switch the terminal to Node 24 (§8). |
| Fetch says *quota used up* | Wait until midnight Pacific; normal refreshes use only ~20–100 units, so look for repeated name searches or `fetch:deep` runs. |
| Channels: "GitHub token lacks permission for robiulhr/reel-feed/channels.json" | Token needs repo `reel-feed` with **Contents: Read and write** (§4). |
| Channels: "…starting the refresh workflow (needs Actions: Read and write)" | Add **Actions: Read and write** for `reel-feed` to the token. |
| Channels: "YOUTUBE_API_KEY is not set on the sync server" | `npx wrangler secret put YOUTUBE_API_KEY` in `worker/` (§8). |
| "Today's discovery budget is used up" | Working as intended. Use free options, wait for the reset (2 PM Bangladesh time in winter), or raise the budget on the API usage page. |
| Cost card says "Couldn't read today's usage" | Not logged in, or the Worker is unreachable — numbers shown are estimates; the Worker still enforces the budget. |
| Channels: added channel stays "Waiting for refresh" | The refresh takes ~3 min; check Actions tab. If the handle was wrong it becomes "Not found" — remove it and add again. |
| `git push` rejected (non-fast-forward) on the PC | The app committed `channels.json` — run `git pull`, then push. |
| Action failed | Usually missing `YOUTUBE_API_KEY` secret or Pages not set to *GitHub Actions*. Check the run log in the Actions tab. |
| Sync: "GitHub token is invalid or expired" | Make a new token (§4) → `npx wrangler secret put GITHUB_TOKEN`. |
| Sync: "You were logged out" | Password or session secret changed, or 180 days passed — log in again. |
| Sync: "Sync isn't set up for this copy" | The site was built without `SYNC_URL` (repo variable) — set it and re-run the Action. |
| A Short is skipped with "creator blocked embedding" | Normal: that creator disabled embedding; it's remembered and skipped. |
| Feed shows YouTube's own like/share overlay | Comes from YouTube's player; our controls are in the bars above/below. |

---

## 11. Project structure

| Path | What |
|---|---|
| `channels.json` | Channel list with categories |
| `scripts/fetch.ts` | YouTube fetch + scoring → `public/data/shorts.json` |
| `src/main.ts` | Feed UI, gestures, player events, panels |
| `src/rank.ts` | Recommendation logic |
| `src/store.ts` | Local state, change operations, file format |
| `src/sync.ts` | Sync with the Worker |
| `src/channels.ts` | Channels control panel |
| `src/usage.ts` | API usage page (incl. discovery budget) |
| `src/quota.ts` | Quota guard: cost card, budget, cache reuse hints |
| `src/explore.ts` | Channel explorer page + Short grid |
| `src/similar.ts` | More like this (library similarity + YouTube search) |
| `src/app.ts` | Interface the feature modules use to talk to the main app |
| `src/pool.ts` | Pool of YouTube players for instant swipes (replaces `player.ts`) |
| `src/data.ts` | Starter/full/saved library loading, update checks, slow-network detection |
| `src/history.ts` | Watch history panel |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icon.svg` | Offline app files, install support, icon |
| `public/data/meta.json`, `starter.json` | Generated by the fetch: version check + fast-start subset |
| `src/player.ts` | YouTube IFrame Player wrapper |
| `src/style.css`, `index.html` | Layout: top bar / video / bottom bar |
| `worker/` | Cloudflare Worker (login, sessions, `user-state.json`, `channels.json` edits, channel lookups, refresh trigger) |
| `.github/workflows/deploy.yml` | Scheduled fetch + build + deploy to Pages |
| `.env`, `.env.local`, `worker/.dev.vars`, `data/`, `public/data/` | Local-only / generated (git-ignored) |

Tech: Vite + TypeScript (no UI framework), YouTube Data API v3, YouTube IFrame Player API, Cloudflare Workers, GitHub Actions + Pages. Scripts run with `tsx` so they work on Node 20.

---

## 12. Decisions & why (context)

- **Frontend + scheduled script, no always-on server for content**: the feed is read-only data that changes a few times a day — a static site + scheduled fetch is free and can't really break.
- **Shorts detected via each channel's hidden Shorts-only playlist** (`UC…` → `UUSH…`): exact, no guessing by video length.
- **Default = All time, ranked like a recommendation system** (not newest-only): bigger pool of good Shorts; freshness is one signal plus a time filter.
- **Outlier score over raw views**: so small Bangla channels' hits compete with huge channels.
- **Layout: bars above and below the video** (not overlaid): YouTube's own embed overlays made overlaid controls messy on phones.
- **Sync through a Cloudflare Worker (option B)** instead of a token on each device: a static site can't keep secrets (all its code is public), so the GitHub token lives in the Worker; devices use a password → 180-day session.
- **Two repos**: free GitHub Pages needs a public repo, so personal data lives in a separate private repo.
- **Change-based merging** (operations replayed on the latest file) so phone and laptop never overwrite each other.
- **Kept channels with no Shorts** in the list: they may start posting Shorts later.
- **Shorts data is deployed as a build artifact, not committed**: avoids bloating the repo with a 2 MB file every 4 hours.
- **Channel list stays in `channels.json` (code repo), edited through the Worker**: one source of truth with full history; a commit automatically triggers a refresh.
- **Remove is a soft delete** (`"status": "removed"`), restorable forever; permanent Delete only from Removed — the user explicitly wanted a second, deliberate deletion.
- **RSS-first new-upload detection + age-based stats refresh**: cut API use per refresh ~35×.
- **Name search only on request**: it costs 100 units vs 2–3 for a handle/link.
- **Share uses the native share sheet / copy link** with the public `youtube.com/shorts/…` link (works for anyone, no app needed).
- **"More like this" in two layers**: YouTube removed its related-videos API in 2023, so similarity is computed from your own library (free) and, on request, by a keyword search (~103 units).
- **Quota guard with a server-side lock**: app warnings can be bypassed by bugs or old devices, so the Worker enforces the budget itself (Cloudflare KV counter); a fixed reserve keeps automatic refreshes safe.
- **Explore any channel, but keep only best 150 + recent**: deep history wasn't needed; previews load the newest ≤200 Shorts.
