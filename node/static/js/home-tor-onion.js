/**
 * Tor homepage: show onion URL from /api/network/status when available (public).
 */
(function () {
  var el = document.getElementById('tor-onion-host');
  if (!el) return;

  function setHost(url) {
    if (!url || typeof url !== 'string') return;
    var u = url.replace(/\/$/, '');
    if (u.indexOf('.onion') === -1) return;
    el.textContent = u;
    el.closest('.tor-onion-panel')?.querySelector('a.primary')?.setAttribute('href', u + '/app');
  }

  fetch('/api/network/status', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      var local = data.local || data.self || data;
      var onion = (local.onion_url || local.onion || '').trim();
      if (onion) setHost(onion);
    })
    .catch(function () {});

  if (location.hostname && location.hostname.endsWith('.onion')) {
    setHost(location.protocol + '//' + location.hostname);
  }
})();
