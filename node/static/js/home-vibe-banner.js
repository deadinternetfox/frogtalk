/* FrogTalk — home vibe banner */
(function () {
  try {
    var KEY = 'frogtalk_vibe_banner_dismissed_v3';
    var banner = document.getElementById('vibe-banner');
    if (!banner) return;
    var dismissed = false;
    try { dismissed = localStorage.getItem(KEY) === '1'; } catch (_) {}
    if (dismissed) return;

    banner.hidden = false;

    function applyOffset() {
      document.body.style.paddingBottom = banner.offsetHeight + 'px';
    }
    function clearOffset() {
      document.body.style.paddingBottom = '';
    }
    applyOffset();
    window.addEventListener('resize', applyOffset);

    document.getElementById('vibe-banner-close').addEventListener('click', function () {
      try { localStorage.setItem(KEY, '1'); } catch (_) {}
      banner.style.display = 'none';
      clearOffset();
      window.removeEventListener('resize', applyOffset);
    });
  } catch (_) { /* never let the banner break the page */ }
})();
