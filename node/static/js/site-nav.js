/**
 * Shared FrogTalk marketing-site navigation.
 *
 * Static pages include:
 *   <div id="ft-site-nav-mount"></div>
 *   <script src="/static/js/site-nav.js?v=1" defer></script>
 *
 * HTML lives in /static/partials/site-nav.html.
 */
(function () {
  'use strict';

  const MOUNT_ID = 'ft-site-nav-mount';
  const VER = '3';

  function assetUrl(path) {
    const base = path + '?v=' + VER;
    try {
      const tag = document.querySelector('script[src*="site-nav.js"]');
      const src = tag && tag.getAttribute('src');
      if (src && src.includes('?v=')) {
        return path + src.slice(src.indexOf('?v='));
      }
    } catch {}
    return base;
  }

  function ensureStyles() {
    if (document.querySelector('link[data-ft-site-nav]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = assetUrl('/static/css/site-nav.css');
    link.setAttribute('data-ft-site-nav', '');
    document.head.appendChild(link);
  }

  function normalizePath(path) {
    return (path || '').replace(/\/+$/, '') || '/';
  }

  function markCurrentLink(nav) {
    const current = normalizePath(location.pathname);
    nav.querySelectorAll('.nav-links a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      const target = normalizePath(href.split('#')[0]);
      const isCurrent = target !== '/' && target === current;
      if (isCurrent) a.setAttribute('aria-current', 'page');
    });
  }

  function fixHomeAnchors(nav) {
    const onHome = location.pathname === '/' || location.pathname === '';
    nav.querySelectorAll('[data-ft-anchor]').forEach((a) => {
      const id = a.getAttribute('data-ft-anchor');
      if (!id) return;
      a.setAttribute('href', onHome ? '#' + id : '/#' + id);
    });
  }

  function fallbackNav() {
    return (
      '<nav class="ft-site-nav" aria-label="Primary">' +
      '<a href="/" class="nav-logo"><span class="frog">🐸</span>FrogTalk</a>' +
      '<div class="nav-links">' +
      '<a href="/#features">Features</a>' +
      '<a href="/security">Security</a>' +
      '<a href="/docs/api">API</a>' +
      '<a href="/docs/node">Run Node</a>' +
      '<a href="/app" class="btn btn-primary">Open App</a>' +
      '</div>' +
      '</nav>'
    );
  }

  async function loadNav() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    ensureStyles();

    let html = '';
    try {
      const res = await fetch(assetUrl('/static/partials/site-nav.html'), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('site-nav partial ' + res.status);
      html = await res.text();
    } catch (e) {
      console.warn('[site-nav] load failed, using fallback', e);
      html = fallbackNav();
    }

    mount.outerHTML = html;
    const nav = document.querySelector('body > .ft-site-nav, body > nav.ft-site-nav');
    if (!nav) return;
    fixHomeAnchors(nav);
    markCurrentLink(nav);
    document.body.classList.add('ft-has-site-nav');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadNav);
  } else {
    loadNav();
  }
})();
