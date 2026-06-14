/* ════════════════════════════════════════════════════════════════════════
 * camfx.js — In-call camera FX pipeline (live colour filters)
 *
 * Self-contained module exposing `window.CamFX`. calls.js never touches the
 * canvas internals — it just asks for "the track to send" and "the stream to
 * preview" and wires them onto its RTCPeerConnections via the replaceTrack
 * pattern it already uses for device switching.
 *
 * Pipeline (only spun up while a real filter is active — the default 'none'
 * stays zero-overhead, sending the raw camera track untouched):
 *
 *   rawTrack → tiny on-screen <video> → per-frame draw on <canvas>
 *            → canvas.captureStream(30) → outputTrack  (sent + previewed)
 *
 * Deliberately mobile-first / WebView-safe:
 *   • NO `ctx.filter` CSS strings (unreliable on Android WebView) — every
 *     filter is built from drawImage + globalCompositeOperation + fills.
 *   • NO `desynchronized` canvas (yields black frames under captureStream on
 *     some WebViews).
 *   • The source <video> stays in the viewport (1×1, ~invisible) so the
 *     decoder keeps producing frames; draws are driven by
 *     requestVideoFrameCallback when available.
 *   • A watchdog reverts to the raw track (via onFallback) if the canvas never
 *     produces real frames — a filter must never leave a blank/green call.
 * ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Filter catalogue (drives the picker UI) ───────────────────────────────
  const FILTERS = [
    { id: 'none',  label: 'None',      emoji: '🚫' },
    { id: 'frog',  label: 'Frog',      emoji: '🐸' },
    { id: 'noir',  label: 'Noir',      emoji: '🎬' },
    { id: 'vapor', label: 'Vaporwave', emoji: '🌴' },
    { id: 'dreamy',label: 'Dreamy',    emoji: '🌸' },
  ];
  const byId = id => FILTERS.find(f => f.id === id);

  // ── Persisted state ───────────────────────────────────────────────────────
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

  let activeId = lsGet('ft_call_filter', 'none');
  if (!byId(activeId)) activeId = 'none';

  // ── Pipeline objects ──────────────────────────────────────────────────────
  let srcTrack = null;      // current raw camera track feeding the pipeline
  let video = null;         // tiny on-screen <video> playing the raw track
  let canvas = null, ctx = null;
  let outStream = null;     // canvas.captureStream() — what we send + preview
  let rafId = 0;
  let rvfcId = 0;
  let running = false;
  let starting = false;
  let framesDrawn = 0;
  let watchdog = 0;
  let fallbackCb = null;    // calls.js sets this — revert to the raw track

  function isActive() { return activeId !== 'none'; }
  function canvasTrack() { return outStream ? (outStream.getVideoTracks()[0] || null) : null; }

  // ── Pipeline lifecycle ────────────────────────────────────────────────────
  function ensureVideo() {
    if (video) return;
    video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    // In-viewport but ~invisible: many Android WebViews stop decoding a video
    // that is display:none or parked far off-screen. 1×1 + near-zero opacity
    // keeps the decoder alive without being visible.
    video.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(video);
  }

  function ensureCanvas(w, h) {
    if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d', { alpha: false }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  async function startPipeline() {
    if (running || starting || !srcTrack) return;
    starting = true;
    try {
      ensureVideo();
      video.srcObject = new MediaStream([srcTrack]);
      try { await video.play(); } catch {}
      const s = (srcTrack.getSettings && srcTrack.getSettings()) || {};
      let w = video.videoWidth || s.width || 640;
      let h = video.videoHeight || s.height || 480;
      if (!video.videoWidth) {
        await new Promise(res => {
          const done = () => { video.removeEventListener('loadedmetadata', done); res(); };
          video.addEventListener('loadedmetadata', done);
          setTimeout(done, 1200);
        });
        w = video.videoWidth || w; h = video.videoHeight || h;
      }
      // Caller may have stopped/torn down while we awaited metadata.
      if (!srcTrack) return;
      ensureCanvas(w, h);
      framesDrawn = 0;
      try { paint(); } catch {}            // prime one frame
      try { outStream = canvas.captureStream(30); }
      catch (e) { console.warn('[CamFX] captureStream failed — staying on raw', e); triggerFallback(); return; }
      running = true;
      scheduleDraw();
      // Watchdog: if the canvas never produces real frames, fall back to raw.
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (running && (framesDrawn < 2 || !video.videoWidth)) {
          console.warn('[CamFX] no frames rendered — falling back to raw camera');
          triggerFallback();
        }
      }, 1500);
    } finally { starting = false; }
  }

  function stopPipeline() {
    running = false;
    clearTimeout(watchdog); watchdog = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (video && rvfcId && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(rvfcId); } catch {} }
    rvfcId = 0;
    if (video) { try { video.pause(); } catch {} video.srcObject = null; }
    if (outStream) { try { outStream.getTracks().forEach(t => t.stop()); } catch {} outStream = null; }
  }

  function triggerFallback() {
    stopPipeline();
    // Reset to 'none' so we don't retry the failing filter every frame/call.
    activeId = 'none'; lsSet('ft_call_filter', 'none');
    try { if (typeof fallbackCb === 'function') fallbackCb(); } catch (e) { console.warn(e); }
  }

  // ── Render loop (prefer requestVideoFrameCallback) ────────────────────────
  function scheduleDraw() {
    if (!running) return;
    if (video.requestVideoFrameCallback) {
      rvfcId = video.requestVideoFrameCallback(() => { tick(); scheduleDraw(); });
    } else {
      rafId = requestAnimationFrame(() => { tick(); scheduleDraw(); });
    }
  }
  function tick() {
    if (!running || !video || video.readyState < 2) return;
    try { paint(); } catch { try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch {} }
  }
  function paint() {
    const w = canvas.width, h = canvas.height;
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      switch (activeId) {
        case 'frog':  gradeFrog(w, h); break;
        case 'noir':  gradeNoir(w, h); break;
        case 'vapor': gradeVapor(w, h); break;
        case 'dreamy':gradeDreamy(w, h); break;
        default:      ctx.drawImage(video, 0, 0, w, h);
      }
      framesDrawn++;
    } finally { ctx.restore(); }
  }

  // ── Colour-grade filters (no ctx.filter — composite + fills only) ─────────
  function reset() { ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
  function vignette(w, h, color) {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.34, w / 2, h / 2, Math.max(w, h) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, color);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  function gradeFrog(w, h) {
    ctx.drawImage(video, 0, 0, w, h);
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = 'rgba(74,180,74,0.62)'; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = 'rgba(180,255,120,0.14)'; ctx.fillRect(0, 0, w, h);
    reset(); vignette(w, h, 'rgba(10,40,10,0.45)');
  }

  function gradeNoir(w, h) {
    ctx.drawImage(video, 0, 0, w, h);
    // Desaturate to B&W without ctx.filter: 'saturation' blend with a grey
    // source forces zero saturation across the frame.
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = 'hsl(0,0%,50%)'; ctx.fillRect(0, 0, w, h);
    // Slight punch: multiply a soft dark center-light vignette.
    reset(); vignette(w, h, 'rgba(0,0,0,0.6)');
  }

  function gradeVapor(w, h) {
    ctx.drawImage(video, 0, 0, w, h);
    ctx.globalCompositeOperation = 'soft-light';
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(255,84,201,0.6)');
    g.addColorStop(1, 'rgba(78,224,255,0.6)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    reset();
  }

  function gradeDreamy(w, h) {
    ctx.drawImage(video, 0, 0, w, h);
    // Cheap bloom (no blur filter): re-draw slightly enlarged at low alpha with
    // a lighten blend — soft halo around highlights.
    ctx.globalCompositeOperation = 'lighten';
    ctx.globalAlpha = 0.4;
    const dx = w * 0.02, dy = h * 0.02;
    ctx.drawImage(video, -dx, -dy, w + dx * 2, h + dy * 2);
    reset();
    // Warm pastel wash.
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = 'rgba(255,190,210,0.34)'; ctx.fillRect(0, 0, w, h);
    reset();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  // The video track calls.js should SEND for the given raw camera track —
  // the filtered canvas track when a filter is active, else the raw track.
  async function process(rawTrack) {
    srcTrack = rawTrack || null;
    if (!srcTrack) { if (running) stopPipeline(); return null; }
    if (isActive()) {
      if (!running) await startPipeline();
      return canvasTrack() || srcTrack;
    }
    if (running) stopPipeline();
    return srcTrack;
  }

  // Repoint the pipeline at a new raw track (camera flip) WITHOUT changing the
  // output track identity, so no renegotiation/replaceTrack is needed.
  function setSourceTrack(rawTrack) {
    const old = srcTrack;
    srcTrack = rawTrack || null;
    if (running && srcTrack && video) {
      video.srcObject = new MediaStream([srcTrack]);
      video.play().catch(() => {});
    }
    if (old && old !== srcTrack) { try { old.stop(); } catch {} }
  }

  // Stop the held raw camera track (frees the device) while keeping the canvas
  // pipeline alive — used by the camera flip on phones that can't open a second
  // camera while the first is held. setSourceTrack() resumes with the new one.
  function releaseSource() { try { if (srcTrack) srcTrack.stop(); } catch {} }

  // Change the active filter. Returns { trackChanged } — true when the sent
  // track identity flipped (none↔filter) so calls.js must replaceTrack.
  async function setFilter(id) {
    if (!byId(id)) id = 'none';
    activeId = id;
    lsSet('ft_call_filter', id);
    const wantPipeline = isActive() && !!srcTrack;
    let trackChanged = false;
    if (wantPipeline && !running) { await startPipeline(); trackChanged = !!canvasTrack(); }
    else if (!isActive() && running) { stopPipeline(); trackChanged = true; }
    return { trackChanged };
  }

  function outputTrack() { return running ? (canvasTrack() || srcTrack) : srcTrack; }
  function previewStream() { return running ? outStream : null; }
  function onFallback(cb) { fallbackCb = cb; }

  function stop() {
    stopPipeline();
    // When filtering, the raw camera track lives only here (not in the caller's
    // stream) — stop it so the camera/indicator actually turns off.
    try { if (srcTrack) srcTrack.stop(); } catch {}
    srcTrack = null;
  }

  window.CamFX = {
    filters: FILTERS.slice(),
    get activeFilter() { return activeId; },
    isActive, process, setSourceTrack, releaseSource, setFilter, outputTrack, previewStream,
    onFallback, stop,
  };
})();
