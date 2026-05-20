/**
 * Discord-style floating format bar when text is selected in #msg-input.
 * Inserts [b][/b] style tags — rendered securely by TextFormat on display.
 */
(function () {
  const TAGS = ['b', 'i', 'u', 's', 'code'];
  let bar = null;
  let mirror = null;
  let hideTimer = null;
  let boundTa = null;

  const MIRROR_STYLE_PROPS = [
    'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'fontSizeAdjust', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing', 'tabSize',
    'whiteSpace', 'wordBreak', 'wordWrap',
  ];

  function escText(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>\n');
  }

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'format-toolbar';
    bar.className = 'format-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Text formatting');
    bar.setAttribute('aria-hidden', 'true');
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

  function ensureMirror() {
    if (mirror) return mirror;
    mirror = document.createElement('div');
    mirror.id = 'format-toolbar-mirror';
    mirror.className = 'format-toolbar-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    document.body.appendChild(mirror);
    return mirror;
  }

  function syncMirrorStyles(ta, el) {
    const cs = window.getComputedStyle(ta);
    const rect = ta.getBoundingClientRect();
    el.style.position = 'fixed';
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
    el.style.top = `${rect.top}px`;
    el.style.left = `${rect.left}px`;
    el.style.zIndex = '-1';
    el.style.overflow = 'hidden';
    el.style.height = `${rect.height}px`;
    MIRROR_STYLE_PROPS.forEach((prop) => {
      try { el.style[prop] = cs[prop]; } catch {}
    });
    el.style.width = `${ta.clientWidth}px`;
  }

  function caretRect(ta, index) {
    const m = ensureMirror();
    syncMirrorStyles(ta, m);
    const val = ta.value || '';
    m.innerHTML =
      escText(val.slice(0, index)) +
      '<span class="format-toolbar-caret">\u200b</span>' +
      escText(val.slice(index));
    m.scrollTop = ta.scrollTop;
    const marker = m.querySelector('.format-toolbar-caret');
    return marker ? marker.getBoundingClientRect() : null;
  }

  /** Viewport rect spanning the selected range (mirror-div technique). */
  function getSelectionRect(ta, start, end) {
    if (!ta || start == null || end == null || start === end) return null;
    const a = caretRect(ta, start);
    const b = caretRect(ta, end);
    if (!a || !b) return null;
    const left = Math.min(a.left, b.left);
    const right = Math.max(a.right, b.right);
    const top = Math.min(a.top, b.top);
    const bottom = Math.max(a.bottom, b.bottom);
    return { top, left, right, bottom, width: right - left, height: bottom - top };
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function setBarVisible(visible) {
    const el = ensureBar();
    el.classList.toggle('is-visible', !!visible);
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
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
      // Keep the formatted text selected so the user can keep typing or re-wrap.
      ta.setSelectionRange(start + open.length, start + open.length + sel.length);
    }
    ta.focus();
    try { if (typeof autoResize === 'function') autoResize(ta); } catch {}
    try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    positionBar();
  }

  function positionBar() {
    const ta = getInput();
    const el = ensureBar();
    if (!ta || ta.hidden || ta.disabled) {
      setBarVisible(false);
      return;
    }
    const taBox = ta.getBoundingClientRect();
    if (taBox.width < 1 || taBox.height < 1) {
      setBarVisible(false);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start == null || end == null || start === end) {
      setBarVisible(false);
      return;
    }

    const selRect = getSelectionRect(ta, start, end);
    if (!selRect) {
      setBarVisible(false);
      return;
    }

    setBarVisible(true);
    requestAnimationFrame(() => {
      if (!bar?.classList.contains('is-visible')) return;
      const pad = 8;
      const centerX = selRect.left + selRect.width / 2;
      let top = selRect.top - el.offsetHeight - pad;
      if (top < pad) top = selRect.bottom + pad;
      el.style.left = `${clamp(centerX - el.offsetWidth / 2, pad, window.innerWidth - el.offsetWidth - pad)}px`;
      el.style.top = `${clamp(top, pad, window.innerHeight - el.offsetHeight - pad)}px`;
    });
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const ta = getInput();
      if (!ta || ta.selectionStart === ta.selectionEnd) setBarVisible(false);
    }, 120);
  }

  function onReposition() {
    if (!bar || !bar.classList.contains('is-visible')) return;
    requestAnimationFrame(positionBar);
  }

  function bind() {
    const ta = getInput();
    if (!ta) return;
    if (boundTa === ta) return;
    if (boundTa && boundTa !== ta) {
      try { boundTa.dataset.fmtToolbarBound = ''; } catch {}
    }
    if (ta.dataset.fmtToolbarBound === '1') {
      boundTa = ta;
      return;
    }
    ta.dataset.fmtToolbarBound = '1';
    boundTa = ta;
    ['select', 'mouseup', 'keyup', 'scroll', 'input'].forEach((ev) => {
      ta.addEventListener(ev, () => {
        clearTimeout(hideTimer);
        requestAnimationFrame(positionBar);
      });
    });
    ta.addEventListener('blur', scheduleHide);
    window.addEventListener('resize', onReposition, { passive: true });
    const scrollRoot = document.getElementById('messages-area');
    if (scrollRoot) scrollRoot.addEventListener('scroll', onReposition, { passive: true });
    document.addEventListener('mousedown', (e) => {
      if (!bar || !bar.classList.contains('is-visible')) return;
      if (e.target === ta || bar.contains(e.target)) return;
      setBarVisible(false);
    });
  }

  function init() {
    ensureBar();
    setBarVisible(false);
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.FormatToolbar = { wrapTag, positionBar, bind };
})();
