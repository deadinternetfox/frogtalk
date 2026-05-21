/* FrogTalk — /ios */
(() => {
  const canonicalUrl = "https://frogtalk.xyz/ios";
  const pageUrl = encodeURIComponent(canonicalUrl);
  const pageText = encodeURIComponent("FrogTalk for iPhone is coming soon. Official launch page:");
  const buttons = [
    ["X", `https://twitter.com/intent/tweet?text=${pageText}&url=${pageUrl}`],
    ["Telegram", `https://t.me/share/url?url=${pageUrl}&text=${pageText}`],
    ["Reddit", `https://www.reddit.com/submit?url=${pageUrl}&title=${pageText}`],
    ["WhatsApp", `https://wa.me/?text=${pageText}%20${pageUrl}`],
    ["Facebook", `https://www.facebook.com/sharer/sharer.php?u=${pageUrl}`]
  ];
  const row = document.getElementById("share-row");
  for (const [label, href] of buttons) {
    const a = document.createElement("a");
    a.className = "share-btn";
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    row.appendChild(a);
  }

  const copy = document.createElement("button");
  copy.className = "share-btn";
  copy.type = "button";
  copy.textContent = "Copy Link";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(canonicalUrl);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy Link"; }, 1200);
    } catch {
      copy.textContent = "Copy failed";
      setTimeout(() => { copy.textContent = "Copy Link"; }, 1200);
    }
  });
  row.appendChild(copy);
})();
