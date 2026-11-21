/** Online/offline and slow-connection handling (data saver, offline banner, catching up when back online). */
import { checkForUpdate } from "./data";
import { toast } from "./ui";
import { banner } from "./view";
import { computeDataSaver, playback, pool, poolSize } from "./player";
import { latestVersion, offerData } from "./feed";

let lastNetMsg = "";
let saverToldThisSession = false;

export function applyNetwork(userChanged = false) {
  const was = playback.dataSaver;
  playback.dataSaver = computeDataSaver();
  pool.resize(poolSize());
  if (!navigator.onLine) {
    banner("📴 You're offline — videos need a connection. History, saved and lists still work.");
    lastNetMsg = "offline";
    return;
  }
  if (lastNetMsg === "offline") {
    banner(null);
    lastNetMsg = "";
    checkForUpdate(latestVersion(), offerData);
  }
  if (playback.dataSaver && !was && !userChanged && !saverToldThisSession) {
    saverToldThisSession = true;
    toast("Slow connection — data saver on (smaller images, less preloading)");
  }
}
