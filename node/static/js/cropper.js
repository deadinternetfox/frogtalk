/**
 * cropper.js — Lightweight, dependency-free image cropper.
 *
 * Usage:
 *   ImageCropper.open({
 *     file:    <File> | null,
 *     dataUrl: <string> | null,   // either file or dataUrl
 *     aspect:  1,                  // 1 = square, 16/9, 3/1 (banner), etc. null = free
 *     maxSize: 1024,               // output max dimension
 *     circle:  false,              // mask preview as circle (avatars)
 *     onCrop:  (dataUrl) => { ... }
 *   });
 */
(function () {
  let _state = null;

  function open (opts) {
    _state = {
      aspect: opts.aspect ?? null,
      maxSize: opts.maxSize || 1024,
      circle: !!opts.circle,
      onCrop: opts.onCrop || function () {},
      img: null,
      // Crop rect in image-space (natural pixels)
      cx: 0, cy: 0, cw: 0, ch: 0,
      drag: null,
    };

    _ensureModal();
    const modal = document.getElementById('img-crop-modal');
    modal.style.display = 'flex';

    if (opts.dataUrl) _loadImage(opts.dataUrl);
    else if (opts.file) _readFileToDataUrl(opts.file).then(_loadImage).catch(err => {
      console.error('[cropper] file read failed', err);
      _notify('Could not read image. Try a different photo.');
      close();
    });
  }

  // iOS Safari / WKWebView sometimes throws "Can't find variable: FileReader"
  // when FileReader is referenced inside a Promise/closure. Prefer the modern
  // Blob.arrayBuffer() path (used everywhere else in the app via UI.blobToDataURL)
  // and only fall back to FileReader if it's actually available.
  async function _readFileToDataUrl (file) {
    if (window.UI && typeof window.UI.blobToDataURL === 'function') {
      return window.UI.blobToDataURL(file);
    }
    if (file && typeof file.arrayBuffer === 'function') {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const CHUNK = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const mime = file.type || 'image/jpeg';
      return `data:${mime};base64,${btoa(binary)}`;
    }
    return await new Promise((resolve, reject) => {
      const FR = (typeof FileReader !== 'undefined') ? FileReader : (window && window.FileReader);
      if (!FR) return reject(new Error('No FileReader available'));
      const r = new FR();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('FileReader failed'));
      r.readAsDataURL(file);
    });
  }

  function _notify (msg) {
    try {
      if (window.UI && typeof window.UI.showToast === 'function') return window.UI.showToast(msg, 'error');
    } catch {}
    try { alert(msg); } catch {}
  }

  function close () {
    const m = document.getElementById('img-crop-modal');
    if (m) m.style.display = 'none';
    _state = null;
  }

  function _ensureModal () {
    if (document.getElementById('img-crop-modal')) return;
    const m = document.createElement('div');
    m.id = 'img-crop-modal';
    // Use 100dvh (dynamic viewport) so iOS Safari's bottom toolbar doesn't
    // push the Done button out of the visible area. Fallback to 100vh on
    // browsers that don't support dvh.
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:10000;display:none;align-items:center;justify-content:center;padding:10px;height:100vh;height:100dvh';
    m.innerHTML = `
      <div style="background:#111;border:1px solid #2a2a2a;border-radius:12px;max-width:560px;width:100%;max-height:94vh;max-height:94dvh;display:flex;flex-direction:column">
        <div style="padding:10px 14px;border-bottom:1px solid #222;display:flex;align-items:center;justify-content:space-between">
          <strong style="color:#4caf50">✂️ Crop image</strong>
          <button onclick="ImageCropper.close()" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer">✕</button>
        </div>
        <div id="ic-stage" style="position:relative;background:#000;overflow:hidden;flex:1;min-height:220px;display:flex;align-items:center;justify-content:center;touch-action:none">
          <canvas id="ic-canvas" style="max-width:100%;max-height:60vh;max-height:60dvh;display:block;cursor:move;touch-action:none;-webkit-user-select:none;user-select:none"></canvas>
        </div>
        <div style="padding:10px 14px;border-top:1px solid #222;display:flex;gap:8px;align-items:center">
          <label style="color:#888;font-size:12px">Zoom</label>
          <input type="range" id="ic-zoom" min="50" max="300" value="100" style="flex:1">
          <button onclick="ImageCropper.close()" style="background:#1e1e1e;border:1px solid #333;color:#e0e0e0;padding:8px 14px;border-radius:8px;cursor:pointer">Cancel</button>
          <button onclick="ImageCropper.apply()" style="background:#4caf50;border:0;color:#000;font-weight:700;padding:8px 18px;border-radius:8px;cursor:pointer">Done</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    const canvas = m.querySelector('#ic-canvas');
    const zoom   = m.querySelector('#ic-zoom');

    zoom.oninput = () => {
      if (!_state || !_state.img) return;
      const factor = zoom.value / 100;
      // Re-centre: keep current centre, scale crop w/h inversely to zoom.
      const cx = _state.cx + _state.cw / 2;
      const cy = _state.cy + _state.ch / 2;
      const baseW = _state._baseCw;
      const baseH = _state._baseCh;
      const nw = Math.max(20, baseW / factor);
      const nh = Math.max(20, baseH / factor);
      _state.cw = Math.min(nw, _state.img.naturalWidth);
      _state.ch = Math.min(nh, _state.img.naturalHeight);
      _state.cx = Math.max(0, Math.min(cx - _state.cw / 2, _state.img.naturalWidth - _state.cw));
      _state.cy = Math.max(0, Math.min(cy - _state.ch / 2, _state.img.naturalHeight - _state.ch));
      _draw();
    };

    // Drag to pan crop rect
    let dragging = false, last = { x: 0, y: 0 };
    const onDown = e => {
      if (!_state || !_state.img) return;
      dragging = true;
      const p = _pt(e);
      last = p;
      e.preventDefault();
    };
    const onMove = e => {
      if (!dragging || !_state) return;
      const p = _pt(e);
      const dx = (p.x - last.x) / _state._displayScale;
      const dy = (p.y - last.y) / _state._displayScale;
      last = p;
      _state.cx = Math.max(0, Math.min(_state.cx - dx, _state.img.naturalWidth - _state.cw));
      _state.cy = Math.max(0, Math.min(_state.cy - dy, _state.img.naturalHeight - _state.ch));
      _draw();
      e.preventDefault();
    };
    const onUp = () => { dragging = false; };

    // Bind touch events directly on the canvas (not window) so iOS Safari
    // reliably routes preventDefault on the originating element. mousemove/
    // mouseup still go on window so desktop drag-outside-then-release works.
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onUp);
    canvas.addEventListener('touchcancel', onUp);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function _pt (e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function _loadImage (src) {
    const img = new Image();
    img.onload = () => {
      _state.img = img;
      // Initial crop rect: largest centered rect matching aspect
      const nw = img.naturalWidth, nh = img.naturalHeight;
      let cw, ch;
      if (_state.aspect) {
        if (nw / nh > _state.aspect) { ch = nh; cw = nh * _state.aspect; }
        else { cw = nw; ch = nw / _state.aspect; }
      } else {
        cw = nw; ch = nh;
      }
      _state.cw = cw; _state.ch = ch;
      _state._baseCw = cw; _state._baseCh = ch;
      _state.cx = (nw - cw) / 2;
      _state.cy = (nh - ch) / 2;
      const zoom = document.getElementById('ic-zoom');
      if (zoom) zoom.value = 100;
      _draw();
    };
    img.onerror = () => {
      _notify('Could not load image. HEIC photos may need to be exported as JPEG.');
      close();
    };
    img.src = src;
  }

  function _draw () {
    if (!_state || !_state.img) return;
    const canvas = document.getElementById('ic-canvas');
    const stage  = document.getElementById('ic-stage');
    const ctx = canvas.getContext('2d');
    const img = _state.img;

    // Fit the full image into the stage area while preserving aspect
    const stageW = Math.min(stage.clientWidth  - 20, 540);
    const stageH = Math.min(stage.clientHeight - 20, window.innerHeight * 0.62);
    const scale = Math.min(stageW / img.naturalWidth, stageH / img.naturalHeight);
    const dw = Math.max(1, img.naturalWidth  * scale);
    const dh = Math.max(1, img.naturalHeight * scale);
    canvas.width  = dw;
    canvas.height = dh;
    _state._displayScale = scale;

    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(img, 0, 0, dw, dh);

    // Dim outside crop rect
    const rx = _state.cx * scale;
    const ry = _state.cy * scale;
    const rw = _state.cw * scale;
    const rh = _state.ch * scale;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, dw, dh);
    if (_state.circle) {
      const cx = rx + rw / 2, cy = ry + rh / 2;
      const rad = Math.min(rw, rh) / 2;
      ctx.arc(cx, cy, rad, 0, Math.PI * 2, true);
    } else {
      ctx.rect(rx + rw, ry, -rw, rh);
    }
    ctx.fill('evenodd');
    ctx.restore();

    // Border
    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 2;
    if (_state.circle) {
      const cx = rx + rw / 2, cy = ry + rh / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(rw, rh) / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(rx, ry, rw, rh);
    }
  }

  function apply () {
    if (!_state || !_state.img) { close(); return; }
    const { img, cx, cy, cw, ch, maxSize } = _state;
    const scale = Math.min(1, maxSize / Math.max(cw, ch));
    const outW = Math.max(1, Math.round(cw * scale));
    const outH = Math.max(1, Math.round(ch * scale));
    const c = document.createElement('canvas');
    c.width = outW; c.height = outH;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, cx, cy, cw, ch, 0, 0, outW, outH);
    const quality = 0.9;
    const dataUrl = c.toDataURL('image/jpeg', quality);
    try { _state.onCrop(dataUrl); } catch (e) { console.error(e); }
    close();
  }

  window.ImageCropper = { open, close, apply };
})();
