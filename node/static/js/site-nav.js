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
  const VER = '7';

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

  function fallbackNav(devHome) {
    const links = devHome
      ? '<a href="/privacy">Privacy</a>' +
        '<a href="/security">Security</a>' +
        '<a href="/docs/api">API</a>' +
        '<a href="/docs/node">Run Node</a>'
      : '<a href="/#features">Features</a>' +
        '<a href="/#how">How it works</a>' +
        '<a href="/security">Security</a>' +
        '<a href="/docs/api">API</a>' +
        '<a href="/docs/node">Run Node</a>';
    return (
      '<nav class="ft-site-nav" aria-label="Primary">' +
      '<a href="/" class="nav-logo"><span class="frog">🐸</span>FrogTalk</a>' +
      '<div class="nav-links">' +
      links +
      '<a href="/app" class="btn btn-primary">Open App</a>' +
      '</div>' +
      '</nav>'
    );
  }

  function scrollHomeHash() {
    const onHome = location.pathname === '/' || location.pathname === '';
    if (!onHome || !location.hash || location.hash.length < 2) return;
    const id = location.hash.slice(1);
    const run = () => {
      const el = document.getElementById(id);
      if (!el) return;
      // Always land the section's top just below the fixed nav (the offset is
      // handled by `scroll-padding-top` in site-nav.css), so headings like
      // "100% Open Source" sit at the top of the viewport, never mid-section.
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    run();
    requestAnimationFrame(run);
    setTimeout(run, 120);
    setTimeout(run, 400);
  }

  async function loadNav() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    ensureStyles();

    const devHome = document.body.classList.contains('home-node-dev');
    const partialPath = String(
      mount.getAttribute('data-ft-nav-partial') || '/static/partials/site-nav.html'
    ).trim() || '/static/partials/site-nav.html';

    let html = '';
    try {
      const res = await fetch(assetUrl(partialPath), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('site-nav partial ' + res.status);
      html = await res.text();
    } catch (e) {
      console.warn('[site-nav] load failed, using fallback', e);
      html = fallbackNav(devHome);
    }

    mount.outerHTML = html;
    const nav = document.querySelector('body > .ft-site-nav, body > nav.ft-site-nav');
    if (!nav) return;
    fixHomeAnchors(nav);
    markCurrentLink(nav);
    document.body.classList.add('ft-has-site-nav');
    scrollHomeHash();
  }

  window.addEventListener('hashchange', scrollHomeHash);
  window.addEventListener('load', scrollHomeHash);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadNav);
  } else {
    loadNav();
  }
})();
