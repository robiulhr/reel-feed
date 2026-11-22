/** Menu → About (stats, version, health, data saver, full screen, shortcuts) and Menu → Sync (login). */
import { persist, state } from "./store";
import { type Backup, backupNow, backupsAvailable, describe, eraseWithUndo, listBackups, restoreBackup } from "./backup";
import * as sync from "./sync";
import { resetChannels } from "./channels";
import { busy, confirmDialog, toast } from "./ui";
import { renderHealth } from "./health";
import { ago, btn, compact, el, para } from "./dom";
import { feed } from "./feed";
import { playback } from "./player";
import { isStandalone } from "./fullscreen";
import { applyNetwork } from "./network";
import { renderPanel } from "./panels";

export function renderAbout(body: HTMLElement, opts: { showTips: () => void }) {
  const ds = feed.ds;
  const seen = Object.keys(state.seen).length;
  const updated = ds.generatedAt ? `${new Date(ds.generatedAt * 1000).toLocaleString()} (${ago(ds.generatedAt)})` : "never";
  const stats = el("div", "stats");
  for (const [n, label] of [
    [ds.videos.length, "Shorts in library"],
    [ds.channels.filter((c) => c.st === "active").length, "Channels with Shorts"],
    [state.hist.length, "In your history"],
    [state.saved.length, "Saved"],
  ] as const) {
    const d = el("div", "stat");
    d.append(el("b", "", compact(n)), el("span", "", label));
    stats.append(d);
  }
  body.append(stats, para(`Shorts last updated: ${updated}. New Shorts arrive automatically every 4 hours — tap ↻ for a fresh feed.`));

  const builtAt = new Date(__BUILD__);
  body.append(
    para(`App version: ${builtAt.toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`, "ver"),
    btn(
      "Check for app update",
      (b) =>
        busy(b, "Checking…", async () => {
          const reg = await navigator.serviceWorker?.getRegistration();
          await reg?.update().catch(() => {});
          toast(
            reg?.installing || reg?.waiting
              ? "Updating — the app will reload"
              : "Checked ✓ — if the version above doesn't change, close the app fully and open it again",
          );
          if (!reg) location.reload();
        }),
      "btn",
    ),
  );
  const healthBox = el("div");
  body.append(healthBox);
  renderHealth(healthBox);

  // data saver
  const saverRow = el("label", "u-budget-form");
  const sel = el("select");
  for (const [v, l] of [
    ["auto", "Auto (on when the connection is slow)"],
    ["on", "Always on"],
    ["off", "Off"],
  ])
    sel.append(new Option(l, v));
  sel.value = state.dataSaver;
  sel.onchange = () => {
    state.dataSaver = sel.value as typeof state.dataSaver;
    persist();
    applyNetwork(true);
    renderPanel();
  };
  saverRow.append(el("span", "", "Data saver:"), sel);
  body.append(
    saverRow,
    para(
      playback.dataSaver
        ? "Data saver is ON now: smaller thumbnails and less preloading, so it works better on slow connections."
        : "Data saver is off now: the next video is preloaded so swiping is instant.",
    ),
  );

  const fsRow = el("label", "u-budget-form");
  const fsBox = el("input");
  fsBox.type = "checkbox";
  fsBox.checked = state.autoFull;
  fsBox.onchange = () => {
    state.autoFull = fsBox.checked;
    persist();
  };
  fsRow.append(
    fsBox,
    el(
      "span",
      "",
      "Full screen automatically on phones (hides the browser's address bar after your first tap). ⋯ → Full screen toggles it.",
    ),
  );
  body.append(
    fsRow,
    para(
      isStandalone()
        ? "You're using the installed app — it's always full screen."
        : "Tip: install it (browser menu → Install app / Add to Home screen) to open full screen like a normal app.",
    ),
  );

  const keys = el("p");
  keys.innerHTML =
    "Phone: <b>swipe up/down</b> · <b>swipe left</b> for the channel · tap to pause · <b>double-tap left/right</b> = 10 s back/forward · double-tap middle = save · <b>hold</b> = 2× · drag the progress bar to jump · speed in ⋯.<br>Keys: <b>↑/↓</b> move · <b>←/→</b> 10 s · <b>&lt; &gt;</b> speed · <b>c</b> channel · <b>Space</b> pause · <b>m</b> sound · <b>+/−</b> volume · <b>s</b> save · <b>r</b> refresh · <b>f</b> full screen · <b>Esc</b> close / back. <b>Tab</b> moves between buttons.";
  body.append(
    keys,
    btn("Show the tips again", () => opts.showTips(), "btn"),
    btn(
      "Reset what the feed learned",
      () =>
        eraseWithUndo({
          ask: {
            title: "Reset what the feed learned?",
            body: "For You forgets which channels and topics you like, on all your devices. You can undo it, and a backup is saved first.",
            confirm: "Reset",
          },
          op: { t: "resetLearn" },
          keys: ["affCh", "affCat"],
          undo: "replace",
          backup: "Before: reset what the feed learned",
          done: "Learning reset",
          after: () => {},
        }),
      "btn",
    ),
    btn(
      `Show already-seen Shorts again (${compact(seen)})`,
      () =>
        eraseWithUndo({
          ask: {
            title: `Forget the ${compact(seen)} Shorts you've seen?`,
            body: "They can show up in your feed again, on all your devices. You can undo it, and a backup is saved first.",
            confirm: "Forget seen",
          },
          op: { t: "clearSeen" },
          keys: ["seen"],
          undo: "merge",
          backup: "Before: show seen Shorts again",
          done: "Done — seen Shorts can appear again",
          after: renderPanel,
        }),
      "btn danger",
    ),
  );
}

export function renderSyncPanel(body: HTMLElement) {
  if (!sync.isAvailable()) {
    body.append(
      para("Sync isn't set up for this copy of the site yet (no sync server address). Your data is kept in this browser for now."),
    );
    return;
  }
  if (sync.isConnected()) {
    const st = sync.status();
    body.append(
      para("This device is logged in. Saves, hidden channels, history and learning sync across all your devices."),
      para(st.busy ? "Syncing…" : `Last synced: ${st.lastSync ? ago(st.lastSync / 1000) : "not yet"}`),
      para(`Changes waiting to upload: ${st.pending}`),
    );
    if (st.lastError) body.append(para(`Problem: ${st.lastError}`, "error"));
    body.append(
      para("Every sync is a commit in your private GitHub repo, so GitHub keeps every earlier version as a backup."),
      btn(
        "Sync now",
        (b) =>
          busy(b, "Syncing…", async () => {
            await sync.syncNow();
            renderPanel();
          }),
        "btn",
      ),
      btn(
        "Log out this device",
        async () => {
          const ok = await confirmDialog({
            title: "Log out this device?",
            body: "Your saves, history and learning stay safe in GitHub. You can log in again any time.",
            confirm: "Log out",
            danger: true,
          });
          if (ok) {
            sync.disconnect();
            resetChannels();
            renderPanel();
          }
        },
        "btn danger",
      ),
    );
    return;
  }

  const st = sync.status();
  body.append(
    para("Log in to sync your saves, history and learning across devices, and to add channels. You only need to do this once per device."),
  );
  if (st.lastError) body.append(para(st.lastError, "error"));
  const form = el("form", "form");
  const label = el("label", "", "Password");
  const input = el("input");
  Object.assign(input, { name: "password", type: "password", autocomplete: "current-password", required: true });
  label.append(input);
  const err = para("", "error");
  err.setAttribute("role", "alert");
  const go = btn("Log in", () => {}, "btn primary");
  go.type = "submit";
  go.onclick = null;
  form.append(label, go, err);
  form.onsubmit = (e) => {
    e.preventDefault();
    err.textContent = "";
    busy(go, "Logging in…", async () => {
      const msg = await sync.connect(input.value);
      if (msg) {
        err.textContent = msg;
        input.focus();
      } else {
        toast("Logged in — your data is synced");
        renderPanel();
      }
    });
  };
  body.append(form);
}

/** Menu → Backups: copies of your data kept in this browser; Restore puts everything back as it was then. */
export async function renderBackups(panel: HTMLElement) {
  // drawn into its own box: if you switch tabs while it loads, the box is simply gone
  const body = el("div");
  panel.append(body);
  body.append(
    para(
      "A copy of your saved Shorts, history, seen list, hidden channels and what the feed learned — kept in this browser. One is made every day and right before anything big is erased. Kept for 30 days.",
    ),
  );
  if (!(await backupsAvailable())) {
    body.append(para("Backups aren't available in this browser (private mode or storage blocked).", "ch-note warn"));
    return;
  }
  const now = btn(
    "Back up now",
    async () => {
      now.disabled = true;
      toast((await backupNow("Made by you")) ? "Backup saved" : "Couldn't save a backup");
      renderPanel();
    },
    "btn primary",
  );
  body.append(now, para(`Right now: ${describe(snapNow())}`, "ch-note"));
  const list = await listBackups();
  if (!list.length) {
    body.append(para("No backups yet — the first one is made automatically within a minute of opening the app."));
    return;
  }
  for (const b of list) body.append(backupRow(b));
  if (sync.isConnected())
    body.append(
      para("Also: every sync is kept as a version in your private GitHub repo (reel-feed-data → user-state.json → History).", "ch-note"),
    );
}

function snapNow() {
  return { saved: state.saved, hist: state.hist, seen: Object.keys(state.seen), affCh: state.affCh, hidden: state.hidden };
}

function backupRow(b: Backup) {
  const row = el("div", "bk-row");
  const txt = el("div", "bk-txt");
  txt.append(
    el("div", "bk-title", `${new Date(b.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${b.why}`),
    el("div", "ch-note", describe(b.data)),
  );
  const restore = btn("Restore", async () => {
    const ok = await confirmDialog({
      title: "Restore this backup?",
      body: `Everything goes back to how it was on ${new Date(b.at).toLocaleString()}: ${describe(b.data)}. This applies on all your devices. Your current data is backed up first, so you can switch back.`,
      confirm: "Restore",
    });
    if (!ok) return;
    await restoreBackup(b);
    toast("Restored — your data is back as it was then");
    renderPanel();
  });
  row.append(txt, restore);
  return row;
}
