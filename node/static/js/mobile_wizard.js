/**
 * mobile_wizard.js — Polished in-app startup wizard for the Android WebView shell.
 * Replaces native AlertDialog permission intros; system prompts still fire on Allow.
 */
const MobileWizard = (() => {
  const STEP_IDS = ['intro', 'notifications', 'media', 'battery', 'done'];
  let _step = 0;
  let _running = null;
  let _nativeWait = null;

  function _android() {
    try { return window.Android || null; } catch { return null; }
  }

  function shouldShow() {
    const a = _android();
    if (!a || typeof a.isPermissionsWizardDone !== 'function') return false;
    try { return !a.isPermissionsWizardDone(); } catch { return false; }
  }

  function _status() {
    const a = _android();
    if (!a || typeof a.getPermissionsWizardStatus !== 'function') {
      return { notifications: true, microphone: true, camera: true, battery: true };
    }
    try {
      const raw = a.getPermissionsWizardStatus();
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        notifications: !!parsed?.notifications,
        microphone: !!parsed?.microphone,
        camera: !!parsed?.camera,
        battery: !!parsed?.battery,
      };
    } catch {
      return { notifications: false, microphone: false, camera: false, battery: false };
    }
  }

  function _el(id) {
    return document.getElementById(id);
  }

  function _showOverlay() {
    const root = _el('ft-mobile-setup-wizard');
    if (!root) return;
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('ft-msw-active');
  }

  function _hideOverlay() {
    const root = _el('ft-mobile-setup-wizard');
    if (!root) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('ft-msw-active');
  }

  function _setStep(idx) {
    _step = Math.max(0, Math.min(STEP_IDS.length - 1, idx));
    const id = STEP_IDS[_step];
    STEP_IDS.forEach((sid, i) => {
      const dot = _el(`ft-msw-dot-${sid}`);
      if (dot) dot.classList.toggle('on', i <= _step);
      const panel = _el(`ft-msw-panel-${sid}`);
      if (panel) panel.classList.toggle('active', sid === id);
    });
    const st = _status();
    const chip = (key, label) => {
      const on = !!st[key];
      return `<span class="ft-msw-chip ${on ? 'on' : ''}">${on ? '✓' : '○'} ${label}</span>`;
    };
    const summary = _el('ft-msw-status-chips');
    if (summary) {
      if (id === 'intro' || id === 'done') {
        summary.style.display = 'none';
      } else {
        summary.style.display = '';
      }
    }
    if (summary && id !== 'intro' && id !== 'done') {
      summary.innerHTML = [
        chip('notifications', 'Alerts'),
        chip('microphone', 'Mic'),
        chip('camera', 'Camera'),
        chip('battery', 'Battery'),
      ].join('');
    }
  }

  function _waitNative(step) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        if (_nativeWait && _nativeWait.step === step) {
          _nativeWait = null;
          resolve();
        }
      }, 120_000);
      _nativeWait = {
        step,
        resolve: () => {
          clearTimeout(t);
          _nativeWait = null;
          resolve();
        },
      };
    });
  }

  function _advanceAfterStep(step) {
    const idx = STEP_IDS.indexOf(step);
    if (idx >= 0 && _step === idx && idx < STEP_IDS.length - 1) {
      _setStep(idx + 1);
    } else {
      _setStep(_step);
    }
  }

  function _onNativeStepDone(step) {
    if (_nativeWait && _nativeWait.step === step) {
      try { _nativeWait.resolve(); } catch {}
    }
    _advanceAfterStep(step);
  }

  async function _invokeNative(step) {
    const a = _android();
    if (!a) return;
    const waitP = _waitNative(step);
    try {
      if (step === 'notifications' && typeof a.requestWizardNotifications === 'function') {
        a.requestWizardNotifications();
      } else if (step === 'media' && typeof a.requestWizardMedia === 'function') {
        a.requestWizardMedia();
      } else if (step === 'battery' && typeof a.requestWizardBattery === 'function') {
        a.requestWizardBattery();
      } else {
        _onNativeStepDone(step);
        return;
      }
    } catch (e) {
      console.warn('[MobileWizard] native step failed', step, e);
      _onNativeStepDone(step);
      return;
    }
    await waitP;
  }

  function _finish(skipped) {
    const a = _android();
    try {
      if (a && typeof a.markPermissionsWizardDone === 'function') {
        a.markPermissionsWizardDone();
      }
    } catch {}
    try {
      localStorage.setItem('ft_permissions_wizard_done', '1');
    } catch {}
    _hideOverlay();
    if (_running) {
      const r = _running;
      _running = null;
      r.resolve(!skipped);
    }
  }

  function _bindControls() {
    const root = _el('ft-mobile-setup-wizard');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';

    root.querySelector('[data-ft-msw="continue"]')?.addEventListener('click', () => {
      if (_step < STEP_IDS.length - 1) _setStep(_step + 1);
    });
    root.querySelector('[data-ft-msw="skip-step"]')?.addEventListener('click', () => {
      if (_step < STEP_IDS.length - 1) _setStep(_step + 1);
    });
    root.querySelector('[data-ft-msw="not-now"]')?.addEventListener('click', () => _finish(true));
    root.querySelector('[data-ft-msw="allow-notifications"]')?.addEventListener('click', () => {
      void _invokeNative('notifications');
    });
    root.querySelector('[data-ft-msw="allow-media"]')?.addEventListener('click', () => {
      void _invokeNative('media');
    });
    root.querySelector('[data-ft-msw="allow-battery"]')?.addEventListener('click', () => {
      void _invokeNative('battery');
    });
    root.querySelector('[data-ft-msw="done"]')?.addEventListener('click', () => _finish(false));
  }

  function run() {
    if (!shouldShow()) return Promise.resolve(false);
    if (_running) return _running.promise;
    _bindControls();
    _step = 0;
    _setStep(0);
    _showOverlay();
    const promise = new Promise((resolve) => { _running = { resolve, promise: null }; });
    _running.promise = promise;
    return promise;
  }

  return {
    shouldShow,
    run,
    _onNativeStepDone,
  };
})();

try { window.MobileWizard = MobileWizard; } catch {}
