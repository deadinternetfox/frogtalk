/* FrogTalk – Context-aware screenshot guard
 *
 * Screenshots are *allowed* by default everywhere (public/community rooms
 * are screenshot-friendly by design – memes, shareability, etc.). The OS-
 * level block is only turned on when the user is currently inside a
 * surface that the user explicitly chose to keep private:
 *
 *   • Any DM channel (always private to two people)
 *   • A room whose type is "private"   (room.type === 'private')
 *   • Any DM that has disappearing messages enabled
 *   • Any conversation that contains a still-unconsumed view-once item
 *     currently on screen
 *
 * The guard polls the well-known globals exposed by app.js / dms.js /
 * rooms.js (`_activeDM`, `_currentRoomData`, `_dmExpireSeconds`) every
 * 750ms; that's cheap and means we don't have to bolt callbacks into a
 * dozen call sites or risk a missed transition. When the desired state
 * changes we forward exactly one IPC / JS-bridge call to the host.
 *
 * Hosts:
 *   • Electron     – window.electronAPI.setBlockScreenshots(bool)
 *                    → main.js → BrowserWindow.setContentProtection()
 *   • Android      – window.Android.setBlockScreenshots(bool)
 *                    → MainActivity → FLAG_SECURE on/off
 *   • Plain browser – no-op (browsers can't block native screenshots).
 */
(function () {
  'use strict';

  var _last = null;           // last value we successfully pushed to host
  var _timer = null;

  function _hasElectron () {
    try { return !!(window.electronAPI && typeof window.electronAPI.setBlockScreenshots === 'function'); }
    catch (_) { return false; }
  }
  function _hasAndroid () {
    try { return !!(window.Android && typeof window.Android.setBlockScreenshots === 'function'); }
    catch (_) { return false; }
  }
  function _hostSupported () { return _hasElectron() || _hasAndroid(); }

  /** Decide whether screenshots should currently be blocked. */
  function _shouldBlock () {
    // DM open? — always block.
    try {
      if (typeof _activeDM !== 'undefined' && _activeDM && _activeDM.id) {
        return true;
      }
    } catch (_) { /* _activeDM not yet defined */ }

    // Private room open? — block. Public/community rooms are fine.
    try {
      if (typeof _currentRoomData !== 'undefined'
          && _currentRoomData
          && _currentRoomData.room
          && _currentRoomData.room.type === 'private') {
        return true;
      }
    } catch (_) { /* _currentRoomData not yet defined */ }

    // Visible view-once / disappearing media still on screen — block.
    // Disappearing-channel indicator (the ⏱️ pill in the room header)
    // is also a "screenshots feel hostile" signal.
    try {
      var doc = document;
      if (doc && doc.querySelector) {
        if (doc.querySelector('.view-once-media:not(.consumed), .ft-viewonce-active')) {
          return true;
        }
        var disappearBadge = doc.getElementById('dm-disappear-indicator')
                          || doc.getElementById('room-disappear-indicator');
        if (disappearBadge && disappearBadge.offsetParent !== null) {
          return true;
        }
      }
    } catch (_) {}

    return false;
  }

  function _push (next) {
    if (next === _last) return;
    _last = next;
    try {
      if (_hasElectron()) {
        window.electronAPI.setBlockScreenshots(!!next);
      }
      if (_hasAndroid()) {
        window.Android.setBlockScreenshots(!!next);
      }
    } catch (e) {
      // Never let a host bridge bug break the renderer.
      try { console.warn('[ScreenshotGuard] push failed:', e); } catch (_) {}
    }
  }

  function _tick () {
    try { _push(_shouldBlock()); } catch (_) {}
  }

  function init () {
    if (_timer) return;
    if (!_hostSupported()) return;        // browser: nothing to do
    // Start in the "allowed" state so the user can screenshot the login
    // screen, room directory, etc. without flicker.
    _push(false);
    _timer = setInterval(_tick, 750);
    // Re-evaluate immediately on focus/visibility change so the user
    // doesn't have to wait up to 750 ms after Alt-Tabbing back in.
    try {
      document.addEventListener('visibilitychange', _tick, false);
      window.addEventListener('focus', _tick, false);
    } catch (_) {}
  }

  /** Force an immediate re-check (call sites can invoke this when they
   *  know the relevant state just changed, to skip the 750 ms latency). */
  function refresh () { _tick(); }

  window.ScreenshotGuard = {
    init: init,
    refresh: refresh,
    _shouldBlock: _shouldBlock,    // exposed for tests / debugging only
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
