# Reel Feed collector (Chrome extension)

Pick reels from a Facebook page's **Reels** tab and add them to Reel Feed in one go. Laptop/desktop
Chrome (or Edge) only.

## Install (once)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension` folder.
4. Pin it: puzzle-piece icon → pin **Reel Feed — collect page reels**.

The side panel explains the steps itself ("How to use this"). After you change these files, click the ↻ on the extension's card in `chrome://extensions`.

## A guard on the auto-scroll

To keep a long session from getting your Facebook account in trouble, **Keep scrolling** counts what it does: at most about 150 steps (5–6 minutes) per run, then a 10-minute break; about 3,000 reels and 30 minutes a day in total. At 80% it warns, at the limit it stops and says when you can go on, and the panel shows today's numbers. If Facebook shows a warning of its own ("temporarily blocked", "try again later"…) it stops at once and stays off for an hour. Scrolling by hand is never limited.

## Use

1. Open a Facebook page and its **Reels** tab (for example `facebook.com/nike/reels/`).
2. Click the extension's button: the side panel opens and lists the reels on screen.
3. Scroll the page to load more, or click **Keep scrolling**. It scrolls this one page slowly
   (every 1.5–2.5 s), stops when nothing new comes 3 times in a row, at 5,000 reels, or when you
   click **Stop scrolling**. It never runs by itself or in the background.
4. Narrow it down: **Min views** (e.g. `10K`, `1.5M`), **Sort** (page order, most or fewest views),
   **Search** (titles, captions, ids). Each reel shows its title and caption as they arrive.
5. **▶** plays the reel at the top of the panel so you can see what it is about (**↗ Open in a window**
   shows it on Facebook in a window of its own if it won't play there).
6. **Reels you've already added are marked.** Each one shows a green **✓ Added**, is dimmed and can't
   be ticked, and the top line counts them ("12 already added · 48 not added yet"). **Show** lets you
   see only the ones **not added yet** (or only the added ones). **Select shown** skips the added ones.
   The marks update by themselves as soon as you add or delete videos in Reel Feed.
7. Tick the ones you want. **Select top 60 new** ticks the 60 most viewed reels that aren't added yet (among
   those the filters show); add them, and pressing it again picks the next 60. **Select shown** ticks everything
   the filters show that isn't added yet.
8. **Add N to Reel Feed**: Reel Feed opens on the Added page with them. There each one shows its
   title and caption, has **▶ Watch**, and its own **✎ Categories & lists** (starting from the
   guess). **Set categories & lists for all selected** sets them on many at once. Untick any you
   don't want, then **Add**. Ones you already have are left out.

Reel Feed adds up to 60 at a time.

**How the panel finds Reel Feed:** when you open it, it looks for Reel Feed in your open tabs, puts its
small bridge script into them (Chrome only adds it to tabs opened *after* the extension was installed or
reloaded, so this also covers tabs that were already open) and waits for the app's answer. The note under
the filters says what happened:
- **✓ Reel Feed says you've added N videos (updated …)**: working; **↻ Refresh** asks again.
- **Reel Feed isn't open in a tab**: press **Open Reel Feed**; the marks arrive by themselves once it loads.
- **Reel Feed is open but didn't answer**: that tab is an older version of the app; press **Reload Reel Feed tab**.
If you just reloaded the extension (↻ on `chrome://extensions`), **close the side panel and open it again**:
a panel that was already open keeps running the old code.

**Marks not showing?** Open **Marks not showing? Details** under the filters. It lists the extension version,
how many Reel Feed tabs it found, how many added videos Reel Feed reported (and the first few of their
numbers), and the first few reel numbers on the page, so a mismatch is easy to see. "videos it reports: 0"
means the Reel Feed in that browser has no added videos saved (or they haven't synced to it yet).

## What it reads and sends

- It reads only the reel tiles on the Facebook tab you're looking at: link, view count, thumbnail.
- It sends nothing by itself. **Add** opens Reel Feed with the picked reel ids in the address
  (`/added#add=id,id,…`); the app looks each one up the same way as adding one by link.
- The "added" marks: Reel Feed (the app) posts the numbers of your added Facebook videos to its own page;
  a small script (`bridge.js`) that runs **only on Reel Feed's own address** stores them in the
  extension. Only those public video numbers travel, and only inside your browser. It doesn't read
  Facebook or anything else on the app's page.
- Titles and captions come from Reel Feed's own lookup (`/api/fb/meta`), two at a time, only for
  the reels the panel shows. They're kept in the extension's storage on this computer (up to
  3,000), so they aren't looked up again.

## Files

- `manifest.json`: Manifest V3; permissions are the side panel, its own storage, putting its script
  into a tab (`scripting`), and access to facebook.com and Reel Feed's address. Its only
  content script is `bridge.js`, on Reel Feed's own address; nothing is loaded into Facebook pages
  by itself.
- `content.js`: the panel puts it into a Facebook tab only when you open the panel on a page's Reels
  tab. It collects the tiles (and does the slow scroll) and does nothing on any other page.
- `bridge.js`: runs on Reel Feed's own site; keeps the list of videos you've added for the panel's marks.
- `panel.html`, `panel.css`, `panel.js`: the side panel.
- `background.js`: opens the side panel when you click the button.

## After you update the extension

Clicking ↻ on the extension's card cuts off the copy that was already running in an open Facebook
tab (Chrome calls this "Extension context invalidated"). That old copy now stops by itself without
errors, and the panel puts a new one in when you open it on a Reels tab. If the list stays empty,
reload the Facebook tab once.

If Chrome's extension page still lists "Extension context invalidated" for a Facebook tab, that is the
old copy from before an update: reload that Facebook tab (or close it), then use **Clear all** on
the extension's Errors page.

## Checking it for real (developers)

`npm run check:extension` starts Microsoft Edge with a throwaway profile and this extension, opens Reel
Feed with one added video, and checks the whole chain: the app's list reaches the extension, the panel
connects to the open Reel Feed tab, and the panel marks the reel; then it reads a real Facebook Reels page
and checks that a reel you "add" there is marked. Needs Edge (Chrome 137+ ignores `--load-extension`);
`BROWSER=path` and `APP=address` change the browser and the Reel Feed address.
