/* FrogTalk — /security */
(function () {
  const form   = document.getElementById('bug-form');
  const btn    = document.getElementById('bf-submit');
  const status = document.getElementById('form-status');

  if (!form) return;

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    status.className = '';
    status.textContent = '';

    const title    = document.getElementById('bf-title').value.trim();
    const body     = document.getElementById('bf-body').value.trim();
    const severity = document.getElementById('bf-severity').value;
    const category = document.getElementById('bf-category').value;
    const contact  = document.getElementById('bf-contact').value.trim();

    if (title.length < 3 || body.length < 10) {
      status.className = 'err';
      status.textContent = 'Please fill in a title (3+ chars) and details (10+ chars).';
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Sending…';

    // Reuse the user's session token if they happen to be logged in — keeps
    // reports tied to the account so the admin queue can see "filed by X".
    // Anonymous (no token) is fully supported by the API.
    const headers = { 'Content-Type': 'application/json' };
    try {
      const tok = localStorage.getItem('session_token');
      if (tok) headers['X-Session-Token'] = tok;
    } catch (_) { /* ignore storage errors */ }

    try {
      const resp = await fetch('/api/bug-reports', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ title, body, severity, category, contact })
      });
      const data = await resp.json().catch(function () { return {}; });
      if (resp.ok && data.ok) {
        status.className = 'ok';
        status.textContent = 'Thanks — report #' + data.id + ' received. We\'ll look at it.';
        form.reset();
      } else {
        status.className = 'err';
        status.textContent = (data && data.error) || ('Submit failed (HTTP ' + resp.status + ').');
      }
    } catch (err) {
      status.className = 'err';
      status.textContent = 'Network error: ' + (err && err.message ? err.message : err);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
})();

(function () {
  document.querySelectorAll('[data-hof-toggle]').forEach(function (btn) {
    var targetId = 'hof-' + btn.getAttribute('data-hof-toggle');
    var panel = document.getElementById(targetId);
    if (!panel) return;
    btn.addEventListener('click', function () {
      var open = panel.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      btn.textContent = open ? 'Hide details' : 'Show what they found';
    });
  });
})();
