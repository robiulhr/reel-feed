/* Runs before the page draws: when the app will open on Home, keep the Shorts feed's bars out of sight until it has started. */
try {
  var p = location.pathname;
  if ((p === "/" || p === "/home") && localStorage.getItem("rf.openOn") !== "feed") document.documentElement.classList.add("boot-home");
} catch (e) {}
