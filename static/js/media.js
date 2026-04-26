/* ─── media.js ─────────────────────────────────────────────────────────────── */
'use strict';

let _mediaRec    = null;   // MediaRecorder
let _mediaChunks = [];
let _isRecording = false;
let _recTimer    = null;
let _recSeconds  = 0;
let _audioCtx    = null;
let _analyser    = null;
let _animFrame   = null;
let _recMode     = 'voice'; // 'voice' or 'video'
let _previewStream = null;

/* ── Voice-message recording toggle ─────────────────────────────────────────── */
async function toggleVoiceRecord () {
  if (document.body.classList.contains('in-music-channel')) {
    if (typeof toast === 'function') toast('Voice notes are disabled in music channels', 'info');
    return;
  }
  if (_isRecording && _recMode === 'voice') {
    stopRecording();
  } else if (_isRecording && _recMode === 'video') {
    stopRecording();
    startVoiceRecord();
  } else {
    startVoiceRecord();
  }
}

/* ── Video-note recording toggle ─────────────────────────────────────────────── */
async function toggleVideoRecord () {
  if (document.body.classList.contains('in-music-channel')) {
    if (typeof toast === 'function') toast('Video notes are disabled in music channels', 'info');
    return;
  }
  if (_isRecording && _recMode === 'video') {
    stopRecording();
  } else if (_isRecording && _recMode === 'voice') {
    stopRecording();
    startVideoRecord();
  } else {
    startVideoRecord();
  }
}

async function startVoiceRecord () {
  try {
    _recMode = 'voice';
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _mediaRec    = new MediaRecorder(stream, { mimeType: getSupportedAudioMime() });
    _mediaChunks = [];
    _isRecording = true;

    _mediaRec.ondataavailable = e => { if (e.data.size) _mediaChunks.push(e.data); };
    _mediaRec.onstop          = finaliseVoiceMemo;
    _mediaRec.start(200); // collect in 200ms chunks

    // UI
    const btn = document.getElementById('voice-rec-btn');
    btn.textContent   = '⏹️';
    btn.style.color   = '#f85149';
    btn.title         = 'Stop recording';
    
    const videoBtn = document.getElementById('video-rec-btn');
    if (videoBtn) videoBtn.style.opacity = '0.4';

    // Show waveform preview in attachment area
    showRecordingUI(stream);

    _recSeconds = 0;
    _recTimer   = setInterval(() => {
      _recSeconds++;
      const el = document.getElementById('rec-duration');
      if (el) el.textContent = formatRecDuration(_recSeconds);
      if (_recSeconds >= 300) stopRecording(); // max 5 min
    }, 1000);
  } catch (e) {
    toast('Microphone permission denied', 'error');
  }
}

/* ── Video note recording ─────────────────────────────────────────────────────── */
async function startVideoRecord () {
  try {
    _recMode = 'video';
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: true, 
      video: { width: { ideal: 480 }, height: { ideal: 480 }, facingMode: 'user' } 
    });
    _previewStream = stream;
    
    const mimeType = getSupportedVideoMime();
    _mediaRec    = new MediaRecorder(stream, { mimeType });
    _mediaChunks = [];
    _isRecording = true;

    _mediaRec.ondataavailable = e => { if (e.data.size) _mediaChunks.push(e.data); };
    _mediaRec.onstop          = finaliseVideoNote;
    _mediaRec.start(200);

    // UI
    const btn = document.getElementById('video-rec-btn');
    btn.textContent   = '⏹️';
    btn.style.color   = '#f85149';
    btn.title         = 'Stop recording';
    
    const voiceBtn = document.getElementById('voice-rec-btn');
    if (voiceBtn) voiceBtn.style.opacity = '0.4';

    // Show video preview
    showVideoPreview(stream);

    _recSeconds = 0;
    _recTimer   = setInterval(() => {
      _recSeconds++;
      const el = document.getElementById('rec-duration');
      if (el) el.textContent = formatRecDuration(_recSeconds);
      if (_recSeconds >= 60) stopRecording(); // max 1 min for video notes
    }, 1000);
  } catch (e) {
    console.error('Video record error:', e);
    if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
      toast('No camera/microphone device found', 'error');
    } else {
      toast('Camera/Microphone permission denied', 'error');
    }
  }
}

function showVideoPreview (stream) {
  const prev  = document.getElementById('attachment-preview');
  const thumb = document.getElementById('attachment-thumb');
  prev.style.display = 'flex';

  // Circular live preview. The duration pill sits INSIDE the wrapper (not
  // absolutely positioned below the thumb, which used to hang into the
  // textarea on narrow desktop windows).
  thumb.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div style="position:relative;width:64px;height:64px;flex:0 0 64px">
        <video id="video-preview" autoplay muted playsinline
          style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid #f85149;display:block"></video>
      </div>
      <span id="rec-duration" style="font-size:12px;color:#f85149;font-weight:700;white-space:nowrap">● REC 0:00</span>
    </div>`;

  const video = document.getElementById('video-preview');
  video.srcObject = stream;
}

function stopRecording () {
  if (!_isRecording || !_mediaRec) return;
  _isRecording = false;
  _mediaRec.stop();
  _mediaRec.stream.getTracks().forEach(t => t.stop());
  if (_previewStream) {
    _previewStream.getTracks().forEach(t => t.stop());
    _previewStream = null;
  }

  clearInterval(_recTimer); _recTimer = null;

  // Reset buttons
  const voiceBtn = document.getElementById('voice-rec-btn');
  voiceBtn.textContent = '🎙️';
  voiceBtn.style.color = '';
  voiceBtn.title       = 'Voice note';
  voiceBtn.style.opacity = '1';
  
  const videoBtn = document.getElementById('video-rec-btn');
  if (videoBtn) {
    videoBtn.textContent = '📹';
    videoBtn.style.color = '';
    videoBtn.title       = 'Video note';
    videoBtn.style.opacity = '1';
  }

  cancelAnimationFrame(_animFrame);
  if (_audioCtx) { try { _audioCtx.close(); } catch {} _audioCtx = null; }
}

// Keep old function name for compatibility
function stopVoiceRecord() { stopRecording(); }

function finaliseVoiceMemo () {
  const mime = getSupportedAudioMime();
  const ext  = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(_mediaChunks, { type: mime });

  // Put into pending attachment (same slot as file attachment)
  window._pendingAttachment = {
    blob,
    name: `voice-${Date.now()}.${ext}`,
    type: mime,
    isVoice: true,
  };

  // Show preview
  const url   = URL.createObjectURL(blob);
  const thumb = document.getElementById('attachment-thumb');
  const prev  = document.getElementById('attachment-preview');
  thumb.innerHTML = `<audio src="${url}" controls style="width:180px;vertical-align:middle"></audio>
    <span style="font-size:12px;color:#85a89a;margin-left:6px">Voice note · ${formatRecDuration(_recSeconds).replace('● REC ', '')}</span>`;
  prev.style.display = 'flex';
}

function finaliseVideoNote () {
  const mime = getSupportedVideoMime();
  const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(_mediaChunks, { type: mime });

  // Put into pending attachment
  window._pendingAttachment = {
    blob,
    name: `video-${Date.now()}.${ext}`,
    type: mime,
    isVideo: true,
  };

  // Show preview with video thumbnail
  const url   = URL.createObjectURL(blob);
  const thumb = document.getElementById('attachment-thumb');
  const prev  = document.getElementById('attachment-preview');
  thumb.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">
      <video src="${url}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:2px solid #4caf50"></video>
      <span style="font-size:12px;color:#85a89a">Video note · ${formatRecDuration(_recSeconds).replace('● REC ', '')}</span>
    </div>`;
  prev.style.display = 'flex';
}

/* ── Waveform visualiser during recording ────────────────────────────────────── */
function showRecordingUI (stream) {
  try {
    _audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
    _analyser   = _audioCtx.createAnalyser();
    _analyser.fftSize = 64;
    const src   = _audioCtx.createMediaStreamSource(stream);
    src.connect(_analyser);

    const prev  = document.getElementById('attachment-preview');
    const thumb = document.getElementById('attachment-thumb');
    prev.style.display = 'flex';

    // Build the canvas
    let canvas = document.getElementById('rec-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'rec-canvas';
      canvas.width  = 120;
      canvas.height = 28;
      canvas.style.cssText = 'border-radius:8px;background:#0f1d18;vertical-align:middle';
    }
    thumb.innerHTML = '';
    thumb.appendChild(canvas);

    const dur = document.createElement('span');
    dur.id    = 'rec-duration';
    dur.style.cssText = 'font-size:12px;color:#f85149;margin-left:8px;font-weight:600';
    dur.textContent   = '● REC 0:00';
    thumb.appendChild(dur);

    const ctx = canvas.getContext('2d');
    const buf = new Uint8Array(_analyser.frequencyBinCount);

    function draw () {
      _animFrame = requestAnimationFrame(draw);
      _analyser.getByteFrequencyData(buf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bw = canvas.width / buf.length;
      buf.forEach((v, i) => {
        const h = (v / 255) * canvas.height;
        ctx.fillStyle = `hsl(${140 - v * .3},80%,50%)`;
        ctx.fillRect(i * bw, canvas.height - h, bw - 1, h);
      });
    }
    draw();
  } catch {}
}

/* ── File attachment handling ─────────────────────────────────────────────── */
function handleFileSelect (input) {
  const file = input.files?.[0];
  if (!file) return;
  addPendingAttachmentFile(file);
  input.value = '';
}

/* Reusable helper for any source (file picker, paste, camera). */
function addPendingAttachmentFile (file, opts = {}) {
  if (!file) return false;
  const mime = file.type || 'application/octet-stream';
  const name = opts.name || file.name || `attachment-${Date.now()}`;

  // Music channels: only images / GIFs are allowed to keep the DJ set clean.
  if (document.body.classList.contains('in-music-channel') && !mime.startsWith('image/')) {
    toast('Only pictures and GIFs are allowed in music channels', 'info');
    return false;
  }
  const MAX = 20 * 1024 * 1024;
  if ((file.size || 0) > MAX) {
    toast('File too large (max 20 MB)', 'error');
    return false;
  }

  window._pendingAttachment = { blob: file, name, type: mime };
  _renderAttachmentPreview({
    blob: file,
    name,
    type: mime,
    sizeBytes: file.size,
  });
  return true;
}

/* Shared attachment preview renderer. Produces:
   - image/video thumbnail with an eye-button overlay (spoiler toggle)
   - filename + size on a smaller line below
   - flag bar (View Once — DM only) stays underneath                       */
function _renderAttachmentPreview ({ blob, name, type, sizeBytes }) {
  const thumb = document.getElementById('attachment-thumb');
  const prev  = document.getElementById('attachment-preview');
  if (!thumb || !prev) return;
  prev.style.display = 'flex';

  const isImg = type && type.startsWith('image/');
  const isVid = type && type.startsWith('video/');
  const sub   = _fmtAttachSub(name, sizeBytes);
  const safeName = esc(name || '');

  const _inDM = typeof isDMView === 'function' && isDMView();
  const _voBtn = _inDM
    ? `<button type="button" class="att-viewonce-fire" title="View once — disappears after viewing"
                onclick="toggleMediaFlag('view_once')" aria-pressed="false">🔥</button>`
    : '';
  let mediaHtml = '';
  if (isImg) {
    const url = URL.createObjectURL(blob);
    mediaHtml = `<div class="att-media-wrap">
        <img src="${url}" alt="">
        <button type="button" class="att-spoiler-eye" title="Toggle spoiler (blur until tapped)"
                onclick="toggleMediaFlag('blur')" aria-pressed="false">👁️</button>
        ${_voBtn}
      </div>`;
  } else if (isVid) {
    const url = URL.createObjectURL(blob);
    mediaHtml = `<div class="att-media-wrap">
        <video src="${url}" muted playsinline preload="metadata"></video>
        <button type="button" class="att-spoiler-eye" title="Toggle spoiler (blur until tapped)"
                onclick="toggleMediaFlag('blur')" aria-pressed="false">👁️</button>
        ${_voBtn}
      </div>`;
  } else {
    const icon = /pdf/.test(type || '') ? '📕'
               : /audio/.test(type || '') ? '🎵'
               : /zip|rar|7z/.test(type || '') ? '🗜️'
               : '📄';
    mediaHtml = `<div class="att-preview-icon">${icon}</div>`;
  }

  thumb.innerHTML = `
    <div class="att-preview-item" id="att-preview-item">
      ${mediaHtml}
      <div class="att-preview-sub" title="${safeName}">${sub}</div>
    </div>`;

  // Fire button is always visible on images/videos (no DM-only restriction)
  // Hide the flag bar entirely — both buttons are now overlays on the image
  const flagBtns = document.getElementById('media-flag-btns');
  if (flagBtns) flagBtns.style.display = 'none';
  // Reset stale flags from previous attachment
  window._pendingMediaBlur = false;
  window._pendingViewOnce  = false;
  const item = document.getElementById('att-preview-item');
  if (item) item.classList.remove('is-spoiler');
  const eye = thumb.querySelector('.att-spoiler-eye');
  if (eye) { eye.classList.remove('active'); eye.setAttribute('aria-pressed', 'false'); }
}

function _fmtAttachSub (name, bytes) {
  const nm = esc(name || 'file');
  if (!bytes && bytes !== 0) return nm;
  const kb = bytes / 1024;
  const size = kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(kb)) + ' KB';
  return `${nm} <span style="color:#6a9a86">\u00b7</span> <span style="color:#85a89a">${size}</span>`;
}

function clearAttachment () {
  // If the user hits ✕ mid-recording, behave like Stop but discard the
  // captured audio/video instead of keeping it as a pending attachment.
  if (_isRecording && _mediaRec) {
    try { _mediaRec.onstop = null; } catch {}
    try { _mediaRec.stop(); } catch {}
    try { _mediaRec.stream.getTracks().forEach(t => t.stop()); } catch {}
    if (_previewStream) {
      try { _previewStream.getTracks().forEach(t => t.stop()); } catch {}
      _previewStream = null;
    }
    clearInterval(_recTimer); _recTimer = null;
    cancelAnimationFrame(_animFrame);
    if (_audioCtx) { try { _audioCtx.close(); } catch {} _audioCtx = null; }
    _isRecording = false;
    _mediaChunks = [];
    // Reset the two record buttons back to idle state.
    const voiceBtn = document.getElementById('voice-rec-btn');
    if (voiceBtn) {
      voiceBtn.textContent = '🎙️';
      voiceBtn.style.color = '';
      voiceBtn.title       = 'Voice note';
      voiceBtn.style.opacity = '1';
    }
    const videoBtn = document.getElementById('video-rec-btn');
    if (videoBtn) {
      videoBtn.textContent = '📹';
      videoBtn.style.color = '';
      videoBtn.title       = 'Video note';
      videoBtn.style.opacity = '1';
    }
  }
  window._pendingAttachment = null;
  document.getElementById('attachment-thumb').innerHTML = '';
  document.getElementById('attachment-preview').style.display = 'none';
  // Reset media flag toggles
  const flagBtns = document.getElementById('media-flag-btns');
  if (flagBtns) flagBtns.style.display = 'none';
  window._pendingMediaBlur = false;
  window._pendingViewOnce = false;
  document.getElementById('spoiler-toggle-btn')?.classList.remove('active');
  document.getElementById('viewonce-toggle-btn')?.classList.remove('active');
  // also clear reply
  if (typeof clearReplyToDM === 'function') clearReplyToDM();
}

function toggleMediaFlag(flag) {
  if (flag === 'blur') {
    window._pendingMediaBlur = !window._pendingMediaBlur;
    // Legacy hidden button kept for compatibility
    document.getElementById('spoiler-toggle-btn')?.classList.toggle('active', !!window._pendingMediaBlur);
    // Eye overlay on the image itself
    const eye = document.querySelector('#attachment-thumb .att-spoiler-eye');
    if (eye) {
      eye.classList.toggle('active', !!window._pendingMediaBlur);
      eye.setAttribute('aria-pressed', window._pendingMediaBlur ? 'true' : 'false');
    }
    // Blur the preview image so the sender sees what recipients will see
    const item = document.getElementById('att-preview-item');
    if (item) item.classList.toggle('is-spoiler', !!window._pendingMediaBlur);

    if (window._pendingMediaBlur) {
      window._pendingViewOnce = false;
      const fire = document.querySelector('#attachment-thumb .att-viewonce-fire');
      if (fire) { fire.classList.remove('active'); fire.setAttribute('aria-pressed', 'false'); }
    }
  } else {
    window._pendingViewOnce = !window._pendingViewOnce;
    // Fire overlay button on the image
    const fire = document.querySelector('#attachment-thumb .att-viewonce-fire');
    if (fire) {
      fire.classList.toggle('active', !!window._pendingViewOnce);
      fire.setAttribute('aria-pressed', window._pendingViewOnce ? 'true' : 'false');
    }
    document.getElementById('viewonce-toggle-btn')?.classList.toggle('active', !!window._pendingViewOnce);
    if (window._pendingViewOnce) {
      window._pendingMediaBlur = false;
      document.getElementById('spoiler-toggle-btn')?.classList.remove('active');
      const eye = document.querySelector('#attachment-thumb .att-spoiler-eye');
      if (eye) { eye.classList.remove('active'); eye.setAttribute('aria-pressed', 'false'); }
      const item = document.getElementById('att-preview-item');
      if (item) item.classList.remove('is-spoiler');
    }
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────────── */
function getSupportedAudioMime () {
  const candidates = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
  return candidates.find(m => MediaRecorder.isTypeSupported(m)) || 'audio/webm';
}

function getSupportedVideoMime () {
  const candidates = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
  return candidates.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

function formatRecDuration (s) {
  const m = Math.floor(s / 60);
  return `● REC ${m}:${(s % 60).toString().padStart(2,'0')}`;
}

/* ── Camera capture + filters (for channel/DM composer) ───────────────── */
const _camFilterPresets = {
  none:     { brightness: 100, contrast: 100, saturate: 100, sepia: 0, hue: 0 },
  warm:     { brightness: 105, contrast: 105, saturate: 130, sepia: 10, hue: 0 },
  cool:     { brightness: 100, contrast: 110, saturate: 80,  sepia: 0, hue: -10 },
  vintage:  { brightness: 110, contrast: 90,  saturate: 70,  sepia: 30, hue: 0 },
  dramatic: { brightness: 90,  contrast: 140, saturate: 110, sepia: 0, hue: 0 },
  fade:     { brightness: 115, contrast: 85,  saturate: 80,  sepia: 10, hue: 0 },
  bw:       { brightness: 105, contrast: 120, saturate: 0,   sepia: 0, hue: 0 },
};
let _camOrigDataUrl = null;
let _camFilter = { ..._camFilterPresets.none };

function _camFilterStr () {
  const f = _camFilter;
  return `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%) sepia(${f.sepia}%) hue-rotate(${f.hue}deg)`;
}

function openCameraCapture (onReady) {
  // onReady: optional callback(dataUrl) — if provided, Attach calls it instead of pending-attachment
  window._camOnReady = typeof onReady === 'function' ? onReady : null;
  // Create modal once
  let modal = document.getElementById('cam-capture-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'cam-capture-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(4px);z-index:9999;display:none;align-items:center;justify-content:center;padding:10px';
    modal.innerHTML = `
      <div style="background:linear-gradient(180deg,#12231d,#0f1d18);border:1px solid #2f5548;border-radius:12px;max-width:520px;width:100%;max-height:92vh;overflow:auto;display:flex;flex-direction:column;box-shadow:0 2px 12px rgba(0,0,0,.35)">
        <div style="padding:12px 14px;border-bottom:1px solid #222;display:flex;align-items:center;justify-content:space-between">
          <strong style="color:#4caf50">📷 Capture & Filter</strong>
          <button onclick="closeCameraCapture()" style="background:none;border:none;color:#85a89a;font-size:20px;cursor:pointer;transition:color .15s">✕</button>
        </div>
        <div id="cam-stage" style="padding:12px;display:flex;flex-direction:column;gap:10px;align-items:center">
          <div id="cam-empty" style="display:flex;flex-direction:column;gap:10px;align-items:center;padding:28px 0;width:100%">
            <div style="color:#85a89a;font-size:13px;text-align:center">Take a new photo or pick one from your gallery</div>
            <button onclick="_camOpenLiveCamera()" style="background:#4caf50;color:#000;border:0;padding:12px 20px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;width:100%;max-width:280px">📷 Take photo</button>
            <button onclick="document.getElementById('cam-input-gallery').click()" style="background:linear-gradient(180deg,#1a3a2d,#143027);color:#dff5e8;border:1px solid #2f5548;padding:10px 20px;border-radius:10px;font-size:14px;cursor:pointer;width:100%;max-width:280px;transition:background .15s">🖼️ Pick from gallery</button>
          </div>
          <img id="cam-preview" style="display:none;max-width:100%;max-height:52vh;border-radius:10px;background:#000">
          <div id="cam-filters" style="display:none;flex-wrap:wrap;gap:6px;justify-content:center;width:100%"></div>
          <div id="cam-sliders" style="display:none;flex-direction:column;gap:6px;width:100%;padding:0 6px;font-size:12px;color:#85a89a"></div>
          <div id="cam-actions" style="display:none;gap:8px;width:100%;padding:4px 0 2px">
            <button onclick="_camRetake()" style="flex:1;background:linear-gradient(180deg,#1a3a2d,#143027);color:#dff5e8;border:1px solid #2f5548;padding:10px;border-radius:8px;cursor:pointer;transition:background .15s">↺ Retake</button>
            <button onclick="_camAttach()" style="flex:2;background:#4caf50;color:#000;border:0;padding:10px;border-radius:8px;font-weight:700;cursor:pointer">✓ Attach</button>
          </div>
        </div>
        <input type="file" id="cam-input-gallery" accept="image/*" style="display:none" onchange="_camOnFile(this)">
      </div>`;
    document.body.appendChild(modal);
    // Build filter buttons
    const fs = modal.querySelector('#cam-filters');
    Object.keys(_camFilterPresets).forEach(key => {
      const b = document.createElement('button');
      b.className = 'cam-filter-btn';
      b.textContent = key === 'bw' ? 'B&W' : (key[0].toUpperCase() + key.slice(1));
      b.dataset.preset = key;
      b.style.cssText = 'background:linear-gradient(180deg,#1a3a2d,#143027);color:#dff5e8;border:1px solid #2f5548;padding:6px 10px;border-radius:14px;cursor:pointer;font-size:12px';
      b.onclick = () => _camApplyPreset(key);
      fs.appendChild(b);
    });
    // Build sliders
    const sl = modal.querySelector('#cam-sliders');
    [['brightness','Brightness',50,150],['contrast','Contrast',50,150],['saturate','Saturation',0,200]].forEach(([k,label,min,max]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px';
      row.innerHTML = `<span style="min-width:78px">${label}</span><input type="range" min="${min}" max="${max}" value="100" data-k="${k}" style="flex:1">`;
      row.querySelector('input').oninput = e => { _camFilter[e.target.dataset.k] = +e.target.value; _camRender(); };
      sl.appendChild(row);
    });
  }
  // Reset state
  _camOrigDataUrl = null;
  _camFilter = { ..._camFilterPresets.none };
  _camStopLiveCamera();
  modal.style.display = 'flex';
  modal.querySelector('#cam-empty').style.display = 'flex';
  modal.querySelector('#cam-preview').style.display = 'none';
  modal.querySelector('#cam-filters').style.display = 'none';
  modal.querySelector('#cam-sliders').style.display = 'none';
  modal.querySelector('#cam-actions').style.display = 'none';
  const liveView = document.getElementById('cam-live-view');
  if (liveView) liveView.style.display = 'none';
}

function closeCameraCapture () {
  const m = document.getElementById('cam-capture-modal');
  if (m) m.style.display = 'none';
  try { _camCloseVideoReview && _camCloseVideoReview(); } catch {}
  _camPendingVideo = null;
  _camStopLiveCamera();
}

/* ── Live camera capture inside the composer modal ──────────────────────
   Uses getUserMedia so it works reliably in Android WebView without relying
   on file-input `capture=` (which silently falls back to a gallery picker
   on some WebViews). The captured frame is fed into the existing filter
   preview so users can still tune filters AFTER snapping the photo.

   Extras (2026):
   - Pinch-to-zoom: uses MediaStreamTrack `zoom` constraint when the device
     supports it, otherwise falls back to a CSS transform on the <video>.
   - Hold-to-record: the shutter doubles as a video recorder — a short tap
     captures a photo, holding it for >250ms starts a video recording that
     stops on release. The resulting webm attaches directly to the composer.
*/
let _camLiveStream = null;
let _camLiveFacing = 'environment';
// Pinch-zoom state
let _camZoomCap    = null;   // { min, max, step } if hardware zoom supported
let _camZoomTrack  = null;   // MediaStreamTrack currently zoomed
let _camZoomVal    = 1;      // current zoom (in track units when hardware, else CSS scale)
let _camPinchStart = 0;
let _camZoomStart  = 1;
// Hold-to-record state
let _camHoldTimer  = null;
let _camRecorder   = null;
let _camRecChunks  = [];
let _camRecStart   = 0;
let _camRecTimerEl = null;
let _camRecInterval= null;
let _camIsRecording= false;
// Flash state. Two distinct modes depending on which camera is active:
//   • Rear camera ('environment') → drive the hardware LED via either the
//     native Android bridge or track.applyConstraints({torch}).
//   • Front camera ('user')       → no LED exists on the selfie side, so we
//     fire a full-screen white overlay to use the display as fill light.
let _camTorchSupported = false;   // rear-cam hardware LED available
let _camTorchViaBridge = false;
let _camTorchOn        = false;
let _camActualFacing   = 'environment'; // as reported by the track
let _camFlashMode      = 'off';   // 'off' | 'on'

async function _camOpenLiveCamera () {
  const m = document.getElementById('cam-capture-modal');
  if (!m) return;
  // Build (once) the live view container inside the modal stage.
  let live = document.getElementById('cam-live-view');
  if (!live) {
    live = document.createElement('div');
    live.id = 'cam-live-view';
    live.style.cssText = 'display:none;flex-direction:column;gap:10px;align-items:center;width:100%';
    live.innerHTML = `
      <div id="cam-live-stage" style="position:relative;width:100%;max-width:420px;aspect-ratio:3/4;background:#000;border-radius:10px;overflow:hidden;touch-action:none;user-select:none">
        <video id="cam-live-video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;background:#000;transform-origin:center center"></video>
        <button id="cam-live-flip" title="Flip camera" style="position:absolute;top:8px;right:8px;background:rgba(12,28,22,.7);color:#dff5e8;border:1px solid #2f5548;border-radius:50%;width:36px;height:36px;font-size:16px;cursor:pointer;z-index:3;transition:background .15s">🔄</button>
        <button id="cam-live-flash" title="Flash" style="position:absolute;top:8px;right:52px;background:rgba(12,28,22,.7);color:#dff5e8;border:1px solid #2f5548;border-radius:18px;min-width:36px;height:36px;padding:0 10px;font-size:13px;font-weight:700;cursor:pointer;z-index:3;display:none;gap:4px;align-items:center;justify-content:center;white-space:nowrap;transition:background .15s">⚡ Off</button>
        <div id="cam-zoom-badge" style="position:absolute;top:8px;left:8px;background:rgba(0,0,0,.55);color:#fff;border:1px solid #333;border-radius:14px;padding:4px 10px;font-size:12px;font-weight:600;display:none;z-index:3">1.0×</div>
        <div id="cam-rec-badge" style="position:absolute;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(220,40,40,.85);color:#fff;border-radius:14px;padding:4px 12px;font-size:12px;font-weight:700;display:none;z-index:3;letter-spacing:.5px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#fff;margin-right:6px;animation:cam-rec-pulse 1s infinite"></span><span id="cam-rec-timer">0:00</span></div>
      </div>
      <div style="font-size:11px;color:#666;text-align:center;line-height:1.3;max-width:420px">
        Tap shutter for photo \u00b7 hold for video \u00b7 pinch to zoom
      </div>
      <div style="display:flex;gap:10px;width:100%;max-width:420px">
        <button id="cam-live-cancel" style="flex:1;background:#1e1e1e;color:#e0e0e0;border:1px solid #333;padding:10px;border-radius:8px;cursor:pointer">Cancel</button>
        <button id="cam-live-shutter" style="flex:2;background:#4caf50;color:#000;border:0;padding:10px;border-radius:8px;font-weight:700;cursor:pointer;touch-action:manipulation;user-select:none">\ud83d\udcf8 Capture</button>
      </div>`;
    m.querySelector('#cam-stage').appendChild(live);
    // Inject rec-pulse keyframes once
    if (!document.getElementById('cam-rec-kf')) {
      const s = document.createElement('style');
      s.id = 'cam-rec-kf';
      s.textContent = '@keyframes cam-rec-pulse{0%,100%{opacity:1}50%{opacity:.3}}';
      document.head.appendChild(s);
    }
    live.querySelector('#cam-live-flip').onclick = async () => {
      _camLiveFacing = (_camLiveFacing === 'user') ? 'environment' : 'user';
      await _camStartLiveStream();
    };
    live.querySelector('#cam-live-flash').onclick = () => _camToggleFlash();
    live.querySelector('#cam-live-cancel').onclick = () => {
      _camStopLiveCamera();
      m.querySelector('#cam-empty').style.display = 'flex';
      live.style.display = 'none';
    };
    // Hold-to-record wiring on the shutter
    const shutter = live.querySelector('#cam-live-shutter');
    const onDown = (e) => { e.preventDefault(); _camShutterDown(); };
    const onUp   = (e) => { e.preventDefault(); _camShutterUp(); };
    shutter.addEventListener('pointerdown', onDown);
    shutter.addEventListener('pointerup',   onUp);
    shutter.addEventListener('pointercancel', onUp);
    shutter.addEventListener('pointerleave', (e) => {
      // Only treat a leave as release if pointer is still pressed
      if (_camIsRecording || _camHoldTimer) _camShutterUp();
    });

    // Pinch-to-zoom on the video stage
    const stage = live.querySelector('#cam-live-stage');
    stage.addEventListener('touchstart', _camTouchStart, { passive: false });
    stage.addEventListener('touchmove',  _camTouchMove,  { passive: false });
    stage.addEventListener('touchend',   _camTouchEnd);
    stage.addEventListener('touchcancel',_camTouchEnd);
    // Wheel zoom for desktop testing
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = -Math.sign(e.deltaY) * 0.1;
      _camApplyZoom(_camZoomVal + delta);
    }, { passive: false });
  }
  // Hide the initial prompt, show the live view.
  m.querySelector('#cam-empty').style.display = 'none';
  m.querySelector('#cam-preview').style.display = 'none';
  m.querySelector('#cam-filters').style.display = 'none';
  m.querySelector('#cam-sliders').style.display = 'none';
  m.querySelector('#cam-actions').style.display = 'none';
  live.style.display = 'flex';
  await _camStartLiveStream();
}

async function _camStartLiveStream () {
  _camStopLiveCamera();
  try {
    _camLiveStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _camLiveFacing, width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: true,   // enable for hold-to-record video with sound
    });
  } catch (e) {
    // Fall back without audio (permission denied on mic but camera ok)
    try {
      _camLiveStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: _camLiveFacing },
        audio: false,
      });
    } catch (e2) {
      toast('Camera access denied', 'error');
      const m = document.getElementById('cam-capture-modal');
      if (m) {
        m.querySelector('#cam-empty').style.display = 'flex';
        const live = document.getElementById('cam-live-view');
        if (live) live.style.display = 'none';
      }
      return;
    }
  }
  const v = document.getElementById('cam-live-video');
  if (v) {
    v.srcObject = _camLiveStream;
    v.style.transform = '';
  }
  _camZoomVal = 1;
  const badge = document.getElementById('cam-zoom-badge');
  if (badge) badge.style.display = 'none';
  // Probe hardware zoom + torch capabilities. We trust `caps.torch` here —
  // the applyConstraints probe trick we used before lied on many Android
  // WebView builds (returned success without actually toggling the LED).
  _camZoomTrack = null; _camZoomCap = null;
  _camTorchOn = false; _camFlashMode = 'off';
  _camScreenFlashOff();
  _camTorchSupported = false;
  _camTorchViaBridge = false;
  // Read the *actual* facing mode from the track settings — the requested
  // `_camLiveFacing` isn't always honored.
  _camActualFacing = _camLiveFacing;
  try {
    const track = _camLiveStream.getVideoTracks()[0];
    if (track && typeof track.getSettings === 'function') {
      const s = track.getSettings();
      if (s && s.facingMode) _camActualFacing = s.facingMode;
    }
    if (track && typeof track.getCapabilities === 'function') {
      const caps = track.getCapabilities();
      if (caps && caps.zoom) {
        _camZoomTrack = track;
        _camZoomCap = { min: caps.zoom.min || 1, max: caps.zoom.max || 3, step: caps.zoom.step || 0.1 };
      }
      if (caps && caps.torch === true && _camActualFacing !== 'user') {
        _camTorchSupported = true;
      }
    }
  } catch {}
  // Android WebView fallback: most WebView builds don't advertise caps.torch
  // even when the hardware LED exists. Assume rear camera on any mobile has
  // an LED. The toggle itself will handle failure gracefully with a toast.
  if (!_camTorchSupported && _camActualFacing !== 'user') {
    let bridgeHas = false;
    try {
      bridgeHas = !!(typeof window !== 'undefined'
        && window.Android
        && typeof window.Android.hasTorch === 'function'
        && window.Android.hasTorch());
    } catch {}
    // Show the button on any mobile rear cam (coarse UA check) or when the
    // native bridge confirms a flash unit exists.
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    if (bridgeHas || isMobile) {
      _camTorchSupported = true;
      if (bridgeHas) _camTorchViaBridge = true;
    }
  }
  _camUpdateFlashBtn();
}

/* ── Flash: armed at capture time, not kept persistently on ──────────
   Android WebView is fundamentally hostile to persistent torch while a
   camera preview is streaming: applyConstraints({torch}) silently lies on
   many builds, and CameraManager.setTorchMode() is blocked by the camera
   driver whenever getUserMedia holds the flash unit. The reliable pattern
   every native camera app uses is: arm the flash as a boolean state, then
   at shutter time briefly turn the LED on, grab the frame, turn it off. */
function _camUpdateFlashBtn () {
  const btn = document.getElementById('cam-live-flash');
  if (!btn) return;
  const isFront = _camLiveFacing === 'user';
  const show = isFront || _camTorchSupported;
  btn.style.display = show ? 'inline-flex' : 'none';
  if (!show) return;
  if (_camFlashMode === 'on') {
    btn.textContent = isFront ? '💡 On' : '⚡ On';
    btn.style.background = '#ffb300'; btn.style.color = '#000';
  } else {
    btn.textContent = isFront ? '💡 Off' : '⚡ Off';
    btn.style.background = 'rgba(0,0,0,.55)'; btn.style.color = '#fff';
  }
}
function _camToggleFlash () {
  const isFront = _camLiveFacing === 'user';
  if (!isFront && !_camTorchSupported) return;
  _camFlashMode = (_camFlashMode === 'on') ? 'off' : 'on';
  _camUpdateFlashBtn();
}

/* Front-cam fill light overlay inside the camera stage. */
function _camScreenFlashOn () {
  const parent = document.getElementById('cam-live-stage')
              || document.getElementById('cam-modal')
              || document.body;
  let el = document.getElementById('cam-screen-flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cam-screen-flash';
    el.style.cssText = [
      'position:absolute', 'inset:0', 'background:#fff',
      'z-index:2',               // below controls (z-index:3)
      'pointer-events:none',
      'border-radius:inherit',
      'opacity:0',
      'transition:opacity 40ms linear'
    ].join(';');
  }
  if (el.parentElement !== parent) parent.appendChild(el);
  el.style.display = 'block';
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight;
  el.style.opacity = '1';
}
function _camScreenFlashOff () {
  const el = document.getElementById('cam-screen-flash');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => { if (el) el.style.display = 'none'; }, 120);
}

/* Fire the rear-camera LED. Returns true if at least one path lit it.
   We deliberately do NOT tear down and reacquire the camera stream — that
   caused the black-preview glitch users complained about. If neither the
   track constraint nor the native bridge works while the camera is open,
   we return false and the caller falls back gracefully. */
async function _camTorchSet (enable) {
  const dbg = (...a) => { try { console.log('[torch]', ...a); } catch {} };
  dbg('request', { enable, facing: _camLiveFacing, hasStream: !!_camLiveStream });
  let ok = false;
  // Path A — applyConstraints on the active track.
  if (_camLiveStream) {
    const track = _camLiveStream.getVideoTracks()[0];
    if (track) {
      const caps = (typeof track.getCapabilities === 'function') ? track.getCapabilities() : null;
      dbg('track caps', { torch: caps && caps.torch, label: track.label, readyState: track.readyState });
      try {
        await track.applyConstraints({ advanced: [{ torch: !!enable }] });
        ok = true;
        dbg('pathA applyConstraints OK');
      } catch (e) {
        dbg('pathA applyConstraints FAIL', e && e.message);
      }
    }
  }
  // Path B — native Android bridge.
  const hasBridge = !!(typeof window !== 'undefined'
      && window.Android
      && typeof window.Android.torchOn === 'function');
  dbg('bridge available?', hasBridge);
  if (hasBridge) {
    try {
      const bok = enable ? window.Android.torchOn() : window.Android.torchOff();
      dbg('pathB bridge result', bok);
      if (bok) ok = true;
    } catch (e) {
      dbg('pathB bridge THREW', e && e.message);
    }
  }
  if (ok) _camTorchOn = !!enable;
  dbg('result', { ok, torchOn: _camTorchOn });
  return ok;
}
// Legacy alias kept for call sites that still reference it.
async function _camApplyTorch (enable) { return _camTorchSet(enable); }

function _camStopLiveCamera () {
  // Abort any in-flight recording cleanly
  _camAbortRecordingSilent();
  // Turn the LED off before releasing the track.
  if (_camTorchOn) {
    if (_camTorchViaBridge) {
      try { window.Android && window.Android.torchOff && window.Android.torchOff(); } catch {}
    } else if (_camLiveStream) {
      try {
        const t = _camLiveStream.getVideoTracks()[0];
        if (t) t.applyConstraints({ advanced: [{ torch: false }] });
      } catch {}
    }
  }
  _camScreenFlashOff();
  _camTorchOn = false; _camFlashMode = 'off';
  _camTorchViaBridge = false;
  if (_camLiveStream) {
    try { _camLiveStream.getTracks().forEach(t => t.stop()); } catch {}
    _camLiveStream = null;
  }
  const v = document.getElementById('cam-live-video');
  if (v) { v.srcObject = null; v.style.transform = ''; }
  _camZoomTrack = null; _camZoomCap = null; _camZoomVal = 1;
}

/* ── Pinch-to-zoom ──────────────────────────────────────────────────── */
function _camTouchDist (t) {
  const dx = t[0].clientX - t[1].clientX;
  const dy = t[0].clientY - t[1].clientY;
  return Math.hypot(dx, dy);
}
function _camTouchStart (e) {
  if (e.touches.length === 2) {
    e.preventDefault();
    _camPinchStart = _camTouchDist(e.touches);
    _camZoomStart  = _camZoomVal || 1;
  }
}
function _camTouchMove (e) {
  if (e.touches.length === 2 && _camPinchStart > 0) {
    e.preventDefault();
    const d = _camTouchDist(e.touches);
    const factor = d / _camPinchStart;
    _camApplyZoom(_camZoomStart * factor);
  }
}
function _camTouchEnd (e) {
  if (e.touches.length < 2) _camPinchStart = 0;
}
function _camApplyZoom (target) {
  const v = document.getElementById('cam-live-video');
  const badge = document.getElementById('cam-zoom-badge');
  if (_camZoomTrack && _camZoomCap) {
    const z = Math.max(_camZoomCap.min, Math.min(_camZoomCap.max, target));
    try {
      _camZoomTrack.applyConstraints({ advanced: [{ zoom: z }] });
      _camZoomVal = z;
    } catch {}
    const ratio = _camZoomCap.min ? (z / _camZoomCap.min) : z;
    if (badge) { badge.textContent = ratio.toFixed(1) + '\u00d7'; badge.style.display = 'block'; }
  } else if (v) {
    // CSS fallback
    const z = Math.max(1, Math.min(4, target));
    _camZoomVal = z;
    v.style.transform = 'scale(' + z.toFixed(3) + ')';
    if (badge) { badge.textContent = z.toFixed(1) + '\u00d7'; badge.style.display = z > 1.01 ? 'block' : 'none'; }
  }
}

/* ── Hold-to-record shutter ─────────────────────────────────────────── */
function _camShutterDown () {
  if (_camIsRecording) return;
  if (_camHoldTimer) { clearTimeout(_camHoldTimer); }
  _camHoldTimer = setTimeout(() => {
    _camHoldTimer = null;
    _camStartVideoRecording();
  }, 250);
}
function _camShutterUp () {
  // Short tap → photo
  if (_camHoldTimer) {
    clearTimeout(_camHoldTimer);
    _camHoldTimer = null;
    if (!_camIsRecording) { _camLiveSnap(); return; }
  }
  // Release during recording → stop and finalise
  if (_camIsRecording) _camStopVideoRecording();
}

function _camStartVideoRecording () {
  if (!_camLiveStream) return;
  // Video-flash was tried on Samsung hardware and the driver refuses to
  // keep the LED on while recording (insufficient resources). The
  // reacquire dance only produced a brief flicker, so we just record
  // without flash. Photos still get the 3-tier flash path.

  try {
    const mime = getSupportedVideoMime();
    _camRecorder  = new MediaRecorder(_camLiveStream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    _camRecChunks = [];
    _camRecStart  = Date.now();
    _camIsRecording = true;

    _camRecorder.ondataavailable = (e) => { if (e.data && e.data.size) _camRecChunks.push(e.data); };
    _camRecorder.onstop = () => {
      // Safety: kill any lingering torch state (shouldn't be on for video).
      try { _camTorchSet(false); } catch {}
      _camTorchOn = false;
      const blob = new Blob(_camRecChunks, { type: _camRecorder.mimeType || 'video/webm' });
      _camRecChunks = [];
      _camIsRecording = false;
      const badge = document.getElementById('cam-rec-badge');
      if (badge) badge.style.display = 'none';
      if (_camRecInterval) { clearInterval(_camRecInterval); _camRecInterval = null; }
      // Reset shutter label
      const shutter = document.getElementById('cam-live-shutter');
      if (shutter) { shutter.textContent = '\ud83d\udcf8 Capture'; shutter.style.background = '#4caf50'; }
      if (!blob.size) { toast('Recording was empty', 'error'); return; }
      const name = 'video-' + Date.now() + (mime.includes('mp4') ? '.mp4' : '.webm');
      _camShowVideoReview(blob, name);
    };
    _camRecorder.start(250);
    // UI feedback
    const badge = document.getElementById('cam-rec-badge');
    const timer = document.getElementById('cam-rec-timer');
    if (badge) badge.style.display = 'block';
    _camRecInterval = setInterval(() => {
      const secs = Math.floor((Date.now() - _camRecStart) / 1000);
      if (timer) {
        const mm = Math.floor(secs / 60);
        timer.textContent = mm + ':' + (secs % 60).toString().padStart(2, '0');
      }
      // Hard cap at 60s so we don't blow past the 20MB upload ceiling
      if (secs >= 60) _camStopVideoRecording();
    }, 250);
    const shutter = document.getElementById('cam-live-shutter');
    if (shutter) {
      shutter.textContent = '\u25a0 Recording \u2014 release to stop';
      shutter.style.background = '#e53935';
      shutter.style.color = '#fff';
    }
    // Haptic nudge on supported devices
    try { navigator.vibrate && navigator.vibrate(25); } catch {}
  } catch (e) {
    _camIsRecording = false;
    toast('Video recording not supported', 'error');
  }
}

function _camStopVideoRecording () {
  if (_camRecorder && _camRecorder.state !== 'inactive') {
    try { _camRecorder.stop(); } catch {}
  }
}

function _camAbortRecordingSilent () {
  if (_camHoldTimer) { clearTimeout(_camHoldTimer); _camHoldTimer = null; }
  if (_camRecorder && _camRecorder.state !== 'inactive') {
    try { _camRecorder.onstop = null; _camRecorder.stop(); } catch {}
  }
  _camRecorder = null; _camRecChunks = []; _camIsRecording = false;
  if (_camRecInterval) { clearInterval(_camRecInterval); _camRecInterval = null; }
  const badge = document.getElementById('cam-rec-badge');
  if (badge) badge.style.display = 'none';
  const shutter = document.getElementById('cam-live-shutter');
  if (shutter) { shutter.textContent = '\ud83d\udcf8 Capture'; shutter.style.background = '#4caf50'; shutter.style.color = '#000'; }
}

// Show a post-record video preview inside the camera modal with Retake /
// Use buttons, mirroring the photo preview flow.
function _camShowVideoReview (blob, name) {
  const stage = document.getElementById('cam-live-stage');
  const live  = document.getElementById('cam-live-view');
  if (!stage || !live) {
    // Fallback: skip review and attach directly.
    window._pendingAttachment = { blob, name, type: blob.type };
    _renderAttachmentPreview({ blob, name, type: blob.type, sizeBytes: blob.size });
    closeCameraCapture();
    return;
  }
  // Pause the live stream so the device isn't pegged during review.
  try { _camStopLiveCamera(); } catch {}
  const url = URL.createObjectURL(blob);
  // Build (or reuse) the review overlay inside the stage.
  let overlay = document.getElementById('cam-video-review');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cam-video-review';
    overlay.style.cssText = 'position:absolute;inset:0;background:#000;display:flex;align-items:center;justify-content:center;z-index:5';
    overlay.innerHTML = '<video id="cam-video-review-vid" playsinline controls loop style="width:100%;height:100%;object-fit:contain;background:#000"></video>';
    stage.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  const vv = document.getElementById('cam-video-review-vid');
  if (vv) {
    if (vv._prevUrl) { try { URL.revokeObjectURL(vv._prevUrl); } catch {} }
    vv._prevUrl = url;
    vv.src = url;
    try { vv.play(); } catch {}
  }
  // Swap the bottom button row (Cancel + Shutter) for Retake + Use.
  const cancelBtn  = document.getElementById('cam-live-cancel');
  const shutterBtn = document.getElementById('cam-live-shutter');
  if (cancelBtn)  cancelBtn.style.display  = 'none';
  if (shutterBtn) shutterBtn.style.display = 'none';
  let review = document.getElementById('cam-video-review-actions');
  if (!review) {
    review = document.createElement('div');
    review.id = 'cam-video-review-actions';
    review.style.cssText = 'display:flex;gap:10px;width:100%;max-width:420px';
    review.innerHTML = `
      <button id="cam-vrev-retake" style="flex:1;background:#1e1e1e;color:#e0e0e0;border:1px solid #333;padding:10px;border-radius:8px;cursor:pointer">\ud83d\udd01 Retake</button>
      <button id="cam-vrev-use" style="flex:2;background:#4caf50;color:#000;border:0;padding:10px;border-radius:8px;font-weight:700;cursor:pointer">\u2705 Use video</button>`;
    live.appendChild(review);
    review.querySelector('#cam-vrev-retake').onclick = () => _camVideoReviewRetake();
    review.querySelector('#cam-vrev-use').onclick    = () => _camVideoReviewUse();
  }
  review.style.display = 'flex';
  // Stash for the button handlers.
  _camPendingVideo = { blob, name };
}

let _camPendingVideo = null;

function _camCloseVideoReview () {
  const overlay = document.getElementById('cam-video-review');
  const vv      = document.getElementById('cam-video-review-vid');
  if (vv) { try { vv.pause(); } catch {} if (vv._prevUrl) { try { URL.revokeObjectURL(vv._prevUrl); } catch {} vv._prevUrl = null; } vv.removeAttribute('src'); try { vv.load(); } catch {} }
  if (overlay) overlay.style.display = 'none';
  const review = document.getElementById('cam-video-review-actions');
  if (review) review.style.display = 'none';
  const cancelBtn  = document.getElementById('cam-live-cancel');
  const shutterBtn = document.getElementById('cam-live-shutter');
  if (cancelBtn)  cancelBtn.style.display  = '';
  if (shutterBtn) shutterBtn.style.display = '';
}

async function _camVideoReviewRetake () {
  _camPendingVideo = null;
  _camCloseVideoReview();
  try { await _camStartLiveStream(); } catch {}
}

function _camVideoReviewUse () {
  if (!_camPendingVideo) { _camCloseVideoReview(); return; }
  const { blob, name } = _camPendingVideo;
  _camPendingVideo = null;
  window._pendingAttachment = { blob, name, type: blob.type };
  _renderAttachmentPreview({ blob, name, type: blob.type, sizeBytes: blob.size });
  _camCloseVideoReview();
  closeCameraCapture();
  toast('Video ready \u2014 hit Send', 'success');
}

async function _camLiveSnap () {
  const v = document.getElementById('cam-live-video');
  if (!v || !v.videoWidth) { toast('Camera not ready', 'error'); return; }
  const isFront = _camLiveFacing === 'user';
  const flashArmed = _camFlashMode === 'on';

  if (!flashArmed) { _camFinishSnap(v); return; }

  if (isFront) {
    _camScreenFlashOn();
    await new Promise(r => setTimeout(r, 120));
    try { _camFinishSnap(v); }
    finally { _camScreenFlashOff(); }
    return;
  }

  // Rear cam + flash armed. Try strategies in order of preference.

  // (1) Standard ImageCapture API with fillLightMode — lets the driver
  //     orchestrate pre-flash / auto-exposure on its own. Works on desktop
  //     Chrome and newer Android WebView builds.
  try {
    const track = _camLiveStream && _camLiveStream.getVideoTracks()[0];
    if (track && typeof window.ImageCapture === 'function') {
      const ic = new ImageCapture(track);
      const caps = ic.getPhotoCapabilities ? await ic.getPhotoCapabilities() : null;
      const supportsFlash = caps && Array.isArray(caps.fillLightMode)
          && caps.fillLightMode.includes('flash');
      if (supportsFlash) {
        console.log('[flash] using ImageCapture.takePhoto({fillLightMode:flash})');
        const blob = await ic.takePhoto({ fillLightMode: 'flash' });
        await _camFinishSnapFromBlob(blob);
        return;
      }
    }
  } catch (e) { console.log('[flash] ImageCapture path failed', e && e.message); }

  // (2) Plain track.applyConstraints({torch:true}) — works on some devices
  //     even when the native bridge doesn't.
  try {
    const track = _camLiveStream && _camLiveStream.getVideoTracks()[0];
    if (track) {
      await track.applyConstraints({ advanced: [{ torch: true }] });
      console.log('[flash] applyConstraints lit the LED');
      await new Promise(r => setTimeout(r, 400));
      _camFinishSnap(v);
      try { await track.applyConstraints({ advanced: [{ torch: false }] }); } catch {}
      return;
    }
  } catch (e) { console.log('[flash] applyConstraints failed', e && e.message); }

  // (3) Close the preview → fire the native torch bridge → reopen camera
  //     (the LED stays lit because setTorchMode is session-independent) →
  //     capture frame → close → torch off → reopen preview. This is the
  //     only reliable path on Samsung/Snapdragon devices where the camera
  //     service refuses setTorchMode while a session is open.
  const hasBridge = !!(window.Android && typeof window.Android.torchOn === 'function');
  if (hasBridge) {
    const savedFacing = _camLiveFacing;
    const stage  = document.getElementById('cam-live-stage');
    const videoEl = document.getElementById('cam-live-video');
    try {
      // Close the preview and release the camera.
      if (_camLiveStream) {
        _camLiveStream.getTracks().forEach(t => t.stop());
        _camLiveStream = null;
      }
      if (videoEl) { videoEl.srcObject = null; }
      // Wait for the HAL to fully release the camera. Samsung drivers need
      // this — without it setTorchMode returns "insufficient resources".
      await new Promise(r => setTimeout(r, 300));
      const torched = window.Android.torchOn();
      console.log('[flash] bridge torchOn →', torched);
      if (!torched) {
        if (typeof toast === 'function') toast('Flash unavailable on this device', 'error');
        await _camStartLiveStream();
        _camFinishSnap(document.getElementById('cam-live-video'));
        return;
      }
      // Now reopen the camera to get a frame under the LED.
      _camLiveFacing = savedFacing;
      const hiStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: savedFacing, width: { ideal: 1920 }, height: { ideal: 1920 } },
        audio: false,
      });
      const freshTrack = hiStream.getVideoTracks()[0];
      // Push the LED back on through the new session (opening the camera
      // can reset torch state on some drivers).
      try { await freshTrack.applyConstraints({ advanced: [{ torch: true }] }); } catch {}
      try { window.Android.torchOn(); } catch {}
      const hiVid = document.createElement('video');
      hiVid.muted = true; hiVid.playsInline = true;
      hiVid.srcObject = hiStream;
      await hiVid.play().catch(() => {});
      // Wait for the first good frame + auto-exposure adapt to the LED.
      const waitFirstFrame = new Promise(res => {
        if (hiVid.videoWidth) return res();
        hiVid.onloadedmetadata = () => res();
        setTimeout(res, 500);
      });
      await waitFirstFrame;
      await new Promise(r => setTimeout(r, 400));
      _camFinishSnap(hiVid);  // this also calls _camStopLiveCamera → torch off via stream close
      // Make absolutely sure the LED is off.
      try { window.Android.torchOff(); } catch {}
      try { hiStream.getTracks().forEach(t => t.stop()); } catch {}
      return;
    } catch (e) {
      console.log('[flash] bridge cycle failed', e && e.message);
      try { window.Android.torchOff(); } catch {}
      // Reopen preview so the UI doesn't end up stuck on a black video.
      try { await _camStartLiveStream(); } catch {}
      if (typeof toast === 'function') toast('Flash failed — captured without flash', 'error');
      const vv = document.getElementById('cam-live-video');
      if (vv && vv.videoWidth) _camFinishSnap(vv);
      return;
    }
  }

  // Nothing worked — capture without flash.
  if (typeof toast === 'function') toast('Flash unavailable on this device', 'error');
  _camFinishSnap(v);
}

/* Convert a Blob from ImageCapture.takePhoto() into the same filter-preview
   state that _camFinishSnap leaves behind. */
async function _camFinishSnapFromBlob (blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    if (_camLiveFacing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(img, 0, 0);
    _camStopLiveCamera();
    const dataUrl = c.toDataURL('image/jpeg', 0.92);
    _camOrigDataUrl = dataUrl;
    _camFilter = { ..._camFilterPresets.none };
    const m = document.getElementById('cam-capture-modal');
    if (!m) return;
    const live = document.getElementById('cam-live-view');
    if (live) live.style.display = 'none';
    m.querySelector('#cam-empty').style.display = 'none';
    m.querySelector('#cam-preview').style.display = 'block';
    m.querySelector('#cam-filters').style.display = 'flex';
    m.querySelector('#cam-sliders').style.display = 'flex';
    m.querySelector('#cam-actions').style.display = 'flex';
    m.querySelectorAll('#cam-sliders input[type=range]').forEach(r => { r.value = 100; });
    _camRender();
    _camSetActivePreset('none');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function _camFinishSnap (v) {
  const vw = v.videoWidth, vh = v.videoHeight;

  // Crop the sensor frame to match what the user actually sees.
  //  (a) The live preview uses `object-fit:cover` inside a 3:4 container,
  //      so anything outside that aspect is off-screen.
  //  (b) When we're using the CSS-transform zoom fallback, the preview is
  //      scaled up around its centre — without cropping here the saved
  //      photo was the full un-zoomed sensor frame, which is why users
  //      reported "zoomed in preview but full picture was sent".
  //  Hardware zoom already alters the sensor stream so vw/vh already
  //  reflect that — we only need to apply the centre-crop by `_camZoomVal`
  //  when we're on the CSS fallback path.
  const stageAR = 3 / 4; // width / height, matches aspect-ratio:3/4 CSS
  const videoAR = vw / vh;
  let srcW, srcH;
  if (videoAR > stageAR) {
    srcH = vh;
    srcW = vh * stageAR;
  } else {
    srcW = vw;
    srcH = vw / stageAR;
  }
  if (!_camZoomTrack && _camZoomVal > 1.01) {
    srcW /= _camZoomVal;
    srcH /= _camZoomVal;
  }
  const sx = Math.max(0, (vw - srcW) / 2);
  const sy = Math.max(0, (vh - srcH) / 2);
  srcW = Math.min(srcW, vw);
  srcH = Math.min(srcH, vh);

  const c = document.createElement('canvas');
  c.width  = Math.round(srcW);
  c.height = Math.round(srcH);
  const ctx = c.getContext('2d');
  // Mirror the front-facing camera so the saved image matches what the
  // user sees in the preview (unmirrored for rear).
  if (_camLiveFacing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(v, sx, sy, srcW, srcH, 0, 0, c.width, c.height);
  // Stop the live stream — we have the frame now.
  _camStopLiveCamera();
  // Feed the captured (unfiltered) frame into the existing filter preview
  // so filters can still be tuned after the shot.
  const dataUrl = c.toDataURL('image/jpeg', 0.92);
  _camOrigDataUrl = dataUrl;
  _camFilter = { ..._camFilterPresets.none };
  const m = document.getElementById('cam-capture-modal');
  if (!m) return;
  const live = document.getElementById('cam-live-view');
  if (live) live.style.display = 'none';
  m.querySelector('#cam-empty').style.display = 'none';
  m.querySelector('#cam-preview').style.display = 'block';
  m.querySelector('#cam-filters').style.display = 'flex';
  m.querySelector('#cam-sliders').style.display = 'flex';
  m.querySelector('#cam-actions').style.display = 'flex';
  m.querySelectorAll('#cam-sliders input[type=range]').forEach(r => { r.value = 100; });
  _camRender();
  _camSetActivePreset('none');
}

function _camOnFile (input) {
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { toast('Image too large (max 20 MB)', 'error'); return; }
  const fr = new FileReader();
  fr.onload = e => {
    _camOrigDataUrl = e.target.result;
    _camFilter = { ..._camFilterPresets.none };
    const m = document.getElementById('cam-capture-modal');
    m.querySelector('#cam-empty').style.display = 'none';
    m.querySelector('#cam-preview').style.display = 'block';
    m.querySelector('#cam-filters').style.display = 'flex';
    m.querySelector('#cam-sliders').style.display = 'flex';
    m.querySelector('#cam-actions').style.display = 'flex';
    // Reset sliders
    m.querySelectorAll('#cam-sliders input[type=range]').forEach(r => { r.value = 100; });
    _camRender();
    _camSetActivePreset('none');
  };
  fr.readAsDataURL(f);
}

function _camRender () {
  const img = document.getElementById('cam-preview');
  if (!img) return;
  img.src = _camOrigDataUrl;
  img.style.filter = _camFilterStr();
}

function _camApplyPreset (preset) {
  _camFilter = { ..._camFilterPresets[preset] };
  const m = document.getElementById('cam-capture-modal');
  m.querySelectorAll('#cam-sliders input[type=range]').forEach(r => {
    if (_camFilter[r.dataset.k] !== undefined) r.value = _camFilter[r.dataset.k];
  });
  _camSetActivePreset(preset);
  _camRender();
}

function _camSetActivePreset (preset) {
  const m = document.getElementById('cam-capture-modal');
  m.querySelectorAll('.cam-filter-btn').forEach(b => {
    if (b.dataset.preset === preset) {
      b.style.background = '#4caf50'; b.style.color = '#000'; b.style.borderColor = '#4caf50';
    } else {
      b.style.background = '#1e1e1e'; b.style.color = '#e0e0e0'; b.style.borderColor = '#333';
    }
  });
}

function _camRetake () {
  const m = document.getElementById('cam-capture-modal');
  _camOrigDataUrl = null;
  m.querySelector('#cam-preview').style.display = 'none';
  m.querySelector('#cam-filters').style.display = 'none';
  m.querySelector('#cam-sliders').style.display = 'none';
  m.querySelector('#cam-actions').style.display = 'none';
  // If the live camera was previously used, re-open it directly; otherwise
  // fall back to the initial chooser.
  if (document.getElementById('cam-live-view')) {
    _camOpenLiveCamera();
  } else {
    m.querySelector('#cam-empty').style.display = 'flex';
  }
}

function _camAttach () {
  if (!_camOrigDataUrl) return;
  const img = new Image();
  img.onload = () => {
    // Cap large dimensions to keep file size manageable
    let w = img.width, h = img.height;
    const MAX = 2048;
    if (w > MAX || h > MAX) {
      const r = Math.min(MAX / w, MAX / h);
      w = Math.round(w * r); h = Math.round(h * r);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.filter = _camFilterStr();
    ctx.drawImage(img, 0, 0, w, h);
    c.toBlob(blob => {
      if (!blob) { toast('Failed to encode image', 'error'); return; }
      const name = 'photo-' + Date.now() + '.jpg';
      // If caller registered a callback, deliver the filtered dataUrl to them
      if (window._camOnReady) {
        const fr = new FileReader();
        fr.onload = e => {
          try { window._camOnReady(e.target.result, blob, name); } catch {}
          window._camOnReady = null;
        };
        fr.readAsDataURL(blob);
        closeCameraCapture();
        return;
      }
      window._pendingAttachment = { blob, name, type: 'image/jpeg' };
      _renderAttachmentPreview({ blob, name, type: 'image/jpeg', sizeBytes: blob.size });
      closeCameraCapture();
      if (typeof toast === 'function') toast('Photo ready — hit Send', 'success');
    }, 'image/jpeg', 0.9);
  };
  img.onerror = () => toast('Failed to load image', 'error');
  img.src = _camOrigDataUrl;
}

/* ── Rich Story Capture (live camera + hold-to-record) ─────────────────── */
// Calls onReady(dataUrl, mimeType, blob, filename) when user taps Attach.
let _storyStream = null;
let _storyRecorder = null;
let _storyRecChunks = [];
let _storyFacing = 'user';
let _storyRecStart = 0;
let _storyRecTimer = null;
let _storyCaptured = null; // { dataUrl, mime, blob, filename }
const STORY_MAX_RECORD_MS = 15000;

async function openStoryCapture (onReady) {
  window._storyCamOnReady = typeof onReady === 'function' ? onReady : null;

  let modal = document.getElementById('story-cap-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'story-cap-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:#000;z-index:10000;display:none;flex-direction:column;align-items:center;justify-content:center';
    modal.innerHTML = `
      <div style="position:absolute;top:12px;left:12px;right:12px;display:flex;justify-content:space-between;align-items:center;z-index:2">
        <button id="story-cap-close" style="background:rgba(0,0,0,.55);color:#fff;border:1px solid #333;border-radius:50%;width:38px;height:38px;font-size:18px;cursor:pointer">✕</button>
        <div id="story-cap-timer" style="background:rgba(0,0,0,.55);color:#f44;font-size:13px;font-weight:700;padding:6px 12px;border-radius:14px;display:none">● REC 0.0s</div>
        <button id="story-cap-flip" style="background:rgba(0,0,0,.55);color:#fff;border:1px solid #333;border-radius:50%;width:38px;height:38px;font-size:18px;cursor:pointer" title="Flip camera">🔄</button>
      </div>
      <video id="story-cap-video" autoplay playsinline muted style="max-width:100%;max-height:100vh;background:#000;object-fit:cover;width:100%;height:100%"></video>
      <video id="story-cap-playback" playsinline controls style="display:none;max-width:100%;max-height:100vh;background:#000;object-fit:contain;width:100%;height:100%"></video>
      <img id="story-cap-photo" style="display:none;max-width:100%;max-height:100vh;background:#000;object-fit:contain;width:100%;height:100%">
      <div id="story-cap-filters" style="position:absolute;bottom:140px;left:0;right:0;display:none;flex-wrap:wrap;gap:6px;justify-content:center;padding:0 10px;z-index:2"></div>
      <div id="story-cap-controls" style="position:absolute;bottom:28px;left:0;right:0;display:flex;justify-content:center;align-items:center;gap:24px;z-index:2">
        <button id="story-cap-shutter" style="width:80px;height:80px;border-radius:50%;border:5px solid #fff;background:rgba(255,255,255,.2);cursor:pointer;touch-action:none;user-select:none"></button>
      </div>
      <div id="story-cap-review" style="position:absolute;bottom:28px;left:0;right:0;display:none;justify-content:center;align-items:center;gap:16px;z-index:2">
        <button id="story-cap-retake" style="background:rgba(0,0,0,.6);color:#fff;border:1px solid #555;border-radius:20px;padding:10px 22px;font-size:14px;cursor:pointer">↺ Retake</button>
        <button id="story-cap-use" style="background:#4caf50;color:#000;border:0;border-radius:20px;padding:12px 28px;font-size:15px;font-weight:700;cursor:pointer">✓ Use this</button>
      </div>
      <div id="story-cap-hint" style="position:absolute;bottom:120px;left:0;right:0;text-align:center;color:#eee;font-size:12px;text-shadow:0 1px 3px rgba(0,0,0,.8);z-index:2;pointer-events:none">
        Tap to capture photo · Hold to record video (up to 15s)
      </div>`;
    document.body.appendChild(modal);
    // Filter row reuse
    const fs = modal.querySelector('#story-cap-filters');
    Object.keys(_camFilterPresets).forEach(key => {
      const b = document.createElement('button');
      b.className = 'story-cap-filter-btn';
      b.textContent = key === 'bw' ? 'B&W' : (key[0].toUpperCase() + key.slice(1));
      b.dataset.preset = key;
      b.style.cssText = 'background:linear-gradient(180deg,#1a3a2d,#143027);color:#dff5e8;border:1px solid #2f5548;padding:6px 12px;border-radius:14px;cursor:pointer;font-size:12px';
      b.onclick = () => _storyApplyFilter(key);
      fs.appendChild(b);
    });
    // Wire up
    modal.querySelector('#story-cap-close').onclick = closeStoryCapture;
    modal.querySelector('#story-cap-flip').onclick = _storyFlip;
    modal.querySelector('#story-cap-retake').onclick = _storyRetake;
    modal.querySelector('#story-cap-use').onclick = _storyUse;
    const shutter = modal.querySelector('#story-cap-shutter');
    let holdTimer = null, didRecord = false;
    const startHold = (ev) => {
      ev.preventDefault();
      didRecord = false;
      holdTimer = setTimeout(() => { didRecord = true; _storyStartRecord(); }, 320);
    };
    const endHold = (ev) => {
      ev.preventDefault();
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (didRecord) { _storyStopRecord(); }
      else { _storyTakePhoto(); }
    };
    shutter.addEventListener('pointerdown', startHold);
    shutter.addEventListener('pointerup', endHold);
    shutter.addEventListener('pointerleave', (ev) => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (didRecord && _storyRecorder && _storyRecorder.state === 'recording') _storyStopRecord();
    });
  }

  modal.style.display = 'flex';
  _storyCaptured = null;
  _camFilter = { ..._camFilterPresets.none };
  _storyShowCaptureUI();
  await _storyStartStream();
}

function closeStoryCapture () {
  const m = document.getElementById('story-cap-modal');
  if (m) m.style.display = 'none';
  _storyStopStream();
  if (_storyRecorder && _storyRecorder.state === 'recording') {
    try { _storyRecorder.stop(); } catch {}
  }
  if (_storyRecTimer) { clearInterval(_storyRecTimer); _storyRecTimer = null; }
}

async function _storyStartStream () {
  _storyStopStream();
  try {
    _storyStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _storyFacing, width: { ideal: 1080 }, height: { ideal: 1920 } },
      audio: true
    });
  } catch (e) {
    // try without audio
    try {
      _storyStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: _storyFacing }, audio: false });
    } catch (e2) {
      toast('Camera access denied', 'error');
      closeStoryCapture();
      // Fallback to file-based capture
      if (typeof openCameraCapture === 'function' && window._storyCamOnReady) {
        const cb = window._storyCamOnReady;
        window._storyCamOnReady = null;
        setTimeout(() => openCameraCapture((dataUrl, blob, name) => cb(dataUrl, 'image/jpeg', blob, name)), 100);
      }
      return;
    }
  }
  const v = document.getElementById('story-cap-video');
  if (v) { v.srcObject = _storyStream; v.style.filter = _camFilterStr(); }
}

function _storyStopStream () {
  if (_storyStream) {
    try { _storyStream.getTracks().forEach(t => t.stop()); } catch {}
    _storyStream = null;
  }
  const v = document.getElementById('story-cap-video');
  if (v) v.srcObject = null;
}

async function _storyFlip () {
  _storyFacing = (_storyFacing === 'user') ? 'environment' : 'user';
  await _storyStartStream();
}

function _storyApplyFilter (key) {
  _camFilter = { ..._camFilterPresets[key] };
  const v = document.getElementById('story-cap-video');
  const img = document.getElementById('story-cap-photo');
  if (v) v.style.filter = _camFilterStr();
  if (img) img.style.filter = _camFilterStr();
  const m = document.getElementById('story-cap-modal');
  m.querySelectorAll('.story-cap-filter-btn').forEach(b => {
    const active = b.dataset.preset === key;
    b.style.background = active ? '#4caf50' : 'rgba(0,0,0,.6)';
    b.style.color = active ? '#000' : '#fff';
    b.style.borderColor = active ? '#4caf50' : '#333';
  });
}

function _storyTakePhoto () {
  const v = document.getElementById('story-cap-video');
  if (!v || !v.videoWidth) { toast('Camera not ready', 'error'); return; }
  const w = v.videoWidth, h = v.videoHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  // mirror front camera
  if (_storyFacing === 'user') { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.filter = _camFilterStr();
  ctx.drawImage(v, 0, 0, w, h);
  c.toBlob(blob => {
    if (!blob) { toast('Capture failed', 'error'); return; }
    const fr = new FileReader();
    fr.onload = e => {
      _storyCaptured = { dataUrl: e.target.result, mime: 'image/jpeg', blob, filename: 'story-' + Date.now() + '.jpg' };
      _storyShowReviewUI('photo');
    };
    fr.readAsDataURL(blob);
  }, 'image/jpeg', 0.88);
}

function _storyStartRecord () {
  if (!_storyStream) return;
  _storyRecChunks = [];
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  const supported = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  try {
    _storyRecorder = new MediaRecorder(_storyStream, supported ? { mimeType: supported, videoBitsPerSecond: 1_500_000 } : undefined);
  } catch { toast('Recording not supported', 'error'); return; }
  _storyRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) _storyRecChunks.push(e.data); };
  _storyRecorder.onstop = _storyOnRecStop;
  _storyRecorder.start();
  _storyRecStart = Date.now();
  const timerEl = document.getElementById('story-cap-timer');
  const hint = document.getElementById('story-cap-hint');
  if (hint) hint.style.display = 'none';
  if (timerEl) timerEl.style.display = 'block';
  const shutter = document.getElementById('story-cap-shutter');
  if (shutter) shutter.style.background = '#f44';
  _storyRecTimer = setInterval(() => {
    const el = document.getElementById('story-cap-timer');
    const secs = (Date.now() - _storyRecStart) / 1000;
    if (el) el.textContent = `● REC ${secs.toFixed(1)}s`;
    if (Date.now() - _storyRecStart >= STORY_MAX_RECORD_MS) _storyStopRecord();
  }, 100);
}

function _storyStopRecord () {
  if (!_storyRecorder) return;
  if (_storyRecorder.state === 'recording') {
    try { _storyRecorder.stop(); } catch {}
  }
  if (_storyRecTimer) { clearInterval(_storyRecTimer); _storyRecTimer = null; }
  const timerEl = document.getElementById('story-cap-timer');
  if (timerEl) timerEl.style.display = 'none';
  const shutter = document.getElementById('story-cap-shutter');
  if (shutter) shutter.style.background = 'rgba(255,255,255,.2)';
}

function _storyOnRecStop () {
  const mime = (_storyRecorder && _storyRecorder.mimeType) || 'video/webm';
  const blob = new Blob(_storyRecChunks, { type: mime });
  if (blob.size > 100 * 1024 * 1024) {
    toast('Video too large (max 100 MB) — try a shorter clip', 'error');
    _storyRecChunks = [];
    return;
  }
  const fr = new FileReader();
  fr.onload = e => {
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    _storyCaptured = { dataUrl: e.target.result, mime: mime.split(';')[0], blob, filename: 'story-' + Date.now() + '.' + ext };
    _storyShowReviewUI('video');
  };
  fr.readAsDataURL(blob);
  _storyRecChunks = [];
}

function _storyShowCaptureUI () {
  const m = document.getElementById('story-cap-modal');
  if (!m) return;
  m.querySelector('#story-cap-video').style.display = 'block';
  m.querySelector('#story-cap-playback').style.display = 'none';
  m.querySelector('#story-cap-photo').style.display = 'none';
  m.querySelector('#story-cap-controls').style.display = 'flex';
  m.querySelector('#story-cap-review').style.display = 'none';
  m.querySelector('#story-cap-filters').style.display = 'flex';
  const hint = m.querySelector('#story-cap-hint');
  if (hint) hint.style.display = 'block';
}

function _storyShowReviewUI (kind) {
  const m = document.getElementById('story-cap-modal');
  if (!m) return;
  m.querySelector('#story-cap-video').style.display = 'none';
  m.querySelector('#story-cap-controls').style.display = 'none';
  m.querySelector('#story-cap-filters').style.display = 'none';
  m.querySelector('#story-cap-hint').style.display = 'none';
  m.querySelector('#story-cap-review').style.display = 'flex';
  if (kind === 'photo') {
    const img = m.querySelector('#story-cap-photo');
    img.src = _storyCaptured.dataUrl;
    img.style.display = 'block';
    img.style.filter = 'none'; // already baked
    m.querySelector('#story-cap-playback').style.display = 'none';
  } else {
    const pb = m.querySelector('#story-cap-playback');
    pb.src = _storyCaptured.dataUrl;
    pb.style.display = 'block';
    pb.play().catch(() => {});
    m.querySelector('#story-cap-photo').style.display = 'none';
  }
}

function _storyRetake () {
  _storyCaptured = null;
  _storyShowCaptureUI();
  if (!_storyStream) _storyStartStream();
}

function _storyUse () {
  if (!_storyCaptured) return;
  const cb = window._storyCamOnReady;
  window._storyCamOnReady = null;
  closeStoryCapture();
  if (cb) try { cb(_storyCaptured.dataUrl, _storyCaptured.mime, _storyCaptured.blob, _storyCaptured.filename); } catch {}
}
