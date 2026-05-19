/**
 * Discord-style floating format bar when text is selected in #msg-input.
 * Inserts [b][/b] style tags — rendered securely by TextFormat on display.
 */
(function () {
  const TAGS = ['b', 'i', 'u', 's', 'code'];
  let bar = null;
  let hideTimer = null;

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'format-toolbar';
    bar.className = 'format-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Text formatting');
    bar.hidden = true;
    const labels = { b: 'Bold', i: 'Italic', u: 'Underline', s: 'Strikethrough', code: 'Code' };
    const glyphs = { b: 'B', i: 'I', u: 'U', s: 'S', code: '</>' };
    TAGS.forEach((tag) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'format-toolbar-btn';
      btn.dataset.fmt = tag;
      btn.title = labels[tag];
      btn.setAttribute('aria-label', labels[tag]);
      btn.textContent = glyphs[tag];
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        wrapTag(tag);
      });
      bar.appendChild(btn);
    });
    document.body.appendChild(bar);
    return bar;
  }

  function getInput() {
    return document.getElementById('msg-input');
  }

  function wrapTag(tag) {
    const ta = getInput();
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value || '';
    const open = `[${tag}]`;
    const close = `[/${tag}]`;
    if (start == null || end == null) return;
    if (start === end) {
      ta.value = val.slice(0, start) + open + close + val.slice(end);
      const pos = start + open.length;
      ta.setSelectionRange(pos, pos);
    } else {
      const sel = val.slice(start, end);
      ta.value = val.slice(0, start) + open + sel + close + val.slice(end);
      ta.setSelectionRange(start, start + open.length + sel.length + close.length);
    }
    ta.focus();
    try { if (typeof autoResize === 'function') autoResize(ta); } catch {}
    positionBar();
  }

  function positionBar() {
    const ta = getInput();
    const el = ensureBar();
    if (!ta || ta.hidden || ta.disabled) {
      el.hidden = true;
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start == null || end == null || start === end) {
      el.hidden = true;
      return;
    }
    // Approximate toolbar position above the textarea (textarea lacks
    // per-character rects without a mirror div — good enough UX).
    const rect = ta.getBoundingClientRect();
    el.style.left = `${Math.max(8, rect.left + rect.width / 2 - el.offsetWidth / 2)}px`;
    el.style.top = `${Math.max(8, rect.top - el.offsetHeight - 8)}px`;
    el.hidden = false;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const ta = getInput();
      if (!ta || ta.selectionStart === ta.selectionEnd) {
        if (bar) bar.hidden = true;
      }
    }, 120);
  }

  function bind() {
    const ta = getInput();
    if (!ta || ta.dataset.fmtToolbarBound === '1') return;
    ta.dataset.fmtToolbarBound = '1';
    ['select', 'mouseup', 'keyup'].forEach((ev) => {
      ta.addEventListener(ev, () => {
        clearTimeout(hideTimer);
        requestAnimationFrame(positionBar);
      });
    });
    ta.addEventListener('blur', scheduleHide);
    document.addEventListener('mousedown', (e) => {
      if (!bar || bar.hidden) return;
      if (e.target === ta || bar.contains(e.target)) return;
      bar.hidden = true;
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.FormatToolbar = { wrapTag, positionBar };
})();
