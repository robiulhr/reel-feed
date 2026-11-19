# Ecomgy Reel Feed

A YouTube-Shorts-style feed that only shows Shorts from the channels in `channels.json`.

## Everyday use

```powershell
cd reel-feed
npm run fetch     # pull new Shorts + fresh stats (~600 API units)
npm run dev       # start the site
```

Open http://localhost:5173 on this PC. To watch on your phone (same Wi-Fi), open the
**Network** address that `npm run dev` prints, e.g. `http://192.168.x.x:5173`.
If Windows Firewall asks, allow access on **private** networks.

`npm run fetch:deep` digs further back into each channel's history (uses more quota).

## Adding / removing channels

Edit `channels.json`. Each entry:

```json
{ "name": "Channel name", "handle": "@handle", "cat": "bangla" }
```

`cat` is one of: `bangla`, `ads`, `stories`, `founders`, `books`, `ai`. Then run `npm run fetch`.

## Files

| Path | What |
|---|---|
| `.env` | Your YouTube API key (git-ignored, never share) |
| `channels.json` | Your channel list |
| `scripts/fetch.ts` | Fetches Shorts and computes scores |
| `src/rank.ts` | The recommendation logic (For You / Trending / Popular / Newest) |
| `data/`, `public/data/` | Generated data (git-ignored) |

Your saves, hidden channels, watch history and learned preferences are stored in the browser.
