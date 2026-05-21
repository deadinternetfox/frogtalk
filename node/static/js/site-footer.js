/**
 * Shared FrogTalk marketing-site footer.
 *
 * Static pages include:
 *   <div id="ft-site-footer-mount"></div>
 *   <script src="/static/js/site-footer.js?v=1" defer></script>
 *
 * HTML lives in /static/partials/site-footer.html — edit once, all pages update.
 */
(function () {
  'use strict';

  const MOUNT_ID = 'ft-site-footer-mount';
  const VER = '6';

  function assetUrl(path) {
    const base = path + '?v=' + VER;
    try {
      const tag = document.querySelector('script[src*="site-footer.js"]');
      const src = tag && tag.getAttribute('src');
      if (src && src.includes('?v=')) {
        return path + src.slice(src.indexOf('?v='));
      }
    } catch {}
    return base;
  }

  function ensureStyles() {
    if (document.querySelector('link[data-ft-site-footer]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = assetUrl('/static/css/site-footer.css');
    link.setAttribute('data-ft-site-footer', '');
    document.head.appendChild(link);
  }

  function fixHomeAnchors(mount) {
    const onHome = location.pathname === '/' || location.pathname === '';
    mount.querySelectorAll('[data-ft-anchor]').forEach((a) => {
      const id = a.getAttribute('data-ft-anchor');
      if (!id) return;
      a.setAttribute('href', onHome ? '#' + id : '/#' + id);
    });
  }

  function fallbackFooter() {
    return (
      '<footer class="ft-site-footer">' +
      '<div class="ft-footer-brand">' +
      '<span class="ft-footer-brand-mark" aria-hidden="true">🐸</span>' +
      '<span class="ft-footer-brand-name">FrogTalk</span>' +
      '<span class="ft-footer-tagline">Chat, Post, Vibe Together</span>' +
      '</div>' +
      '<p class="ft-footer-copy"><span class="ft-copyleft" title="Copyleft — open source">©</span> 2026 FrogTalk. Your chat, your privacy.</p>' +
      '</footer>'
    );
  }

  async function loadFooter() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    ensureStyles();

    try {
      const res = await fetch(assetUrl('/static/partials/site-footer.html'), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('footer partial ' + res.status);
      mount.innerHTML = await res.text();
    } catch (e) {
      console.warn('[site-footer] load failed, using fallback', e);
      mount.innerHTML = fallbackFooter();
    }

    fixHomeAnchors(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadFooter);
  } else {
    loadFooter();
  }
})();
