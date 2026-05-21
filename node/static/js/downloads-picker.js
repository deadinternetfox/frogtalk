/**
 * FrogTalk download picker — platform dropdown with server + GitHub mirror fallback.
 * Mount: <div data-ft-downloads-root></div> + downloads-picker.css
 */
(function () {
  'use strict';

  const ORDER_DEFAULT = ['android', 'ios', 'web', 'windows', 'windows-zip', 'linux', 'deb'];
  const ORDER_MOBILE = ['android', 'ios', 'web', 'windows', 'windows-zip', 'linux', 'deb'];
  const ORDER_WINDOWS = ['windows', 'windows-zip', 'web', 'android', 'linux', 'deb', 'ios'];
  const ORDER_LINUX = ['linux', 'deb', 'web', 'android', 'windows', 'windows-zip', 'ios'];

  const SOURCE_LABEL = {
    node: 'Hosted on this server',
    mirror: 'Served from build mirror on this node',
    github: 'GitHub release (mirror backup)',
    none: '',
  };

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

  function canDownload(p) {
    if (p.available) return true;
    return !!(p.mirror_url && String(p.mirror_url).startsWith('http'));
  }

  function optionLabel(p) {
    const fmt = p.format ? ' · ' + p.format : '';
    const file = p.filename ? ' — ' + p.filename : '';
    const size = p.available && p.size_bytes ? ' (' + formatBytes(p.size_bytes) + ')' : '';
    let badge = '';
    if (p.source === 'mirror') badge = ' · mirror';
    else if (p.source === 'github') badge = ' · GitHub';
    const off = canDownload(p) ? '' : ' — use GitHub releases';
    return (p.icon ? p.icon + ' ' : '') + p.label + fmt + file + size + badge + off;
  }

  function actionLabel(p) {
    if (!canDownload(p)) return 'See GitHub releases';
    if (p.id === 'web') return 'Open in browser';
    if (p.id === 'ios') return 'Get iOS build';
    if (p.source === 'github') return 'Download from GitHub';
    return 'Download';
  }

  function downloadUrl(p) {
    if (p.available && p.url) return p.url;
    if (p.mirror_url) return p.mirror_url;
    return p.url || '';
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
        const downloadable = platforms.filter(canDownload);
        const preferred = detectPreferredId();
        let selected = downloadable.find((p) => p.id === preferred)
          || downloadable[0]
          || platforms[0];
        const ghReleases = data.github_releases
          || 'https://github.com/deadinternetfox/frogtalk/releases/latest';

        root.innerHTML =
          '<div class="ft-dl-card">' +
            '<div class="ft-dl-card-glow" aria-hidden="true"></div>' +
            '<div class="ft-dl-card-inner">' +
              '<div class="ft-dl-head">' +
                '<span class="ft-dl-kicker">Download</span>' +
                '<h2>Get FrogTalk for your device</h2>' +
                '<p>We serve builds from this node when present. Missing desktop or APK files fall back to the ' +
                '<strong>GitHub build mirror</strong> so you can still install.</p>' +
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
                '<p class="ft-dl-mirror-note" id="ft-dl-mirror-note"></p>' +
                '<a class="ft-dl-gh-link" href="' + ghReleases +
                  '" target="_blank" rel="noopener noreferrer">All releases on GitHub →</a>' +
              '</div>' +
            '</div>' +
          '</div>';

        const sel = document.getElementById('ft-dl-select');
        const meta = document.getElementById('ft-dl-meta');
        const go = document.getElementById('ft-dl-go');
        const chips = document.getElementById('ft-dl-chips');
        const mirrorNote = document.getElementById('ft-dl-mirror-note');

        platforms.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = optionLabel(p);
          opt.disabled = !canDownload(p);
          if (p.id === selected.id) opt.selected = true;
          sel.appendChild(opt);
        });

        platforms.forEach((p) => {
          const span = document.createElement('span');
          const on = canDownload(p);
          span.className = 'ft-dl-chip' + (on ? '' : ' off');
          if (p.source === 'mirror') span.classList.add('mirror');
          if (p.source === 'github') span.classList.add('github');
          span.textContent = (p.icon || '') + ' ' + p.label.split(' ')[0];
          span.title = on
            ? (SOURCE_LABEL[p.source] || p.format || 'Ready')
            : 'Not on this server — GitHub mirror';
          chips.appendChild(span);
        });

        const preferredId = detectPreferredId();
        const anyMirror = platforms.some((p) => p.source === 'mirror' || p.source === 'github');
        if (mirrorNote) {
          mirrorNote.textContent = anyMirror
            ? 'Some files are served from the on-node build mirror or linked GitHub release assets.'
            : 'All listed builds are hosted directly on this server.';
        }

        function refresh() {
          const id = sel.value;
          const p = platforms.find((x) => x.id === id) || selected;
          selected = p;
          const rec = (p.id === preferredId && canDownload(p))
            ? '<span><strong>Recommended for your device</strong> · </span>'
            : '';
          const src = SOURCE_LABEL[p.source] || '';
          if (canDownload(p) && p.size_bytes) {
            meta.innerHTML = rec + '<span><strong>' + formatBytes(p.size_bytes) + '</strong> · ' +
              (p.filename ? p.filename : p.format) +
              (src ? ' · <em>' + src + '</em>' : '') + '</span>';
          } else if (canDownload(p)) {
            meta.innerHTML = rec + '<span>' + (src || p.format || 'Ready') + '</span>';
          } else {
            meta.innerHTML = '<span class="ft-dl-unavailable">Not on this server — ' +
              '<a href="' + ghReleases + '" target="_blank" rel="noopener noreferrer">open GitHub releases</a></span>';
          }
          go.textContent = actionLabel(p);
          go.disabled = !canDownload(p);
        }

        function trigger() {
          const p = platforms.find((x) => x.id === sel.value);
          if (!p || !canDownload(p)) {
            window.open(ghReleases, '_blank', 'noopener,noreferrer');
            return;
          }
          const url = downloadUrl(p);
          if (!url) return;
          if (p.id === 'web') {
            window.location.href = url;
            return;
          }
          if (p.open_in_new_tab || url.startsWith('http')) {
            window.open(url, '_blank', 'noopener,noreferrer');
            return;
          }
          const a = document.createElement('a');
          a.href = url;
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
          '<p class="ft-dl-error">Could not load download list. Try direct links or GitHub:</p>' +
          '<p style="margin-top:0.75rem"><a href="/download/android">Android</a> · ' +
          '<a href="/download/linux">Linux</a> · <a href="/download/windows">Windows</a> · ' +
          '<a href="/app">Web app</a> · ' +
          '<a href="https://github.com/deadinternetfox/frogtalk/releases/latest" target="_blank" rel="noopener">GitHub releases</a></p></div></div>';
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
