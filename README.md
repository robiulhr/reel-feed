# Ecomgy Reel Feed

A personal, YouTube-Shorts-style feed that shows **only Shorts from a hand-picked list of channels** (business, marketing, e-commerce, founders, Bangla business creators…). Built for Ecomgy research: see what's working in short-form business content, save good examples, and let the feed learn what you like.

> This file is the single source of truth for how the app works, where everything lives, and why it was built this way. Keep it updated when something changes.

---

## 1. At a glance

| Thing | Where |
|---|---|
| Live site | `https://reel-feed.robiulhr2201.workers.dev/` (Cloudflare) — the old `https://robiulhr.github.io/reel-feed/` still works during the move |
| Code repo (public) | `https://github.com/robiulhr/reel-feed` |
| Personal data repo (**private**) | `https://github.com/robiulhr/reel-feed-data` → `user-state.json` |
| Sync server | Cloudflare Worker `reel-feed-sync` → `https://reel-feed-sync.robiulhr2201.workers.dev` (code in `worker/`) |
| Shorts refresh | GitHub Actions, every 4 hours (`.github/workflows/deploy.yml`) |
| Local folder | `Ecomgy/3 or 5 or 7 facts about big companies and entroponeours/reel-feed` |
| Cost | $0 (GitHub free, Cloudflare Workers free, YouTube API free quota) |

```
            every 4h, on channel edits, or "Refresh now"
GitHub Actions ───────────► YouTube (RSS + Data API) ──► shorts.json ──► build ──► Cloudflare Worker "reel-feed" (public site)
                                                                               └──► GitHub Pages (old address, until retired)
  (uses secret YOUTUBE_API_KEY)

Phone / laptop ── password login ──► /api on the site ──► Cloudflare Worker ──┬──► private repo: user-state.json (saves, history, learning)
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
  - **Breakouts**: biggest hits relative to each channel's normal views.
  - **Most viewed**: highest view count first — the best Shorts of any category, language and time range.
  - **Newest**: pure upload order.
- **Filters**: tap **⚙ Filters** for one sheet with **time range** (All time, 1 year, 3 months, 30 days, 7 days, Today), **views** (Any, 1K+, 10K+, 100K+, 1M+ — the fewest views a Short must have), language (All, বাংলা, English, हिन्दी/اردو) and every topic grouped with its number of Shorts. **They all combine**: e.g. Sales topics + 100K+ views + last 3 months, so an old viral Short doesn't crowd out recent ones (with **Most viewed** this means "the most viewed of the last 3 months"). The button shows **Show N Shorts** before you apply. The bar beside it keeps the quick ones: **All**, your active time/views/language (tap **✕** to remove one), your picked topics, the biggest main categories and **More…**. Pick several topics to see Shorts in any of them (§5a).
- **Actions** (bottom bar): sound, save ♡, **share ⤴** (phone share sheet with the YouTube Shorts link; on desktop it copies the link), **⋯** → More like this (§6d), Explore this channel (§6c), **🏷 Wrong category?**, Hide this channel, Open on YouTube. Tapping the **channel name** also opens the channel explorer.
- **Menu ☰**: **Channels** (control panel, §6a), **Sorting** (Shorts whose category is only a guess, §5a), **Saved** (search, sort, time, language and main category → topic chips; *▶ Play these* plays just the filtered ones), Hidden channels (unhide), Sync (log in / status), **API usage** (§6b), **Backups** (see below), About (stats, reset learning, show seen Shorts again).
- **NEW badge**: Shorts uploaded since your last visit (a gap of 30+ minutes counts as a new visit).
- Never shows the same Short twice (until you've seen everything in a filter); never the same channel twice in a row; max 3 per channel in any 20.
- Videos play through YouTube's **official embedded player** (views count for creators; nothing is downloaded or re-hosted).

---

### Speed & weak networks
- **Instant swipe** (`src/pool.ts`): 3 YouTube players — the current one, the **next one already loaded and paused on its first frame**, and the previous one for swiping back. Swiping switches players instead of loading. The video **follows your finger** and snaps (≥15% of the screen or a quick flick); rubber-band at the ends. **Swipe left** = channel page.
- **Fast start** (`src/data.ts`): the library is saved on the device (IndexedDB) → later visits start instantly and only download `meta.json` (~40 bytes) to check for news. First visit loads `starter.json` (~400 best Shorts, ~46 KB gzipped) → first video in about a second, while `shorts.json` (2.3 MB) downloads in the background. Requests time out and retry instead of hanging.
- **Page addresses & Back** (`src/router.ts` keeps the address, `src/routes.ts` shows what it points to):
  - `/` feed · `/v/VIDEO_ID` the feed on that Short · `/saved`, `/history`, `/channels`, `/sorting`, `/hidden`, `/sync`, `/usage`, `/backups`, `/about` · `/channel/handle` (no @) · `/similar/VIDEO_ID`.
  - **Back** (Android back swipe, browser ←) closes the top thing: a dialog or sheet, then a list you're swiping through (the page it came from comes back), then a page, then the menu. ✕ / Esc / tapping outside do exactly the same. Switching menu tabs and swiping through Shorts add no Back steps; the address just follows along, so a **refresh keeps your place**.
  - Opened straight on a deeper address (a link, a refresh on `/saved`): the feed is put underneath, so Back goes to the feed, not out of the app.
  - **Share** (↗) asks which link: the **Ecomgy link** `…/v/VIDEO_ID` (preview card in chats; people with the password open it in the app, everyone else is sent to the video on YouTube or Facebook) or the **original YouTube / Facebook link**. ⋯ → *Open on YouTube* still opens YouTube.
  - **Link previews**: WhatsApp, Facebook/Messenger, Telegram, X, Slack, Discord, LinkedIn… show that Short's **thumbnail, title and channel** (`worker/src/app.ts`: for those apps only, it asks YouTube's free oEmbed — no key, no quota — and writes the `og:`/`twitter:` tags into the page). People opening the link get the normal app straight away. Other pages show the app's general preview.
  - Files are loaded from absolute paths (`base: "/"`); the GitHub Pages copy is built with `BASE_PATH=/reel-feed/` and a `404.html` copy of the app so its deep links work too.
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
- **Nothing is erased for good by one tap** (`src/backup.ts`):
  - Every erase shows **Undo**: unsave, remove from history, clear history, unhide, hide/remove channel, reset what the feed learned, show seen Shorts again. The big ones ask first.
  - **Backups** (Menu → Backups): a copy of your synced data (saved, history, seen, hidden, learning, category fixes) kept in this browser (IndexedDB) — one a day and one right before every big erase or restore; kept 30 days (max 20, newest 3 always). **Restore** puts everything back as it was then, on all devices (it's a normal synced change, and the current data is backed up first). *Back up now* makes one by hand.
  - **From GitHub** (Menu → Backups → *Show versions*, needs sync): every sync is a commit in the private repo, so the last version of each day (30 days) can be restored from **any device — even a new one**. Uses the Worker's `GET /state/versions` (one GitHub call per day asked) and `GET /state/at?sha=…`; the current data is backed up on this device first.
  - Under the hood: `restore` op — *merge* (Undo of a clear: re-adds what was removed, keeps anything new from any device) or *replace* (backup restore / learning undo: exactly as it was).

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

### Reliability & security (engineering Phase 2)
- **Health box** (Menu ☰ → About): sync server reachable, last sync, changes waiting to upload, **GitHub token expiry** (orange under 30 days, with how to renew), app errors in the last 7 days. A once-a-day reminder toast appears when the token has <14 days left. The Worker reads the expiry date from GitHub's own response header — no extra calls.
- **Crash reporting** (`src/errors.ts`): unexpected errors show a friendly message with *Reload* and are sent to the Worker (max 10 per session; server keeps the newest 50, limited to 20/min). Nothing personal is sent — just the message, place and app version.
- **Login limit**: 5 wrong passwords from one connection → that connection is locked for 15 minutes (the message tells you how many tries are left). A correct login clears the count.
- **Security headers**: the site has a strict Content-Security-Policy (only our code, YouTube and the sync server can load) and sends no referrer; the Worker sends `nosniff`, `no-referrer`, `X-Frame-Options: DENY`.
- **Saved-data versioning**: local data has a version and is upgraded/repaired on start (broken fields get defaults; your settings are kept). If the synced file was written by a **newer** app version, an older copy refuses to overwrite it and asks you to update.
- **Upload queue cap**: at most 5,000 waiting changes offline; if exceeded, the least important ones go first (seen marks → learning signals → API log), saves/hides are kept.
- **Dependencies**: Dependabot opens weekly update PRs (app + Worker) and monthly ones for GitHub Actions; each PR runs all tests and `npm audit` before anything can be published.

### Clean code, accessibility & speed (engineering Phase 4)
- **Main file split** (was ~1,300 lines) into clear parts: `feed.ts` (what's on screen, next/back, lists, newer data), `player.ts` (player pool, watch clock, data saver), `controls.ts` (play, skip, progress bar, speed, sound, save, share, refresh), `gestures.ts` (swipe/tap/hold/wheel/keys), `panels.ts` (menu, pages, ⋯ sheet, tips, top bar), `settings.ts` (About + Sync), `fullscreen.ts`, `network.ts`, `view.ts` (page elements). `main.ts` only wires them and starts the app. Helpers that were copied into 7 files now live once in `dom.ts`.
- **Lint + formatting**: [Biome](https://biomejs.dev) (`biome.json`) checks for mistakes and keeps one code style. `npm run lint` checks, `npm run format` fixes. CI fails on lint errors. (Biome instead of ESLint because the TypeScript plugin for ESLint doesn't support TypeScript 7 yet.)
- **Accessibility** (`src/a11y.ts`):
  - Menu, pages, ⋯ sheet, tips and the app's dialogs are real dialogs for screen readers; focus moves into them, **Tab stays inside**, **Esc closes**, and focus goes back to the button that opened them.
  - Buttons say what they are and whether they're on (Save, sound, feed tabs, categories, speed); the progress bar is a slider (←/→ = 5 s when focused); each new Short is read out ("channel: title"); saved/history cards work with Enter/Space.
  - A visible focus ring for keyboard users; the phone's **reduce motion** setting turns off slides and animations; white text on red now meets the 4.5:1 contrast minimum.
  - Fixed: pressing **Enter while "Cancel" was focused in a confirm dialog confirmed it** (e.g. Delete). Enter now presses the focused button.
- **Performance budget** (`vite.config.ts`): the build fails if the app's code grows past **40 kB JS / 10 kB CSS** (gzip). At the time it was set: 28 kB / 5.6 kB. Raise it only on purpose.

### Automated tests (engineering Phase 3) — `tests/`
| Kind | Tool | What it covers | Run |
|---|---|---|---|
| Unit | Vitest + happy-dom | Data changes & merging across devices, sync file format, ranking & diversity rules, quota helpers, "More like this", button locking | `npm test` |
| Server | Vitest (real Worker code, in-memory KV, fake GitHub/YouTube) | Login & sessions, CORS, add/remove/restore/delete rules, Bangla handles, one commit per batch, **duplicate request protection**, lookups from any link style, preview/search caching, **budget lock**, sync conflicts, refresh | `npm test` |
| Accessibility | Playwright + axe-core | WCAG 2.1 A/AA scan of the main screen, tips, menu tabs and ⋯ sheet; menu keyboard focus (opens, stays inside, Esc returns focus); Enter on Cancel never confirms; on/off states announced; reduce-motion | `npm run test:e2e` |
| Browser | Playwright (Pixel 7 + 320 px phone, touch) with a fake YouTube player, fake sync server and sample data | Layout fits / no overlap, tips, swipe up/down/left, double-tap skip & save, hold 2×, drag progress bar, volume & speed, History, Refresh, offline banner, Add / Remove with triple taps (exactly one save, never the wrong channel), Delete dialog | `npm run test:e2e` |

- Everything: `npm run test:all` (lint + type check + unit + server + browser). First time on a PC: `npx playwright install chromium`.
- **On GitHub**: every code push runs all tests first; **if any fails, the site is not published** (the report is attached to the failed run). Scheduled refreshes, "Refresh now" and channel edits from the app skip the tests (no code changed).
- Bugs the tests already caught (fixed): stuck "busy" buttons after a failed action; same channel twice in a row with few channels; "More like this" finding nothing in small libraries; the last 0.3 s of changes lost when closing the app; the › arrow covering a menu tab; an outdated "Removed… Undo" message hiding newer ones; **a double tap on Remove could remove the next channel** (the row slid under your finger) — changed rows now stay in place with a short button cooldown.

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
| Fetch cache (known IDs, stats) | `data/cache.json` (generated; cached between Action runs). Keeps each channel's best 400 Shorts + the last 60 days; older, weaker ones are dropped (ids remembered, never refetched), so it and the weekly stats refresh stay bounded | – |
| Channel list (incl. removed channels) | `channels.json` in the code repo — edited from the Channels panel via the Worker | – |
| Saves, hidden channels, watched history, learning | Browser + **private repo `user-state.json`** via the Worker | ❌ never |
| Sound on/off, current tab, filters | That device's browser only (intentionally per device) | ❌ |
| YouTube API key | `.env` locally; GitHub Actions secret `YOUTUBE_API_KEY` | – |
| GitHub token (for the data repo) | Cloudflare Worker secret `GITHUB_TOKEN` only | – |
| App password | Cloudflare Worker secret `APP_PASSWORD` only | – |

**Several tabs at once** (`src/store.ts`): every tab keeps its own copy of your data and saves all of it to the same place in the browser (`localStorage`). The browser extension opens a new Reel Feed tab for each batch of videos, so tabs overlap often. Saving therefore **never overwrites**: before a tab saves, it takes in whatever another tab saved since it last looked (a union — nothing is removed; the other tab's unsent changes, such as a delete, are applied too), and tabs hear about each other's saves at once (the `storage` event), so a video added in one tab appears in the others without a reload. If the browser refuses to save (storage full or blocked) the app first drops the least useful data (old "seen" marks, watch history, API log) and retries, and if it still can't it shows a ⚠️ banner instead of failing silently. Tests: `tests/unit/tabs.test.ts` (several tabs as separate copies of the store) and an e2e with three real tabs. Before this (until the fix of 24 Nov 2026) the last tab to save wiped the others' additions — hundreds of videos could vanish.

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
- **Categories (`k`), language (`lg`), guessed (`g`)**: see §5a.
- **Relevance (`r`)**: keyword match on title/description (English + Bangla business words) blended with how close the Short's main category is to business (business 1, fun 0.6, Islamic 0.3).

Per channel it keeps the best 150 older Shorts + **every** Short from the last 60 days.

**b) In the browser (`src/rank.ts`)**
- For You = `0.28·outlier + 0.14·engagement + 0.14·trending + 0.12·freshness + 0.12·relevance + 0.20·your-taste + NEW bonus 0.15 + randomness ≤0.18`
- Trending = mostly trending speed; Breakouts = mostly outlier + total views; Most viewed = total views; Newest = upload time.
- A Short whose main category you picked gets +0.2; a guessed one −0.15.
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

## 5a. Categories — `src/categories.ts` (app) + `src/classify.ts` (rules; fetch, Worker, tests only)

**11 main categories, 27 topics.** In Filters, tap a main category to pick all its topics (✓), or pick single topics (– = partly picked). In the top bar a fully picked main category shows as one chip.
- 📣 **Marketing & Ads**: Meta & Google Ads · Marketing Strategy · Branding & Positioning · Design & Creative
- 🎬 **Content Creation**: Hook Ideas · Video Creation Tips (ideas, scripts, shooting, editing) · Video Growth Tips (views, reach, followers)
- 🛒 **Selling**: E-commerce · Sales & Customers
- 🏢 **Business & Learning**: Business Learning (start, run and grow a business; small-business ideas) · Tutorials & How-tos (step-by-step guides, any topic) · Business Stories (case studies) · Founders & Leaders (the people)
- 💰 **Money & Career**: Money & Investing · Career & Skills
- 🧠 **Mindset & Growth**: Self-growth
- 🤖 **AI & Tech**: AI & Tech Tools
- 🏷️ **Brands & Companies**: Famous Brand Ads · Funny Brand Content · Company Channels (a company's own channel, set per channel — no keywords)
- 😂 **Comedy & Fun**: Office & Work Fun · Comedy
- 💡 **Facts & Knowledge**: Facts & Knowledge · Other (picked by hand for videos that fit nowhere — no keywords)
- 🕌 **Islamic**: Quran Tilawat · Waz & Islamic Talks · Nasheed & Gajal — left out of **All**; pick it to see them (mixing it with other categories starts a new pick).

Change the grouping in `GROUPS` / `group:` in `src/categories.ts`. The library file carries its own category list and the app reads positions from that, so adding or reordering topics is safe (a new topic needs a `LEX` entry in `src/classify.ts`, even an empty one). Moving a keyword between topics re-sorts everything on the next fetch.
- **Where overlapping words live:** Hook Ideas = the word "hook" and opening-line talk; Branding = the word "brand", identity/strategy/positioning/naming; Marketing keeps only a weak "brand" hint; "viral", "reach", "followers", "algorithm" → Video Growth Tips (weak "viral"); editing/script/camera/b-roll → Video Creation Tips (Design & Creative keeps design tools, logos, thumbnails); "entrepreneur"/"startup" count fully for Business Learning but only as a weak hint for Founders, whose strong words are CEO, founder and famous names; "tutorial", "step by step", "for beginners" count fully for Tutorials, "how to" only weakly.

**Every Short is sorted by its own words** (`scripts/fetch.ts`, no AI at run time, no API key): keyword lists in English, Bangla (whole words) and Roman Bangla/Hindi score the title (×3), tags/hashtags (×2) and description (×1). Lines and tags a channel puts on most of its videos (links, "subscribe", course ads) are ignored.
- **1–3 categories per Short**, main first. A second/third only with real evidence — so a near-miss still shows up in the right chip.
- **Confident** when the words clearly say it (score ≥ 2.5). Otherwise the channel's habits decide: its **content mix** (what its confident Shorts are about, 60%) + **your categories for the channel** (40%). Those Shorts are marked **guessed** ("AI ?" under the title), rank a little lower and appear in **Menu → Sorting**.
- **A brand's own channel** (main category Famous Brand Ads, e.g. Banglalink, Grameenphone): every Short is a Brand ad first.
- Office jokes count as Office fun only with a humour signal (😂, funny, meme…); otherwise Career.
- **YouTube's own signals** (free, same API call): the video's topics (YouTube works these out from the video itself) and the creator's video category. Only the reliable ones count, as hints worth less than a clear title word: Knowledge/Politics/Military → Facts, Technology → AI, Humour or the Comedy category → Comedy, Religion on an Islamic video → Waz (or Nasheed when it's music). Vague ones (Entertainment, Lifestyle, Society, Education) are ignored, and Religion on Hindu/other videos doesn't count as Islamic.
- **AI labels for old guesses** (`ai-cats.json`): a one-off pass in November 2026 where Claude Haiku read the title, description and tags of every guessed Short and wrote its categories, or nothing when even it couldn't tell. The fetch uses a label **only for a Short the rules could only guess**, never over a clear keyword hit, and your own fixes still win. No API key is involved: it was run from a Claude Code session, not by the app. New Shorts after that date are sorted by the rules only; to label them, ask Claude Code to "redo the AI labels for guessed Shorts" (export guessed Shorts → Haiku labels them → merge into `ai-cats.json`).
- **Language** is separate: Bengali/Devanagari/Urdu letters, then Roman Bangla/Hindi words, then the channel's language.

**Fixing mistakes** (your answer always wins and syncs to your other devices as a `catFix` op):
- **⋯ → 🏷 Wrong category?** on any Short (unpick everything = back to automatic).
- **Menu → Sorting**: guessed Shorts, most viewed first — **✓ Right**, **Change**, or **▶ Play these**.
- A channel's categories (Channels panel or channel page) are only a starting guess; the mix line ("Posts: Marketing 40% · Money 40% …") shows what it really posts.

**Adding/renaming a keyword**: edit `LEX` in `src/classify.ts` (`~word` = weak hit, `=word` = whole word only), then `npm test`.

## 6. How sync works (`src/sync.ts`, `worker/src/index.ts`)

- Each device logs in **once** (Menu → Sync) with `APP_PASSWORD`. The Worker returns a signed **session valid 180 days**; the device stores only that, never the password or GitHub token.
- **The whole site is private** (live site, `worker/src/gate.ts`): every request runs the app Worker first. Without the password's cookie (`rf`, HttpOnly + Secure, same signed session, 180 days) the only thing anyone gets is a login page; scripts, data and `/api` answer 401. The login goes through the sync Worker's `/login`, so there is one password and one lockout (5 wrong tries → 15 minutes); the sync Worker's `GET /session` says whether a cookie is still good (cached for 1 minute). The login page also saves the session where the app keeps it, so the app doesn't ask again. **Log out this device** (Menu → Sync) clears the cookie and the offline copy and shows the login page again. Open to everyone: the install icon/manifest, and shared `/v/ID` links (chat apps get a preview card; people without the password are sent to the Short on YouTube). The GitHub Pages copy is not behind this — retire it (§ Later).
- Every change is recorded as a small **operation** ("saved X", "skipped channel Y", "hid Z"). **Your own changes (adding/editing/deleting a video, a note, a save, a hide, a list change…) go out within a second** (changes made together go in one save); background bookkeeping (seen marks, learning, watch history, API use) waits for the normal minute. Also when you leave the page and every 5 minutes, the app: reads the latest `user-state.json` → replays its own pending operations on top → writes it back. If another device saved in between (GitHub sha conflict), it re-reads and merges again. → Two devices can be used at the same time without overwriting each other.
- **The data file goes through the Worker untouched** (`GET/PUT /state2`, `GET /state/at2`): the app encodes (base64) and decodes it itself and the Worker only forwards GitHub's text. Why: Cloudflare's **free plan allows ~10 ms of processor time per request**; decoding, parsing and re-encoding the data file in the Worker took ~20 ms at 325 videos and ~60 ms (save) / ~90 ms (load) at 500 videos with a full history, and a request over the limit is cut off by Cloudflare itself with a bare **"Sync server error 500"** (the Worker's own errors always carry a message). Passing the text through costs under 1 ms at any size. The old `/state` addresses still work for older app copies, and the app falls back to them (a 404 "Not found") if the Worker isn't updated yet. If you see "Sync server error 500" again: Cloudflare dashboard → Workers → reel-feed-sync → Metrics shows "Exceeded CPU limit" for that request.
- Offline: operations wait in the browser and sync later.
- The first login on a device merges that device's existing local data into the shared file.
- **Every sync is a commit** in `reel-feed-data` → full version history = backup. To restore an older state: in the app, Menu → Backups → *Show versions* → Restore (last 30 days). Older than that: open the repo on GitHub → `user-state.json` → History → copy an old version back.
- Worker protections: only the app's own sites (`ALLOWED_ORIGINS` in `worker/wrangler.toml`) and local dev addresses may call it; wrong passwords are slowed down; changing `APP_PASSWORD` or `SESSION_SECRET` logs out every device.
- The Worker refuses to sync without a session; the site itself works without sync (data then stays in that browser only).

---

## 6a. Channels panel (Menu ☰ → Channels) — `src/channels.ts`

- **List** of every channel: avatar, name, @handle, status, subscribers, Shorts in your feed, latest upload, your taste score.
  Status: *Active* · *No Shorts yet* · *Not found* · *Waiting for refresh* (just added/restored) · *Removed*; plus *Hidden* if you hid it.
- **Search** (name/handle), **filter** by category and status, **sort** by name, subscribers, Shorts in feed, latest upload, your taste.
- **Add**: paste `@handle`, any YouTube link (channel, `/channel/UC…`, a Short or video link, `youtu.be/…`) or type a name.
  - Handles/links → instant lookup (**2–3 API units**). A name → **Search YouTube** button (**~100 units**, only when you press it).
  - Preview card: avatar, name, handle, subscribers, total videos, **number of Shorts**, latest Short, description; up to 2 categories **suggested automatically** from its name and description (same rules as the Shorts); warnings for *already in list*, *in Removed (adding restores it)*, *no Shorts yet*.
  - Lookups are remembered for the session, so repeating one costs nothing.
- **Change categories** (pick up to 3, first = main) inline; each row also shows the channel's real content mix.
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

## 6e. Channel lists — `src/lists.ts` (Competitors, Inspiration, Ads updates, AI updates…)
- Put a channel in one or more lists: **⋯ → 📋 Add channel to a list**, or the **📋** button on its channel page. You can make a new list in the same dialog.
- **Each list is its own feed.** The top bar shows a chip for each list that has channels (e.g. 🎯 Competitors). Tap ✕ on it to go back to all channels. The Filters sheet has a **Channel lists** section, and **Edit lists** there lets you rename lists, change icons, delete lists and take channels out.
- **Saved has a tab per list** ("🎯 Competitors · 3"), so you can look at what you saved from competitors on its own.
- These Shorts still show in every other feed as before; a list only adds a way to look at them separately.
- Lists sync across devices: `lists` in user-state.json, file version 3. Older app versions refuse to write the file, so they can't drop the lists.

## 6f. Facebook videos you add by link — `src/manual.ts`, `src/fbdata.ts`, `src/fbplayer.ts`, `worker/src/fb.ts`
- **Add one:** **⋯ → ＋ Add a Facebook video**, or **Menu → Added → ＋ Add a Facebook video**. Paste the link (share/v, reel, videos, watch and fb.watch links all work).
- **Add several at once** (`src/bulkadd.ts`, loaded only when used): **Menu → Added → ＋ Add several at once**. Paste links (one per line, or a whole message with links in it), **Look them up** (3 at a time, up to 60). Videos you already added are shown and left out. Each row shows the title and the rest of the caption, **▶ Watch** (Facebook's embedded player, one at a time), and **✎ Categories & lists** for that video alone (starting from its guess). **Set categories & lists for all selected** applies to every ticked one: its categories replace theirs, its lists are added. Untick any you don't want. Opening the app at `/added#add=ID,ID,…` (reel ids or links) opens this screen with them; the address is cleaned right away.
- **Browser extension** (`extension/`, see its README): on a laptop, collect reels from a Facebook page's Reels tab as you scroll (or with a slow **Keep scrolling** on that one page), filter by views, sort, search, tick the ones you want, and send them here through `#add=`. Reels you've **already added are marked** (green ✓ Added) so you can see at a glance what's new: the app tells the extension the numbers of your added videos (`src/extbridge.ts` posts them to its own page; the extension's `bridge.js`, which runs only on this site, keeps them) and again after every add, delete, undo or sync.
- **It fills itself in:** the app's Worker (`/api/fb/meta`) follows the link to the video, then reads Facebook's public pages. It gets the caption (used as the title), the views and reactions at that moment, the page name and the page's address, guesses the categories from the caption and hashtags, and checks the video can be embedded. Everything stays editable. The requests carry an honest user agent and only ever go to Facebook addresses. Any part that fails is left empty for you to fill in.
- **Fields:** Title (shown on the video), Note (private; shown only on the Added page), Who made it (page name, page link, and optionally *Same as my YouTube channel*), Categories (required), Lists (optional, for this one video).
- **Pages:**
  - A page linked to one of your YouTube channels: its videos count as that channel's, so they join its lists and feeds, and the channel page gets **↗ Facebook page**.
  - A page on its own: it gets its own screen (`/channel/fb:…`) and can be put on lists like a channel.
- **In the feeds:** the videos are Shorts with the id `fb` + Facebook's number, mixed into every feed that matches their categories or lists. They play in Facebook's player (its JavaScript SDK, loaded the first time one plays), driven by the app's own tap, swipe, sound and progress controls. Each one has **↗ Open video on Facebook** and **↗ Open page on Facebook**. If a video can't play, a toast offers to open it on Facebook.
- **Added is separate from Saved.** Added lists everything you added, with search, a page filter, list and category chips, and ♡ Save, ✎ Edit, ↗ and Delete. ♡ works like on any Short. Saved has a **Source** row (YouTube / Facebook). Deleting a video also takes it out of Saved, and you can Undo.
- **Thumbnails** come through `/api/fb/thumb/ID`, which redirects to Facebook's current image. Facebook's image links expire, so they're never stored.
- **Pages:** pasting a page's link calls `/api/fb/page?url=LINK`, which returns its name, address, follower count and about text, and fills them in. Its picture comes through `/api/fb/pagepic?path=/address`, a redirect like the thumbnails. Opening ✎ Edit on a video with no page looks the page up again.
- **Sync:** `manual` and `fbPages` in user-state.json (file version 4). Older apps refuse to write the file, so they can't drop the videos you added.
- **Dev:** `npm run dev` answers `/api/fb/*` with the same Worker code (vite.config.ts).

## 6g. Notes on videos — `src/notes.ts`, `store.ts` (`notes`)
- **On every video** (any Short or Facebook video) there is an amber **📝 Add note** chip above the channel name, the most eye-catching thing on the screen. Tap it, or press **N**. Once you have a note, the chip shows its first words (outlined in amber) so you see it while watching.
- **The note sheet** names the video and has a large box (up to 5,000 characters), **⏱ Add time** (puts the video's current time, like `[0:12]`, into the note), **Copy** and **Delete note** (with Undo). The video pauses while you write and plays on after. Closing it in any way (Save, Close, Esc, tapping outside) keeps what you typed, so a note is never thrown away by accident.
- **Menu → 📝 Notes** (`/notes`) lists all your notes, newest first, with search, **▶ Play** (plays your noted videos one after another), **✎ Edit**, **Copy**, **Delete** (with Undo) and **Copy all notes**. Grids of videos (channel pages, More like this) mark videos that have a note with 📝, and the Added page shows the note on its card.
- **Data:** `notes` is `{ feedId: { x: text, at: last changed, ti: the video's title then } }`, one per video. The title is kept so the Notes page still works if a video leaves the library. Changes are `note` operations; when two devices write on the same video, the newer one wins (an older delete can't remove a newer note). Notes are in backups and in the synced user-state.json, which is now **file version 5**, so an older app can't write the file and drop them.
- **The Facebook video note** (the Note field when you add or edit a Facebook video) is now the same note: it is moved into `notes` once, and the field in the Add dialog reads and writes it.
- **Size:** the sheet and the Notes page are a separate small file, downloaded the first time they're used.

## 6g. Activity log and cloud status — `src/activity.ts`, `src/cloud.ts`, `src/locallog.ts`, `src/sync.ts`, `src/store.ts`
- **The Menu is a home screen** (`src/menuhome.ts`): your library as cards with counts (Saved, Added, Notes, History, Hidden), then Discover (Channels, Sorting with "N to check" in orange), Your data (Activity "N today", Sync, Backups, API usage) and About, with the cloud-status line on top. A page opens with a **← back arrow** and its name in the header (no row of 12 tabs). Pages stay reachable by address (`/menu`, `/saved`, …).
- **Activity page** (`src/activity.ts`): a summary on top (changes this week, videos added, notes written, 7-day bars), then lines with the video's **thumbnail**, a coloured label (Added / Edited / Deleted / Saved / Note / Sync / Problem…), the title (tap to open the video), its page, views, categories and list, and the device. A bulk add is one line that opens into the videos in it (the ids are kept on the line, `ActivityEntry.ids`).
- **Menu → 🧾 Activity** lists everything that happened, newest first, by day: **Changes** (what you did to your data, on any device), **Watching** (watch history), **Sync** (how saving to the cloud went, on this device), **API** (YouTube API units spent) and **Problems** (a failed save, a browser that wouldn't save, an app error). Filter chips with counts, a search box, "Show more", a device badge (📱/💻) on changes, **⬇ Export what's shown (CSV)** and **Cloud history** (every save is a version in the private repo, last 30 days).
- **How it's recorded:** `act(op)` writes one line for every real change *before* applying it (so a delete still knows the title) as an `activity` operation next to the change itself. It syncs like any operation, so the phone's changes appear on the laptop (file **version 6**; older apps refuse to write the file rather than drop the log). Lines have a unique id (never added twice when operations replay), newest first, at most 1,500. Background bookkeeping isn't logged; a bulk add logs **one** line ("Added 60 Facebook videos at once …"). Sync results, save problems and caught errors are kept on the device only (`locallog.ts`, 150 lines).
- **Cloud status** (`cloud.ts`): a line on the Added page and at the top of Activity — **☁️ All saved to the cloud** / **Saving N changes…** / **⚠️ Couldn't reach the cloud — N changes not saved yet. Trying again…** / **⚠️ Not backed up** (sync isn't connected: a **Connect** button opens Menu → Sync). When something needs you the **Menu button gets an orange dot**, and changing something without sync connected shows a warning (at most every 5 minutes).
- **Sync behaviour** (`sync.ts`): own changes push after 0.8 s; a failed save retries after 3 s, 10 s, 30 s, 1 min, 2 min (not after a log-out); four conflicts in a row used to end as a silent "success" and are now a visible, retried problem. The browser still keeps a working copy (offline use, instant screens) but the cloud file is what other devices and tabs read; the browser copy is a cache plus a short list of unsent changes.
- Tests: `tests/unit/activity.test.ts` (recording, merge, version, sync timing/retries/conflicts with a pretend cloud and a controlled clock, status wording) and `tests/e2e/activity.spec.ts`.

## 6c. Channel explorer — `src/explore.ts`

- Open it by tapping the **channel name/avatar** under a Short, **⋯ → Explore this channel**, a channel in **More like this**, or **Preview Shorts** in Channels → Add.
- **Header**: avatar, name, handle, subscribers, Shorts count, latest upload, status (*In your list* / *Removed* / *Not in your list*, plus *Hidden*).
- **Actions**: in your list → categories, Hide/Unhide, Remove · removed → Restore · not in your list → categories (suggested) + **Add to my list**.
- **Grid** with **Newest · Most viewed · Breakouts** (views ÷ the channel's median, shown as ×N), a **period** and one sideways row of **topic chips** (what this channel posts, with counts) (All time / This year / 30 days / 7 days) — e.g. *Most viewed · Sales · This year* — and **▶ Play all**.
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
{ "name": "Channel name", "handle": "@handle", "cats": ["marketing", "ads"], "id": "UC…(optional)", "status": "removed (optional)" }
```
`cats`: 1–3 ids from `src/categories.ts` (`ads marketing ecom sales stories founders money growth career ai creative brandads brandfun workfun comedy facts quran waz nasheed`), main first. An old single `"cat"` still works and is translated. Channels with no Shorts yet are fine to keep — they appear automatically once they post Shorts.

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

**Automatic deploys** (`.github/workflows/worker.yml`): every push to `main` that changes `worker/` type-checks and deploys the Worker — no need to run `wrangler deploy` by hand. Also runnable from Actions → *Deploy sync Worker* → Run workflow. One-time setup:
1. Cloudflare dashboard → My Profile → API Tokens → **Create Token** → template **Edit Cloudflare Workers** → Account Resources: your account; Zone Resources: *All zones* is fine (the Worker uses no zone) → Create. Copy the token (shown once).
2. GitHub `reel-feed` → Settings → Secrets and variables → Actions → **New repository secret** → name `CLOUDFLARE_API_TOKEN`, paste the token.
3. Only if the token covers more than one Cloudflare account: add a repo **variable** `CLOUDFLARE_ACCOUNT_ID` (dashboard → Workers & Pages → Account ID on the right).

The Worker's secrets (`GITHUB_TOKEN`, `APP_PASSWORD`, …) stay in Cloudflare and survive every deploy; secrets are still set by hand with `wrangler secret put`.

**The site itself on Cloudflare** (`worker/app.wrangler.toml` + `worker/src/app.ts`, Worker `reel-feed`):
- *Fetch Shorts & deploy* builds the app with `VITE_SYNC_URL=/api` and runs `wrangler deploy --config app.wrangler.toml` (same `CLOUDFLARE_API_TOKEN`). It also still publishes to GitHub Pages during the move.
- Files in `dist/` are served directly (free, no code runs). Any other path returns the app (`index.html`), ready for page links. Code only runs for `/api/*` and `/v/*` (share-link previews).
- `/api/*` is passed to `reel-feed-sync` through a service binding — same address as the app, so no cross-site requests. Same-site GETs carry no `Origin`, so `app.ts` adds the site's own one.
- Browsers keep data per address: on the new address log in to Sync once per device; "On this device" backups stay with the old address.
- Local test of both Workers together: build with `VITE_SYNC_URL=/api`, then in `worker/`: `npx wrangler dev -c app.wrangler.toml -c wrangler.toml`.

**Forgot the app password?** Nothing is lost (data is in GitHub). Reset it: Cloudflare dashboard → Workers & Pages → `reel-feed-sync` → Settings → Variables and Secrets → edit `APP_PASSWORD`, or `npx wrangler secret put APP_PASSWORD`. All devices log out; log in again. Devices already logged in keep working until you reset.

---

## 9. Setup checklist

- [x] YouTube API key created, saved in `.env`, tested
- [x] Code pushed to `robiulhr/reel-feed`; private repo `robiulhr/reel-feed-data` created
- [x] Cloudflare account created
- [ ] Revoke the token that was pasted in chat; create a new fine-grained token (settings in §4)
- [x] `wrangler login` + set `GITHUB_TOKEN`, `APP_PASSWORD`, `SESSION_SECRET`
- [x] `npx wrangler deploy` → `https://reel-feed-sync.robiulhr2201.workers.dev`
- [ ] Repo secret `CLOUDFLARE_API_TOKEN` for automatic Worker deploys (§8 → Automatic deploys)
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
| Login: "Too many wrong passwords… try again in 15 minutes" | Wait 15 minutes (or use a different network). |
| About → Health: token "expires in N days" (orange/red) | Make a new token (§4) → `npx wrangler secret put GITHUB_TOKEN` in `worker/`. |
| "Your data was saved by a newer version of the app" | Close and reopen the app (or About → Check for app update); sync continues after the update. |
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
| `src/main.ts` | Entry point: wires the parts together, boot, app updates |
| `src/feed.ts` | What's on screen, next/back, temporary lists, learning signal, newer data |
| `src/player.ts` | YouTube player pool instance, watch clock, data saver |
| `src/controls.ts` | Play/pause, skip, progress bar, speed, sound, save, share, refresh |
| `src/gestures.ts` | Swipe, tap, hold, wheel and keyboard shortcuts |
| `src/panels.ts` | Menu panel (Saved, Hidden…), pages, ⋯ sheet, tips, top bar |
| `src/settings.ts` | About + Sync panels |
| `src/fullscreen.ts`, `src/network.ts` | Full screen; offline / slow-network handling |
| `src/view.ts`, `src/dom.ts`, `src/a11y.ts` | Page elements; shared helpers; accessibility helpers |
| `src/errors.ts`, `src/health.ts` | Crash reporting; Health box |
| `src/rank.ts` | Recommendation logic |
| `src/store.ts` | Local state, change operations, file format |
| `src/sync.ts` | Sync with the Worker |
| `src/channels.ts` | Channels control panel |
| `src/usage.ts` | API usage page (incl. discovery budget) |
| `src/quota.ts` | Quota guard: cost card, budget, cache reuse hints |
| `src/explore.ts` | Channel explorer page + Short grid |
| `src/similar.ts` | More like this (library similarity + YouTube search) |
| `src/app.ts` | Interface the feature modules use to talk to the main app |
| `src/pool.ts` | Pool of YouTube players for instant swipes |
| `src/data.ts` | Starter/full/saved library loading, update checks, slow-network detection |
| `src/history.ts` | Watch history panel |
| `src/categories.ts`, `src/classify.ts` | Category list + language detection (app); keyword rules (fetch/Worker/tests) |
| `src/catpicker.ts`, `src/sorting.ts` | Category picker dialog; Menu → Sorting |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icon.svg` | Offline app files, install support, icon |
| `public/data/meta.json`, `starter.json` | Generated by the fetch: version check + fast-start subset |
| `src/style.css`, `index.html` | Layout: top bar / video / bottom bar |
| `worker/` | Cloudflare Worker (login, sessions, `user-state.json`, `channels.json` edits, channel lookups, refresh trigger) |
| `.github/workflows/deploy.yml` | Tests (lint, types, unit, server, browser) → scheduled fetch + build + deploy to Pages |
| `biome.json` | Lint + formatting rules |
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
- **Share uses the native share sheet / copy link**, with a choice of the Ecomgy link or the video's own public `youtube.com/shorts/…` (or Facebook) link.
- **"More like this" in two layers**: YouTube removed its related-videos API in 2023, so similarity is computed from your own library (free) and, on request, by a keyword search (~103 units).
- **Quota guard with a server-side lock**: app warnings can be bypassed by bugs or old devices, so the Worker enforces the budget itself (Cloudflare KV counter); a fixed reserve keeps automatic refreshes safe.
- **Explore any channel, but keep only best 150 + recent**: deep history wasn't needed; previews load the newest ≤200 Shorts.
