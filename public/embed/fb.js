/*
 * A bare page that shows one Facebook reel in Facebook's own embedded player, from this site's
 * address: /embed/fb.html?id=REEL_ID. The browser extension frames it in its side panel (Facebook's
 * player is happy to sit in a page from this site, but not directly in an extension page).
 * Nothing else happens here.
 */
(() => {
  const id = new URLSearchParams(location.search).get("id") || "";
  if (!/^\d{5,25}$/.test(id)) {
    document.body.append(Object.assign(document.createElement("p"), { textContent: "No reel to show." }));
    return;
  }
  const f = document.createElement("iframe");
  const href = `https://www.facebook.com/reel/${id}/`;
  f.src = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(href)}&show_text=false&autoplay=true&width=${Math.max(220, Math.min(500, innerWidth))}`;
  f.title = "Facebook reel";
  f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  f.allowFullscreen = true;
  document.body.append(f);
})();
