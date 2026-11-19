# Ecomgy Reel Feed

A personal, YouTube-Shorts-style feed that shows **only Shorts from a hand-picked list of channels** (business, marketing, e-commerce, founders, Bangla business creators…). Built for Ecomgy research: see what's working in short-form business content, save good examples, and let the feed learn what you like.

> This file is the single source of truth for how the app works, where everything lives, and why it was built this way. Keep it updated when something changes.

---

## 1. At a glance

| Thing | Where |
|---|---|
| Live site | `https://robiulhr.github.io/reel-feed/` (after setup is finished) |
| Code repo (public) | `https://github.com/robiulhr/reel-feed` |
| Personal data repo (**private**) | `https://github.com/robiulhr/reel-feed-data` → `user-state.json` |
| Sync server | Cloudflare Worker named `reel-feed-sync` (code in `worker/`) |
| Shorts refresh | GitHub Actions, every 4 hours (`.github/workflows/deploy.yml`) |
| Local folder | `Ecomgy/3 or 5 or 7 facts about big companies and entroponeours/reel-feed` |
| Cost | $0 (GitHub free, Cloudflare Workers free, YouTube API free quota) |

```
                 every 4h
GitHub Actions ───────────► YouTube Data API ──► shorts.json ──► build ──► GitHub Pages (public site)
  (uses secret YOUTUBE_API_KEY)

Phone / laptop ── password login ──► Cloudflare Worker ──────────► private repo: user-state.json
                  (keeps a 180-day     (holds GitHub token          (every sync = a commit = backup)
                   session, not the     + password as secrets)
                   password)
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
- **Actions** (bottom bar): sound, save ♡, hide channel ⊘, open on YouTube ↗.
- **Menu ☰**: Saved list, Hidden channels (unhide), Sync (log in / status), About (stats, reset learning, clear history).
- **NEW badge**: Shorts uploaded since your last visit (a gap of 30+ minutes counts as a new visit).
- Never shows the same Short twice (until you've seen everything in a filter); never the same channel twice in a row; max 3 per channel in any 20.
- Videos play through YouTube's **official embedded player** (views count for creators; nothing is downloaded or re-hosted).

---

## 3. Where data lives

| Data | Stored in | Sent to YouTube? |
|---|---|---|
| Shorts list + stats | `public/data/shorts.json` (generated, not committed) | – (read from YouTube) |
| Fetch cache (known IDs, stats) | `data/cache.json` (generated; cached between Action runs) | – |
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

**GitHub token settings** (fine-grained, `github.com/settings/personal-access-tokens`):
name `reel-feed-sync` · resource owner `robiulhr` · **Only select repositories → `reel-feed-data`** · **Contents: Read and write** (Metadata read-only is added automatically) · everything else *No access* · expiry 1 year.
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

## 7. Everyday use

**Watch**: open the live site on any device. First time on a device: Menu → Sync → enter password.

**Add / remove channels**: edit `channels.json`, commit, push → the next Action run picks them up (or run it manually: GitHub → Actions → *Fetch Shorts & deploy* → Run workflow).

```json
{ "name": "Channel name", "handle": "@handle", "cat": "bangla" }
```
`cat`: `bangla`, `ads`, `stories`, `founders`, `books`, `ai`. Channels with no Shorts yet are fine to keep — they appear automatically once they post Shorts.

**Run locally** (from the `reel-feed` folder; works with Node 20+):
```powershell
npm run fetch        # new Shorts + fresh stats (~600 API units; first-ever run ~1,100)
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
- [ ] `wrangler login` + set `GITHUB_TOKEN`, `APP_PASSWORD`, `SESSION_SECRET`
- [ ] `npx wrangler deploy` → note the Worker address
- [ ] GitHub repo `reel-feed` → Settings → Pages → Source: **GitHub Actions**
- [ ] Repo secret `YOUTUBE_API_KEY` (Settings → Secrets and variables → Actions → Secrets)
- [ ] Repo variable `SYNC_URL` = Worker address (same page → Variables)
- [ ] Actions → *Fetch Shorts & deploy* → Run workflow → open the live site
- [ ] Log in on each device via Menu → Sync

---

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| `'Set-Location' is not recognized` | You're in **cmd**, not PowerShell — use the cmd commands in §8. |
| `Wrangler requires at least Node.js v22.12.0` | Switch the terminal to Node 24 (§8). |
| Fetch says *quota used up* | Wait until midnight Pacific; normal refreshes use ~600 units. |
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
| `src/player.ts` | YouTube IFrame Player wrapper |
| `src/style.css`, `index.html` | Layout: top bar / video / bottom bar |
| `worker/` | Cloudflare Worker (login, sessions, read/write `user-state.json`) |
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
