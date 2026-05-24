/**
 * ft_site.js — Node public URL helpers (share links, invite/vanity UI).
 * Bootstrapped from GET /api/ping on app load.
 */
(function (global) {
  'use strict';

  const LEGACY_HOSTS = new Set([
    'frogtalk.xyz', 'www.frogtalk.xyz', 'frogtalk.app', 'www.frogtalk.app',
  ]);

  function normOrigin(url) {
    const raw = String(url || '').trim().replace(/\/$/, '');
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) return '';
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`;
    } catch {
      return '';
    }
  }

  function readCached() {
    try {
      const raw = localStorage.getItem('ft_site_public_url') || '';
      return normOrigin(raw);
    } catch {
      return '';
    }
  }

  function writeCache(publicUrl, publicHost) {
    try {
      if (publicUrl) localStorage.setItem('ft_site_public_url', publicUrl);
      if (publicHost) localStorage.setItem('ft_site_public_host', publicHost);
    } catch {}
  }

  function ftPublicOrigin() {
    const fromBoot = normOrigin(global.FT_SITE && global.FT_SITE.publicUrl);
    if (fromBoot) return fromBoot;
    const cached = readCached();
    if (cached) return cached;
    try {
      const o = String(global.location && global.location.origin || '').trim();
      if (/^https?:\/\//i.test(o)) return o.replace(/\/$/, '');
    } catch {}
    return 'https://frogtalk.xyz';
  }

  function ftPublicHost() {
    const fromBoot = String((global.FT_SITE && global.FT_SITE.publicHost) || '').trim().toLowerCase();
    if (fromBoot) return fromBoot;
    try {
      const cached = (localStorage.getItem('ft_site_public_host') || '').trim().toLowerCase();
      if (cached) return cached;
    } catch {}
    try {
      return (new URL(ftPublicOrigin())).hostname.toLowerCase();
    } catch {
      return String(global.location && global.location.hostname || 'frogtalk.xyz').toLowerCase();
    }
  }

  function ftInviteUrl(code) {
    const c = String(code || '').trim();
    if (!c) return '';
    return `${ftPublicOrigin()}/i/${encodeURIComponent(c)}`;
  }

  function ftIsFrogHost(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (LEGACY_HOSTS.has(host)) return true;
    if (host.endsWith('.frogtalk.xyz') || host.endsWith('.frogtalk.app')) return true;
    const local = ftPublicHost();
    if (local && (host === local || host.endsWith('.' + local))) return true;
    return false;
  }

  function ftIsInviteUrl(url) {
    const u = String(url || '').trim();
    if (!u) return false;
    try {
      const parsed = new URL(u, ftPublicOrigin());
      if (!ftIsFrogHost(parsed.hostname)) return false;
      return /^\/(?:invite|i)\/[A-Za-z0-9_-]{2,32}\/?$/i.test(parsed.pathname || '');
    } catch {
      return false;
    }
  }

  function ftApplyVanityPrefixUi() {
    const host = ftPublicHost();
    const prefix = host + '/i/';
    document.querySelectorAll('[data-ft-vanity-prefix]').forEach(el => {
      el.textContent = prefix;
    });
    document.querySelectorAll('[data-ft-profile-url-hint]').forEach(el => {
      el.textContent = host + '/u/you';
    });
  }

  async function ftSiteBootstrap() {
    try {
      const res = await fetch('/api/ping?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const publicUrl = normOrigin(data.public_url);
      const publicHost = String(data.public_host || '').trim().toLowerCase();
      if (publicUrl) {
        global.FT_SITE = {
          publicUrl,
          publicHost: publicHost || (function () {
            try { return new URL(publicUrl).hostname; } catch { return ''; }
          })(),
          officialHubUrl: normOrigin(data.official_hub_url) || 'https://frogtalk.xyz',
        };
        writeCache(publicUrl, global.FT_SITE.publicHost);
      }
    } catch {}
    ftApplyVanityPrefixUi();
  }

  global.ftPublicOrigin = ftPublicOrigin;
  global.ftPublicHost = ftPublicHost;
  global.ftInviteUrl = ftInviteUrl;
  global.ftIsFrogHost = ftIsFrogHost;
  global.ftIsInviteUrl = ftIsInviteUrl;
  global.ftSiteBootstrap = ftSiteBootstrap;
  global.ftApplyVanityPrefixUi = ftApplyVanityPrefixUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { ftSiteBootstrap(); });
  } else {
    ftSiteBootstrap();
  }
})(typeof window !== 'undefined' ? window : globalThis);
