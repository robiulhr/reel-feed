# Ecomgy Reel Feed

A YouTube-Shorts-style feed that only shows Shorts from the channels in `channels.json`.

```
GitHub Actions (every 4h) ── fetch Shorts ── build ── GitHub Pages (public site)
Phone / laptop ── log in with password ── Cloudflare Worker (holds GitHub token) ── private repo: user-state.json
```

## Run it locally

```powershell
npm run fetch     # pull new Shorts + fresh stats (~600 API units)
npm run dev       # start the site at http://localhost:5173
```

`npm run fetch:deep` digs further back into each channel's history (uses more quota).

## Adding / removing channels

Edit `channels.json`, then push (or run `npm run fetch` locally). Each entry:

```json
{ "name": "Channel name", "handle": "@handle", "cat": "bangla" }
```

`cat` is one of: `bangla`, `ads`, `stories`, `founders`, `books`, `ai`.

## Sync server (Cloudflare Worker)

Lives in `worker/`. Wrangler needs Node 22+. Your PowerShell has Node 20, so first run:

```powershell
$env:Path = "$HOME\.nvm\versions\node\v24.14.0\bin;" + $env:Path
```

Then, inside `worker/`:

```powershell
npx wrangler login                          # one time, opens the browser
npx wrangler secret put GITHUB_TOKEN        # fine-grained token for the data repo
npx wrangler secret put APP_PASSWORD        # the password you type on each device
npx wrangler secret put SESSION_SECRET      # any long random string
npx wrangler deploy
```

Changing `APP_PASSWORD` or `SESSION_SECRET` logs out every device.

## Files

| Path | What |
|---|---|
| `.env` | YouTube API key for local fetches (git-ignored, never share) |
| `channels.json` | Your channel list |
| `scripts/fetch.ts` | Fetches Shorts and computes scores |
| `src/rank.ts` | Recommendation logic (For You / Trending / Popular / Newest) |
| `src/sync.ts` | Syncs saves/history/learning through the Worker |
| `worker/` | Cloudflare Worker that stores your data in the private GitHub repo |
| `.github/workflows/deploy.yml` | Scheduled fetch + deploy to GitHub Pages |
