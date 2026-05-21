/**
 * FrogTalk download picker — platform dropdown with server-side availability.
 * Mount: <div data-ft-downloads-root></div> + this script (and downloads-picker.css).
 */
(function () {
  'use strict';

  const ORDER_DEFAULT = ['android', 'ios', 'web', 'windows', 'windows-zip', 'linux', 'deb'];
  const ORDER_MOBILE = ['android', 'ios', 'web', 'windows', 'windows-zip', 'linux', 'deb'];
  const ORDER_WINDOWS = ['windows', 'windows-zip', 'web', 'android', 'linux', 'deb', 'ios'];
  const ORDER_LINUX = ['linux', 'deb', 'web', 'android', 'windows', 'windows-zip', 'ios'];

  function formatBytes(n) {
    const b = Number(n) || 0;
    if (b <= 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function detectPreferredId() {
    const ua = navigator.userAgent || '';
    const narrow = typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 768px)').matches;
    if (/Android/i.test(ua) || (narrow && !/iPhone|iPad|iPod/i.test(ua))) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Win/i.test(ua)) return 'windows';
    if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'linux';
    if (narrow) return 'android';
    return 'web';
  }

  function sortOrder() {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua) || (typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 768px)').matches)) {
      return ORDER_MOBILE;
    }
    if (/Win/i.test(ua)) return ORDER_WINDOWS;
    if (/Linux/i.test(ua)) return ORDER_LINUX;
    return ORDER_DEFAULT;
  }

  function sortPlatforms(platforms) {
    const rank = {};
    sortOrder().forEach((id, i) => { rank[id] = i; });
    return platforms.slice().sort((a, b) => {
      const ra = rank[a.id] ?? 99;
      const rb = rank[b.id] ?? 99;
      if (ra !== rb) return ra - rb;
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }

  function optionLabel(p) {
    const fmt = p.format ? ' · ' + p.format : '';
    const file = p.filename ? ' — ' + p.filename : '';
    const size = p.available && p.size_bytes ? ' (' + formatBytes(p.size_bytes) + ')' : '';
    const off = p.available ? '' : ' — not on this server';
    return (p.icon ? p.icon + ' ' : '') + p.label + fmt + file + size + off;
  }

  function actionLabel(p) {
    if (!p.available) return 'Unavailable';
    if (p.id === 'web') return 'Open in browser';
    if (p.id === 'ios') return 'Get iOS build';
    return 'Download';
  }

  function mount(root) {
    root.innerHTML =
      '<div class="ft-dl-loading" aria-live="polite">Loading available builds…</div>';

    fetch('/api/downloads/catalog', { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error('catalog ' + r.status);
        return r.json();
      })
      .then((data) => {
        const platforms = sortPlatforms(data.platforms || []);
        const available = platforms.filter((p) => p.available);
        const preferred = detectPreferredId();
        let selected = available.find((p) => p.id === preferred)
          || available[0]
          || platforms[0];

        root.innerHTML =
          '<div class="ft-dl-card">' +
            '<div class="ft-dl-card-glow" aria-hidden="true"></div>' +
            '<div class="ft-dl-card-inner">' +
              '<div class="ft-dl-head">' +
                '<span class="ft-dl-kicker">Download</span>' +
                '<h2>Get FrogTalk for your device</h2>' +
                '<p>Choose a platform below. Only builds hosted on this server appear as ready to download.</p>' +
              '</div>' +
              '<div class="ft-dl-controls">' +
                '<label class="ft-dl-label" for="ft-dl-select">Platform</label>' +
                '<div class="ft-dl-select-wrap">' +
                  '<select id="ft-dl-select" class="ft-dl-select" aria-describedby="ft-dl-meta"></select>' +
                '</div>' +
                '<div class="ft-dl-meta" id="ft-dl-meta"></div>' +
                '<button type="button" class="btn btn-primary btn-lg ft-dl-go" id="ft-dl-go">Download</button>' +
              '</div>' +
              '<div class="ft-dl-foot">' +
                '<div class="ft-dl-chips" id="ft-dl-chips"></div>' +
                '<a href="' + (data.github_releases || 'https://github.com/deadinternetfox/frogtalk/releases/latest') +
                  '" target="_blank" rel="noopener noreferrer">All releases on GitHub →</a>' +
              '</div>' +
            '</div>' +
          '</div>';

        const sel = document.getElementById('ft-dl-select');
        const meta = document.getElementById('ft-dl-meta');
        const go = document.getElementById('ft-dl-go');
        const chips = document.getElementById('ft-dl-chips');

        platforms.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = optionLabel(p);
          opt.disabled = !p.available;
          if (p.id === selected.id) opt.selected = true;
          sel.appendChild(opt);
        });

        platforms.forEach((p) => {
          const span = document.createElement('span');
          span.className = 'ft-dl-chip' + (p.available ? '' : ' off');
          span.textContent = (p.icon || '') + ' ' + p.label.split(' ')[0];
          span.title = p.available ? (p.format || 'Ready') : 'Not on this server';
          chips.appendChild(span);
        });

        const preferredId = detectPreferredId();

        function refresh() {
          const id = sel.value;
          const p = platforms.find((x) => x.id === id) || selected;
          selected = p;
          const rec = (p.id === preferredId && p.available)
            ? '<span><strong>Recommended for your device</strong> · </span>'
            : '';
          if (p.available && p.size_bytes) {
            meta.innerHTML = rec + '<span><strong>' + formatBytes(p.size_bytes) + '</strong> · ' +
              (p.filename ? p.filename : p.format) + '</span>';
          } else if (p.available) {
            meta.innerHTML = rec + '<span>' + (p.format || 'Ready on this server') + '</span>';
          } else {
            meta.innerHTML = '<span class="ft-dl-unavailable">Not available on this server — try GitHub releases</span>';
          }
          go.textContent = actionLabel(p);
          go.disabled = !p.available;
        }

        function trigger() {
          const p = platforms.find((x) => x.id === sel.value);
          if (!p || !p.available) return;
          if (p.id === 'web') {
            window.location.href = p.url;
            return;
          }
          if (p.open_in_new_tab) {
            window.open(p.url, '_blank', 'noopener,noreferrer');
            return;
          }
          const a = document.createElement('a');
          a.href = p.url;
          a.rel = 'noopener';
          if (p.id !== 'ios') a.setAttribute('download', '');
          document.body.appendChild(a);
          a.click();
          a.remove();
        }

        sel.addEventListener('change', refresh);
        go.addEventListener('click', trigger);
        refresh();
      })
      .catch((e) => {
        console.warn('[downloads-picker]', e);
        root.innerHTML =
          '<div class="ft-dl-card"><div class="ft-dl-card-inner">' +
          '<p class="ft-dl-error">Could not load download list. Try direct links:</p>' +
          '<p style="margin-top:0.75rem"><a href="/download/android">Android</a> · ' +
          '<a href="/download/linux">Linux</a> · <a href="/download/windows">Windows</a> · ' +
          '<a href="/app">Web app</a></p></div></div>';
      });
  }

  function init() {
    document.querySelectorAll('[data-ft-downloads-root]').forEach(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
