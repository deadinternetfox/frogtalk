/**
 * media-player.js — Custom FrogTalk media player for images, video, and audio
 */

const MediaPlayer = (() => {
  let _currentMedia = null;
  let _playlist = [];
  let _currentIndex = 0;

  // Initialize player overlay
  function init() {
    if (document.getElementById('media-player-overlay')) return;
    
    const overlay = document.createElement('div');
    overlay.id = 'media-player-overlay';
    overlay.className = 'media-player-overlay hidden';
    overlay.innerHTML = `
      <div class="media-player-backdrop" onclick="MediaPlayer.close()"></div>
      <div class="media-player-container">
        <div class="media-player-header">
          <div class="media-player-info">
            <div class="media-player-sender" id="mp-sender"></div>
            <div class="media-player-time" id="mp-time"></div>
          </div>
          <div class="media-player-actions">
            <button class="mp-btn" onclick="MediaPlayer.download()" data-tip="Download" data-tip-pos="bottom">⬇️</button>
            <button class="mp-btn" onclick="MediaPlayer.openExternal()" data-tip="Open in new tab" data-tip-pos="bottom">↗️</button>
            <button class="mp-btn mp-close" onclick="MediaPlayer.close()">✕</button>
          </div>
        </div>
        
        <div class="media-player-content" id="mp-content">
          <!-- Media content injected here -->
        </div>
        
        <div class="media-player-nav" id="mp-nav">
          <button class="mp-nav-btn" id="mp-prev" onclick="MediaPlayer.prev()">‹</button>
          <span id="mp-counter">1 / 1</span>
          <button class="mp-nav-btn" id="mp-next" onclick="MediaPlayer.next()">›</button>
        </div>
        
        <!-- Video/Audio controls bar -->
        <div class="media-player-controls hidden" id="mp-controls">
          <button class="mp-ctrl-btn" id="mp-play" onclick="MediaPlayer.togglePlay()">▶</button>
          <div class="mp-progress-wrap" onclick="MediaPlayer.seek(event)">
            <div class="mp-progress-bar" id="mp-progress"></div>
            <div class="mp-progress-buffer" id="mp-buffer"></div>
          </div>
          <span class="mp-time-display" id="mp-current">0:00</span>
          <span class="mp-time-sep">/</span>
          <span class="mp-time-display" id="mp-duration">0:00</span>
          <div class="mp-volume-wrap">
            <button class="mp-ctrl-btn" id="mp-mute" onclick="MediaPlayer.toggleMute()">🔊</button>
            <input type="range" id="mp-volume" min="0" max="1" step="0.1" value="1" oninput="MediaPlayer.setVolume(this.value)">
          </div>
          <button class="mp-ctrl-btn" id="mp-fullscreen" onclick="MediaPlayer.toggleFullscreen()">⛶</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    
    // Add styles
    addStyles();
    
    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (!_currentMedia) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    });
  }

  function addStyles() {
    if (document.getElementById('media-player-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'media-player-styles';
    style.textContent = `
      .media-player-overlay {
        position: fixed;
        inset: 0;
        z-index: 2000;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .media-player-overlay.hidden { display: none; }
      
      .media-player-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.95);
        cursor: pointer;
      }
      
      .media-player-container {
        position: relative;
        display: flex;
        flex-direction: column;
        max-width: 95vw;
        max-height: 95vh;
        border-radius: 12px;
        overflow: hidden;
        background: #0a0a0a;
        border: 1px solid #222;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      }
      
      .media-player-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: linear-gradient(180deg, rgba(0,0,0,0.8) 0%, transparent 100%);
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.2s;
      }
      .media-player-container:hover .media-player-header { opacity: 1; }
      
      .media-player-info { display: flex; flex-direction: column; gap: 2px; }
      .media-player-sender { font-weight: 600; color: #4caf50; font-size: 14px; }
      .media-player-time { color: #666; font-size: 12px; }
      
      .media-player-actions { display: flex; gap: 8px; }
      .mp-btn {
        width: 36px; height: 36px;
        background: rgba(255,255,255,0.1);
        border: none;
        border-radius: 50%;
        color: #e0e0e0;
        font-size: 16px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .mp-btn:hover { background: rgba(76, 175, 80, 0.3); }
      .mp-close { font-size: 18px; }
      .mp-close:hover { background: rgba(244, 67, 54, 0.4); color: #ff5555; }
      
      .media-player-content {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 300px;
        min-height: 200px;
        max-width: 90vw;
        max-height: 80vh;
      }
      .media-player-content img {
        max-width: 90vw;
        max-height: 80vh;
        object-fit: contain;
        border-radius: 4px;
      }
      .media-player-content video {
        max-width: 90vw;
        max-height: 70vh;
        object-fit: contain;
        background: #000;
      }
      .media-player-content audio {
        width: 400px;
        max-width: 90vw;
      }
      
      .media-player-nav {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 16px;
        padding: 12px;
        background: rgba(0,0,0,0.5);
      }
      .media-player-nav.single { display: none; }
      
      .mp-nav-btn {
        width: 40px; height: 40px;
        background: rgba(255,255,255,0.1);
        border: none;
        border-radius: 50%;
        color: #e0e0e0;
        font-size: 24px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
      }
      .mp-nav-btn:hover { background: #4caf50; color: #000; }
      .mp-nav-btn:disabled { opacity: 0.3; cursor: not-allowed; }
      .mp-nav-btn:disabled:hover { background: rgba(255,255,255,0.1); color: #e0e0e0; }
      
      #mp-counter { color: #888; font-size: 13px; min-width: 60px; text-align: center; }
      
      .media-player-controls {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        background: linear-gradient(0deg, rgba(0,0,0,0.9) 0%, transparent 100%);
        position: absolute;
        bottom: 40px;
        left: 0;
        right: 0;
        opacity: 0;
        transition: opacity 0.2s;
      }
      .media-player-controls.hidden { display: none; }
      .media-player-container:hover .media-player-controls { opacity: 1; }
      
      .mp-ctrl-btn {
        width: 32px; height: 32px;
        background: none;
        border: none;
        color: #e0e0e0;
        font-size: 18px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s;
      }
      .mp-ctrl-btn:hover { color: #4caf50; }
      
      .mp-progress-wrap {
        flex: 1;
        height: 6px;
        background: #333;
        border-radius: 3px;
        cursor: pointer;
        position: relative;
        overflow: hidden;
      }
      .mp-progress-bar {
        position: absolute;
        left: 0; top: 0; bottom: 0;
        background: #4caf50;
        width: 0;
        border-radius: 3px;
        transition: width 0.1s linear;
      }
      .mp-progress-buffer {
        position: absolute;
        left: 0; top: 0; bottom: 0;
        background: rgba(255,255,255,0.2);
        width: 0;
        border-radius: 3px;
      }
      
      .mp-time-display { color: #888; font-size: 12px; font-family: monospace; }
      .mp-time-sep { color: #444; font-size: 12px; }
      
      .mp-volume-wrap {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      #mp-volume {
        width: 60px;
        height: 4px;
        -webkit-appearance: none;
        background: #333;
        border-radius: 2px;
        cursor: pointer;
      }
      #mp-volume::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px; height: 12px;
        background: #4caf50;
        border-radius: 50%;
        cursor: pointer;
      }
      
      /* Audio-specific styling */
      .mp-audio-display {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        padding: 40px;
        min-width: 350px;
      }
      .mp-audio-icon {
        width: 80px; height: 80px;
        background: linear-gradient(135deg, #1a3a1a 0%, #0d1f0d 100%);
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 36px;
        animation: mp-pulse 2s ease-in-out infinite;
      }
      .mp-audio-icon.playing { animation-play-state: running; }
      .mp-audio-icon.paused { animation-play-state: paused; }
      
      @keyframes mp-pulse {
        0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.4); }
        50% { transform: scale(1.05); box-shadow: 0 0 20px 10px rgba(76, 175, 80, 0.1); }
      }
      
      .mp-audio-title { color: #e0e0e0; font-size: 16px; font-weight: 600; }
      .mp-audio-waveform {
        display: flex;
        align-items: center;
        gap: 3px;
        height: 40px;
      }
      .mp-wave-bar {
        width: 4px;
        background: #4caf50;
        border-radius: 2px;
        animation: mp-wave 1s ease-in-out infinite;
      }
      .mp-wave-bar:nth-child(1) { animation-delay: 0s; }
      .mp-wave-bar:nth-child(2) { animation-delay: 0.1s; }
      .mp-wave-bar:nth-child(3) { animation-delay: 0.2s; }
      .mp-wave-bar:nth-child(4) { animation-delay: 0.3s; }
      .mp-wave-bar:nth-child(5) { animation-delay: 0.4s; }
      
      @keyframes mp-wave {
        0%, 100% { height: 10px; }
        50% { height: 35px; }
      }
      
      /* Fullscreen mode */
      .media-player-overlay.fullscreen .media-player-container {
        max-width: 100vw;
        max-height: 100vh;
        border-radius: 0;
        border: none;
      }
      .media-player-overlay.fullscreen .media-player-content {
        max-width: 100vw;
        max-height: 100vh;
      }
      .media-player-overlay.fullscreen .media-player-content video {
        max-width: 100vw;
        max-height: calc(100vh - 100px);
      }
    `;
    document.head.appendChild(style);
  }

  function open(mediaEl, sender, time, allMedia = [], startTime = 0) {
    init();
    
    const overlay = document.getElementById('media-player-overlay');
    const content = document.getElementById('mp-content');
    const controls = document.getElementById('mp-controls');
    const nav = document.getElementById('mp-nav');
    
    // Get media URL and type
    let url, type;
    if (mediaEl.tagName === 'IMG') {
      url = mediaEl.src;
      type = 'image';
    } else if (mediaEl.tagName === 'VIDEO') {
      url = mediaEl.src;
      type = 'video';
    } else if (mediaEl.tagName === 'AUDIO') {
      url = mediaEl.src;
      type = 'audio';
    } else {
      return;
    }

    // If the caller didn't pass an explicit startTime, fall back to the
    // source element's own currentTime so opening a chat video into the
    // fullscreen player picks up where the inline embed left off.
    if ((!startTime || startTime <= 0)
        && (mediaEl.tagName === 'VIDEO' || mediaEl.tagName === 'AUDIO')
        && isFinite(mediaEl.currentTime) && mediaEl.currentTime > 0) {
      startTime = mediaEl.currentTime;
    }

    _currentMedia = { url, type, sender, time, startTime };
    _playlist = allMedia.length ? allMedia : [{ url, type, sender, time }];
    _currentIndex = _playlist.findIndex(m => m.url === url) || 0;
    
    // Set header info
    document.getElementById('mp-sender').textContent = sender || 'Unknown';
    document.getElementById('mp-time').textContent = time || '';
    
    // Render media
    renderMedia(type, url, startTime);
    
    // Show/hide navigation
    if (_playlist.length > 1) {
      nav.classList.remove('single');
      updateNav();
    } else {
      nav.classList.add('single');
    }
    
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function renderMedia(type, url, startTime = 0) {
    const content = document.getElementById('mp-content');
    const controls = document.getElementById('mp-controls');
    
    if (type === 'image') {
      content.innerHTML = `<img src="${url}" alt="Media" onclick="event.stopPropagation()">`;
      controls.classList.add('hidden');
    } else if (type === 'video') {
      content.innerHTML = `<video id="mp-video" src="${url}" onclick="MediaPlayer.togglePlay()"></video>`;
      controls.classList.remove('hidden');
      setupVideoControls(startTime);
    } else if (type === 'audio') {
      content.innerHTML = `
        <div class="mp-audio-display">
          <div class="mp-audio-icon paused" id="mp-audio-icon">🎵</div>
          <div class="mp-audio-title">Voice Message</div>
          <div class="mp-audio-waveform" id="mp-waveform">
            <div class="mp-wave-bar"></div>
            <div class="mp-wave-bar"></div>
            <div class="mp-wave-bar"></div>
            <div class="mp-wave-bar"></div>
            <div class="mp-wave-bar"></div>
          </div>
          <audio id="mp-audio" src="${url}"></audio>
        </div>
      `;
      controls.classList.remove('hidden');
      setupAudioControls();
    }
  }

  function setupVideoControls(startTime = 0) {
    const video = document.getElementById('mp-video');
    if (!video) return;

    // Resume from the inline chat embed's current position so the
    // fullscreen player picks up the same frame the user was watching.
    if (startTime && isFinite(startTime) && startTime > 0) {
      const seekToStart = () => {
        try { video.currentTime = startTime; } catch {}
        // Best-effort autoplay so the transition feels seamless. Falls
        // back to muted autoplay if the browser blocks audible playback.
        const p = video.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => { try { video.muted = true; video.play().catch(() => {}); } catch {} });
        }
      };
      if (video.readyState >= 1) seekToStart();
      else video.addEventListener('loadedmetadata', seekToStart, { once: true });
    }

    video.addEventListener('loadedmetadata', () => {
      document.getElementById('mp-duration').textContent = formatTime(video.duration);
    });
    
    video.addEventListener('timeupdate', () => {
      const progress = (video.currentTime / video.duration) * 100;
      document.getElementById('mp-progress').style.width = `${progress}%`;
      document.getElementById('mp-current').textContent = formatTime(video.currentTime);
    });
    
    video.addEventListener('play', () => {
      document.getElementById('mp-play').textContent = '⏸';
    });
    
    video.addEventListener('pause', () => {
      document.getElementById('mp-play').textContent = '▶';
    });
    
    video.addEventListener('ended', () => {
      document.getElementById('mp-play').textContent = '▶';
    });
    
    video.addEventListener('progress', () => {
      if (video.buffered.length > 0) {
        const buffered = (video.buffered.end(0) / video.duration) * 100;
        document.getElementById('mp-buffer').style.width = `${buffered}%`;
      }
    });
  }

  function setupAudioControls() {
    const audio = document.getElementById('mp-audio');
    const icon = document.getElementById('mp-audio-icon');
    const waveform = document.getElementById('mp-waveform');
    if (!audio) return;
    
    audio.addEventListener('loadedmetadata', () => {
      document.getElementById('mp-duration').textContent = formatTime(audio.duration);
    });
    
    audio.addEventListener('timeupdate', () => {
      const progress = (audio.currentTime / audio.duration) * 100;
      document.getElementById('mp-progress').style.width = `${progress}%`;
      document.getElementById('mp-current').textContent = formatTime(audio.currentTime);
    });
    
    audio.addEventListener('play', () => {
      document.getElementById('mp-play').textContent = '⏸';
      icon.classList.remove('paused');
      icon.classList.add('playing');
      waveform.style.animationPlayState = 'running';
    });
    
    audio.addEventListener('pause', () => {
      document.getElementById('mp-play').textContent = '▶';
      icon.classList.remove('playing');
      icon.classList.add('paused');
    });
    
    audio.addEventListener('ended', () => {
      document.getElementById('mp-play').textContent = '▶';
      icon.classList.remove('playing');
      icon.classList.add('paused');
    });
  }

  function togglePlay() {
    const video = document.getElementById('mp-video');
    const audio = document.getElementById('mp-audio');
    const media = video || audio;
    if (!media) return;
    
    if (media.paused) {
      media.play();
    } else {
      media.pause();
    }
  }

  function seek(event) {
    const video = document.getElementById('mp-video');
    const audio = document.getElementById('mp-audio');
    const media = video || audio;
    if (!media) return;
    
    const rect = event.currentTarget.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    media.currentTime = percent * media.duration;
  }

  function toggleMute() {
    const video = document.getElementById('mp-video');
    const audio = document.getElementById('mp-audio');
    const media = video || audio;
    if (!media) return;
    
    media.muted = !media.muted;
    document.getElementById('mp-mute').textContent = media.muted ? '🔇' : '🔊';
    document.getElementById('mp-volume').value = media.muted ? 0 : media.volume;
  }

  function setVolume(val) {
    const video = document.getElementById('mp-video');
    const audio = document.getElementById('mp-audio');
    const media = video || audio;
    if (!media) return;
    
    media.volume = val;
    media.muted = val == 0;
    document.getElementById('mp-mute').textContent = val == 0 ? '🔇' : '🔊';
  }

  function toggleFullscreen() {
    const overlay = document.getElementById('media-player-overlay');
    overlay.classList.toggle('fullscreen');
  }

  function updateNav() {
    document.getElementById('mp-counter').textContent = `${_currentIndex + 1} / ${_playlist.length}`;
    document.getElementById('mp-prev').disabled = _currentIndex === 0;
    document.getElementById('mp-next').disabled = _currentIndex === _playlist.length - 1;
  }

  function prev() {
    if (_currentIndex > 0) {
      _currentIndex--;
      const media = _playlist[_currentIndex];
      _currentMedia = media;
      document.getElementById('mp-sender').textContent = media.sender || 'Unknown';
      document.getElementById('mp-time').textContent = media.time || '';
      renderMedia(media.type, media.url);
      updateNav();
    }
  }

  function next() {
    if (_currentIndex < _playlist.length - 1) {
      _currentIndex++;
      const media = _playlist[_currentIndex];
      _currentMedia = media;
      document.getElementById('mp-sender').textContent = media.sender || 'Unknown';
      document.getElementById('mp-time').textContent = media.time || '';
      renderMedia(media.type, media.url);
      updateNav();
    }
  }

  function close() {
    const video = document.getElementById('mp-video');
    const audio = document.getElementById('mp-audio');
    if (video) video.pause();
    if (audio) audio.pause();
    
    const overlay = document.getElementById('media-player-overlay');
    overlay.classList.add('hidden');
    overlay.classList.remove('fullscreen');
    document.body.style.overflow = '';
    _currentMedia = null;
  }

  function download() {
    if (!_currentMedia) return;
    const a = document.createElement('a');
    a.href = _currentMedia.url;
    a.download = `frogtalk-media-${Date.now()}.${_currentMedia.type === 'image' ? 'png' : _currentMedia.type === 'video' ? 'mp4' : 'webm'}`;
    a.click();
  }

  function openExternal() {
    if (_currentMedia) window.open(_currentMedia.url, '_blank');
  }

  function formatTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    const mins = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${mins}:${s.toString().padStart(2, '0')}`;
  }

  return {
    init,
    open,
    close,
    togglePlay,
    seek,
    toggleMute,
    setVolume,
    toggleFullscreen,
    prev,
    next,
    download,
    openExternal
  };
})();

// Initialize on load
document.addEventListener('DOMContentLoaded', () => MediaPlayer.init());
