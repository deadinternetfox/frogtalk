/* ─── calls.js ─────────────────────────────────────────────────────────────── */
'use strict';

// STUN-only fallback used when `/api/network/ice-config` is unreachable.
// We never ship long-lived TURN credentials in JS — the operator-configured
// TURN bundle (with HMAC-rotated creds where supported) is delivered by the
// server at call time. Without that bundle, peers behind symmetric NAT will
// fail to connect; that's the right user-visible outcome rather than a
// silent fallback to shared shared-secret credentials embedded in every
// shipped build.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

let _iceConfigCache = { at: 0, key: '', servers: null };

/** Cached probe: Tor Browser / strict private tabs block RTCPeerConnection by design. */
let _webrtcCapCache = null;

function _webrtcCapability() {
  if (_webrtcCapCache) return _webrtcCapCache;
  const cap = { ok: false, reason: 'missing' };
  if (typeof RTCPeerConnection === 'undefined') {
    _webrtcCapCache = cap;
    return cap;
  }
  try {
    const probe = new RTCPeerConnection({ iceServers: [] });
    probe.close();
    cap.ok = true;
    cap.reason = '';
  } catch (e) {
    const msg = String(e?.message || e || '').toLowerCase();
    if (msg.includes('not allowed') || msg.includes('disabled') || msg.includes('blocked')) {
      cap.reason = 'browser_blocked';
    } else {
      cap.reason = 'error';
    }
  }
  _webrtcCapCache = cap;
  return cap;
}

/** User-facing explanation when WebRTC is unavailable (not a server fault). */
function _webrtcBlockedMessage() {
  const cap = _webrtcCapability();
  if (cap.ok) return '';
  if (cap.reason === 'browser_blocked') {
    return (
      'Calls are blocked here. Tor Browser, private tabs, and some privacy ' +
      'extensions disable WebRTC to protect your IP. Use a normal window or ' +
      'the FrogTalk app.'
    );
  }
  if (cap.reason === 'missing') {
    return 'This browser does not support WebRTC calls. Try Chrome, Firefox, or the FrogTalk app.';
  }
  return 'WebRTC is unavailable in this browser context.';
}

function _requireWebRtc() {
  const cap = _webrtcCapability();
  if (cap.ok) return true;
  toast(_webrtcBlockedMessage(), 'error');
  return false;
}

/** Play remote media; Safari often blocks autoplay until play() + user gesture retry. */
function _ensureMediaPlayback(el, label) {
  if (!el) return;
  // Respect an intentional mute (speaker-mute / per-peer mute). This keeper
  // runs on every track event and on reconnect; unconditionally forcing
  // muted=false here is what silently undid the speaker button the instant a
  // track arrived — the root cause of "speaker mute doesn't work".
  try { if (!(el.dataset && el.dataset.userMuted === '1')) el.muted = false; } catch {}
  try { el.volume = 1; } catch {}
  try {
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
  } catch {}
  const run = () => {
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.warn(`[calls] ${label || 'media'} play() blocked:`, err?.name || err);
        const retry = () => {
          el.play().catch(() => {});
          document.removeEventListener('click', retry, true);
          document.removeEventListener('touchend', retry, true);
        };
        document.addEventListener('click', retry, { once: true, capture: true });
        document.addEventListener('touchend', retry, { once: true, capture: true });
      });
    }
  };
  run();
}

/* ── Call-quality reception meter ───────────────────────────────────────────
 * Polls RTCPeerConnection.getStats() and maps round-trip-time, jitter and
 * incremental packet loss to a 0–4 bar reception meter beside the settings cog.
 * Cheap: one getStats() every 2.5s only while a call is active. */
function _setCallQuality(level) {
  const el = document.getElementById('call-quality');
  if (!el) return;
  const q = Math.max(0, Math.min(4, level | 0));
  el.classList.remove('cq-reconnect');
  el.dataset.q = String(q);
  el.classList.toggle('has-data', q > 0);
  el.querySelectorAll('.cq-bar').forEach((b, i) => b.classList.toggle('on', i < q));
  el.title = ['Connecting…', 'Poor connection', 'Weak connection', 'Good connection', 'Excellent connection'][q] || 'Connection quality';
}
function _setCallQualityReconnecting() {
  const el = document.getElementById('call-quality');
  if (!el) return;
  el.classList.add('has-data', 'cq-reconnect');
  el.querySelectorAll('.cq-bar').forEach(b => b.classList.remove('on'));
  el.title = 'Reconnecting…';
}
async function _sampleCallQuality() {
  if (!_pc || typeof _pc.getStats !== 'function' || _callState !== 'active') return;
  let stats;
  try { stats = await _pc.getStats(); } catch { return; }
  let rtt = null, jitter = 0, lost = 0, recv = 0, haveInbound = false;
  stats.forEach(r => {
    if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) {
      rtt = r.currentRoundTripTime;
    } else if (r.type === 'remote-inbound-rtp') {
      if (rtt == null && r.roundTripTime != null) rtt = r.roundTripTime;
      if (r.jitter != null) jitter = Math.max(jitter, r.jitter);
    } else if (r.type === 'inbound-rtp' && !r.isRemote) {
      haveInbound = true;
      if (r.packetsLost != null) lost += r.packetsLost;
      if (r.packetsReceived != null) recv += r.packetsReceived;
      if (r.jitter != null) jitter = Math.max(jitter, r.jitter);
    }
  });
  let lossFrac = 0;
  if (_cqPrev) {
    const dLost = Math.max(0, lost - _cqPrev.lost);
    const dRecv = Math.max(0, recv - _cqPrev.recv);
    if (dLost + dRecv > 0) lossFrac = dLost / (dLost + dRecv);
  }
  _cqPrev = { lost, recv };
  // First second of a fresh connection — no usable signal yet.
  if (rtt == null && !haveInbound) { _setCallQuality(0); return; }
  let level = 4;
  if (rtt != null) {
    const ms = rtt * 1000;
    if (ms > 500) level = Math.min(level, 1);
    else if (ms > 300) level = Math.min(level, 2);
    else if (ms > 180) level = Math.min(level, 3);
  }
  if (jitter > 0.06) level = Math.min(level, 2);
  else if (jitter > 0.03) level = Math.min(level, 3);
  if (lossFrac > 0.10) level = Math.min(level, 1);
  else if (lossFrac > 0.04) level = Math.min(level, 2);
  else if (lossFrac > 0.015) level = Math.min(level, 3);
  _setCallQuality(level);
}
function _startCallQualityMonitor() {
  _stopCallQualityMonitor();
  _cqPrev = null;
  _setCallQuality(0);
  if (!_pc) return;
  _sampleCallQuality();
  _callQualityTimer = setInterval(_sampleCallQuality, 2500);
}
function _stopCallQualityMonitor() {
  if (_callQualityTimer) { clearInterval(_callQualityTimer); _callQualityTimer = null; }
  _cqPrev = null;
  const el = document.getElementById('call-quality');
  if (el) {
    el.classList.remove('has-data', 'cq-reconnect');
    el.dataset.q = '0';
    el.querySelectorAll('.cq-bar').forEach(b => b.classList.remove('on'));
    el.title = 'Connection quality';
  }
}

function _mediaStreamFromTrackEvent(e, existing) {
  if (e?.streams?.[0]) return e.streams[0];
  const track = e?.track;
  if (!track) return existing || null;
  const base = (existing && typeof existing.getTracks === 'function') ? existing : new MediaStream();
  if (![...base.getTracks()].some(t => t.id === track.id)) {
    try { base.addTrack(track); } catch {}
  }
  return base;
}

function _formatCallSetupError(e) {
  const msg = String(e?.message || e || '');
  if (/RTCPeerConnection/i.test(msg) && /not allowed|disabled|blocked/i.test(msg)) {
    return _webrtcBlockedMessage();
  }
  return 'Call setup failed: ' + (msg || 'unknown error');
}

let _callSetupToastAt = 0;
function _toastCallSetupError(msg) {
  const now = Date.now();
  console.error(msg);
  if (now - _callSetupToastAt < 120_000) return;
  _callSetupToastAt = now;
  try { toast(msg, 'error'); } catch {}
}

/** Per-node TURN from GET /api/network/ice-config (local + optional peer home). */
function _toastCallTamper(msg) {
  const now = Date.now();
  console.error(msg);
  if (now - _callTamperToastAt < 120_000) return;
  _callTamperToastAt = now;
  try { toast(msg, 'error'); } catch {}
}

async function _applyLocalOffer(pc, offerOpts) {
  const offer = await pc.createOffer(offerOpts || {});
  try {
    await pc.setLocalDescription(offer);
    return offer;
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (!/does not match|InvalidModification/i.test(msg)) throw e;
    const retry = await pc.createOffer(offerOpts || {});
    await pc.setLocalDescription(retry);
    return retry;
  }
}

async function buildIceServers(peerServerId) {
  const key = String(peerServerId || '');
  const now = Date.now();
  if (_iceConfigCache.servers && _iceConfigCache.key === key && now - _iceConfigCache.at < 300000) {
    return _iceConfigCache.servers;
  }
  try {
    const q = key ? `?peer_server_id=${encodeURIComponent(key)}` : '';
    const r = await apiFetch(`/api/network/ice-config${q}`);
    if (r.ok) {
      const d = await r.json();
      const servers = (Array.isArray(d.ice_servers) && d.ice_servers.length) ? d.ice_servers : ICE_SERVERS;
      _iceConfigCache = { at: now, key, servers };
      const hasTurn = servers.some(s => {
        const u = s && s.urls;
        const list = Array.isArray(u) ? u : [u];
        return list.some(v => typeof v === 'string' && (v.startsWith('turn:') || v.startsWith('turns:')));
      });
      if (!hasTurn && typeof toast === 'function') {
        // Don't spam the user — the warning fires at most once per cache window.
        try {
          toast('Call routing limited: no TURN server configured on this node.', 'warn', 4500);
        } catch {}
      }
      return servers;
    }
  } catch (e) {
    console.warn('buildIceServers failed', e);
  }
  return ICE_SERVERS;
}

let _pc           = null;   // RTCPeerConnection
let _localStream  = null;
let _screenStream = null;
let _callState    = 'idle'; // idle | calling | ringing | active
let _callType     = 'voice';
let _callPeerNick = null;
let _callPeerUID  = null;
let _callPeerGid  = '';
let _callId       = null;
let _callTimer    = null;
let _callSeconds  = 0;
let _mutedAudio   = false;
let _mutedVideo   = false;
let _speakerMuted = false;
let _callQualityTimer = null;
let _cqPrev = null;
let _callRingTimeout = null;
let _startCallInFlight = false;
let _callTamperToastAt = 0;
let _reconnectTimer = null;
let _callPeerAvatar = null;
let _callGlobalId = null;
let _peerHomeServerId = '';
// ── Native screen-share receive state ──────────────────────────────────────
// A peer (currently only the Android native shell) can push their screen over
// a SEPARATE one-way PeerConnection that joins the active call via screen_*
// signaling. We answer on _screenPc and render into the dedicated #screen tile,
// leaving the main call PC (_pc) and #remote-video untouched.
let _screenPc = null;            // inbound screen RTCPeerConnection (we answer)
let _screenActive = false;       // a remote screen is being displayed
let _screenFromUid = null;       // uid of the peer sharing (the call peer)
let _screenPendingIce = [];      // ICE buffered until screen remote-desc applied
let _screenRemoteDescApplied = false;
let _nativeScreenSharing = false; // we (Android) are sharing our screen natively
// Inbound ICE candidates that arrive before setRemoteDescription resolves
// would throw on addIceCandidate and be lost forever. Buffer them and drain
// once the remote description is applied.
let _pendingIceQueue = [];
let _remoteDescApplied = false;
// Hard cap: if the call is in 'active' (answer applied) but the PC never
// reaches connectionState='connected' within this many ms, attempt one
// relay-only restart, then give up.
let _connectingHardCap = null;
let _didRelayRetry = false;
// Buffered call_answer SDP for callees on flaky WS — replayed on reconnect.
let _pendingAnswerSend = null;
let _pendingAnswerRetryTimer = null;
// When the user taps the OS notification's "Accept" button BEFORE the WS
// call_offer has arrived, acceptCall() can't run yet (no _pendingOffer). We
// remember the intent and auto-accept the moment the offer lands.
let _autoAcceptPending = false;
const _voiceOutboundQueue = [];

// Outbound buffer for call signaling that fires before the WS reaches OPEN
// (cold-start callees gather ICE while the socket is still in CONNECTING).
// wsSend()/WS.send() silently no-op in that window, so without this buffer
// the callee's local ICE candidates are lost forever — producing the
// "connected but stuck on Connecting…" deadlock.
const _outboundCallQueue = [];
// ICE gathered before the server assigns call_id (call_created) is dropped
// server-side — buffer until we have ids, then flush.
const _preCallIdIceQueue = [];
function _wsLooksOpen() {
  try { return (typeof WS !== 'undefined' && typeof WS.isOpen === 'function') ? WS.isOpen() : true; }
  catch { return true; }
}

/** Stable peer routing for WS call.* — travel nodes must send global_user_id. */
function _callPeerRoutingFields() {
  let gid = '';
  try {
    const ch = (typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels))
      ? _dmChannels.find(c => String(c.nickname || '').toLowerCase() === String(_callPeerNick || '').toLowerCase())
      : null;
    gid = String(
      _callPeerGid
      || _activeDM?.global_user_id || _activeDM?.peer_global_user_id
      || ch?.global_user_id || ch?.other_global_user_id || '',
    ).trim();
  } catch {}
  const out = {
    to_nickname: _callPeerNick || undefined,
    to_id: _callPeerUID || undefined,
  };
  if (gid) out.to_global_user_id = gid;
  if (_callGlobalId) out.global_call_id = _callGlobalId;
  return out;
}

function _sendCallSignal(payload) {
  if (!payload) return;
  if (_wsLooksOpen()) {
    try { wsSend(payload); return; } catch {}
  }
  _outboundCallQueue.push(payload);
  // Cap so a stuck socket can't grow this unbounded.
  if (_outboundCallQueue.length > 128) _outboundCallQueue.splice(0, _outboundCallQueue.length - 128);
}
function _flushOutboundCallQueue() {
  if (!_outboundCallQueue.length) return;
  if (!_wsLooksOpen()) return;
  while (_outboundCallQueue.length) {
    const msg = _outboundCallQueue.shift();
    try { wsSend(msg); } catch { /* dropped: peer can recover via ICE-restart */ }
  }
}
function _queueIceUntilCallId(candidate) {
  if (!candidate || !_callPeerNick) return;
  _preCallIdIceQueue.push({
    type: 'ice_candidate',
    ..._callPeerRoutingFields(),
    candidate: JSON.stringify(candidate),
  });
  if (_preCallIdIceQueue.length > 64) _preCallIdIceQueue.splice(0, _preCallIdIceQueue.length - 64);
}
function _flushPreCallIdIce() {
  if (!_callId || !_preCallIdIceQueue.length) return;
  while (_preCallIdIceQueue.length) {
    const msg = _preCallIdIceQueue.shift();
    msg.call_id = _callId;
    if (_callGlobalId) msg.global_call_id = _callGlobalId;
    _sendCallSignal(msg);
  }
}
function _sendVoiceSignal(payload) {
  if (!payload) return;
  if (_wsLooksOpen()) {
    try { wsSend(payload); return; } catch {}
  }
  _voiceOutboundQueue.push(payload);
  if (_voiceOutboundQueue.length > 128) _voiceOutboundQueue.splice(0, _voiceOutboundQueue.length - 128);
}
function _flushVoiceOutboundQueue() {
  if (!_voiceOutboundQueue.length) return;
  if (!_wsLooksOpen()) return;
  while (_voiceOutboundQueue.length) {
    const msg = _voiceOutboundQueue.shift();
    try { wsSend(msg); } catch {}
  }
}
async function _bestEffortRefreshSignalBundle() {
  try {
    if (!window.Signal || !Signal.isReady?.()) return;
    await Promise.race([
      Signal.ensureMyBundleFresh(),
      new Promise(resolve => setTimeout(resolve, 2500)),
    ]);
  } catch {}
}
// Resolve when WS reaches OPEN (or timeout). Used by startCall so we don't
// fire call_offer into a half-dead socket and leave the user staring at a
// 45 s ringing screen for nothing.
function _waitForWsOpen(timeoutMs) {
  return new Promise(resolve => {
    if (_wsLooksOpen()) { resolve(true); return; }
    let done = false;
    const finish = (ok) => { if (done) return; done = true; window.removeEventListener('ws:open', onOpen); clearTimeout(t); resolve(ok); };
    const onOpen = () => finish(true);
    window.addEventListener('ws:open', onOpen, { once: true });
    const t = setTimeout(() => finish(_wsLooksOpen()), Math.max(250, timeoutMs | 0));
  });
}

function _joinedRoomsList() {
  try {
    return Array.isArray(State?.rooms)
      ? State.rooms.filter(r => r && r.joined && r.type !== 'dm')
      : [];
  } catch { return []; }
}

function _pickCallBootstrapRoom() {
  try {
    if (State?.currentRoom && State.currentRoomType !== 'dm') {
      const cur = _joinedRoomsList().find(r => r.name === State.currentRoom);
      if (cur?.name) return String(cur.name);
    }
  } catch {}
  try {
    const lastRaw = localStorage.getItem('fc_last_room');
    if (lastRaw) {
      const last = JSON.parse(lastRaw);
      const lastName = String(last?.name || '').trim();
      if (lastName) {
        const match = _joinedRoomsList().find(r => r.name === lastName);
        if (match?.name) return lastName;
      }
    }
  } catch {}
  const joined = _joinedRoomsList();
  if (joined[0]?.name) return String(joined[0].name);
  // DM-only users: bootstrap WS on the peer DM pseudo-room (same path as switchToRoom).
  try {
    const nick = State?.user?.nickname;
    const peer = _callPeerNick;
    if (nick && peer) {
      const sorted = [String(nick), String(peer)].sort();
      return `dm:${sorted.join(':')}`;
    }
  } catch {}
  // Never fall back to "general" — unjoined rooms get WS 4003 and _room is
  // cleared with no auto-reconnect, leaving call_answer/ICE permanently stuck.
  return '';
}

async function _ensureRoomsLoadedForCalls() {
  if (_joinedRoomsList().length) return true;
  try {
    if (typeof Rooms !== 'undefined' && typeof Rooms.loadRooms === 'function') {
      await Rooms.loadRooms();
    }
  } catch (e) {
    console.warn('[calls] loadRooms before signaling failed', e);
  }
  return _joinedRoomsList().length > 0;
}

async function ensureCallSignalingReady(opts) {
  const timeoutMs = Math.max(1000, Number(opts?.timeoutMs || 15000) || 15000);
  if (_wsLooksOpen()) return true;
  await _ensureRoomsLoadedForCalls();
  // Native recovery can beat Rooms.loadRooms() on cold boot — wait briefly
  // so bootstrap picks a joined channel, not a stale fc_last_room that
  // closes with 4003 and never auto-reconnects.
  if (!_joinedRoomsList().length) {
    const roomsDeadline = Date.now() + Math.min(8000, timeoutMs);
    while (!_joinedRoomsList().length && Date.now() < roomsDeadline) {
      await new Promise(r => setTimeout(r, 100));
      if (!_joinedRoomsList().length) await _ensureRoomsLoadedForCalls();
    }
  }
  try {
    const room = String(opts?.room || _pickCallBootstrapRoom()).trim();
    if (!room) return false;
    if (typeof WS !== 'undefined' && typeof WS.connect === 'function') {
      WS.connect(room);
    }
  } catch {}
  try { await _waitForWsOpen(timeoutMs); } catch {}
  return _wsLooksOpen();
}

function isCallSessionBusy() {
  try {
    return _callState === 'ringing' || _callState === 'calling' || _callState === 'active'
      || !!_acceptInFlight || !!_pendingAnswerSend;
  } catch { return false; }
}
try {
  window.addEventListener('ws:open', () => {
    // Tiny delay so wsSend() sees readyState=OPEN.
    setTimeout(() => {
      _flushOutboundCallQueue();
      _flushVoiceOutboundQueue();
      if (_pendingAnswerSend) {
        try {
          if (_wsLooksOpen()) {
            wsSend(_pendingAnswerSend);
            _pendingAnswerSend = null;
            clearTimeout(_pendingAnswerRetryTimer);
          }
        } catch {}
      }
    }, 0);
  });
} catch {}

/* ── Track E — DTLS fingerprint signing helpers ────────────────────────────
 *
 * Defends call setup against a malicious signalling server splicing its own
 * DTLS fingerprint into the SDP and bridging the media. We sign the
 * fingerprint with our Signal identity key (see signal.js
 * signCallFingerprint / verifyCallFingerprint) and travel the envelope
 * opaquely on the existing call_offer / call_answer WS frames as `fp_sig`.
 *
 * - On outbound offer/answer we sign {call_id, peer_user_id, fp} where
 *   peer_user_id is the *recipient*.
 * - On inbound we extract the remote SDP's `a=fingerprint:sha-256 ...`,
 *   pull the caller's identity_pub out-of-band (Signal.getPeerIdentityKey),
 *   then verify the envelope.
 * - Missing fp_sig (legacy peer) → proceed but flag the call as UNVERIFIED.
 * - Verify failure → toast "signalling tampering detected" and end the call.
 */
let _callUnverified = false;

function _extractDtlsFp(sdp) {
  try {
    const m = String(sdp || '').match(/a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)/);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

async function _signCallFp(callId, peerUserId, sdp, peerGlobalUserId) {
  try {
    if (!window.Signal || !Signal.isReady?.()) return '';
    if (!peerUserId && !peerGlobalUserId) return '';
    if (callId === undefined || callId === null || callId === '') return '';
    const fp = _extractDtlsFp(sdp);
    if (!fp) return '';
    let gid = String(peerGlobalUserId || '').trim();
    if (!gid && peerUserId) {
      try {
        const ch = (typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels))
          ? _dmChannels.find(c => Number(c.with_user_id || c.other_id || 0) === Number(peerUserId))
          : null;
        gid = String(ch?.other_global_user_id || ch?.global_user_id || ch?.peer_global_user_id || '').trim();
      } catch {}
    }
    if (!gid && _callPeerNick && typeof apiFetch === 'function') {
      try {
        const rp = await apiFetch('/api/users/profile/' + encodeURIComponent(_callPeerNick));
        if (rp.ok) {
          const u = await rp.json();
          gid = String(u.global_user_id || '').trim();
        }
      } catch {}
    }
    const payload = {
      call_id: callId,
      peer_user_id: peerUserId || 0,
      fingerprint_sha256: fp,
    };
    if (gid) payload.peer_global_user_id = gid;
    return await Signal.signCallFingerprint(payload);
  } catch (e) {
    console.warn('[calls] _signCallFp failed', e);
    return '';
  }
}

// Returns:
//   { ok: true }                              → verified, safe to apply SDP
//   { ok: 'unverified', reason }              → no fp_sig from peer; proceed but warn
//   { ok: false, reason }                     → tampering detected; ABORT call
async function _verifyCallFp(envelope, callId, fromId, sdp, opts) {
  if (!envelope) return { ok: 'unverified', reason: 'no_envelope' };
  if (!window.Signal || !Signal.isReady?.()) {
    return { ok: 'unverified', reason: 'signal_unavailable' };
  }
  const myId = (typeof State !== 'undefined' && State.user?.id) || 0;
  if (!myId || !fromId) return { ok: 'unverified', reason: 'missing_ids' };
  const fp = _extractDtlsFp(sdp);
  if (!fp) return { ok: 'unverified', reason: 'no_fp_in_sdp' };

  const federated = !!(opts?.federated || opts?.originServerId);
  // The signed envelope carries the *signer's* local numeric call_id, which is
  // the DB row id on their node. Across federated nodes the same call has a
  // DIFFERENT local id on each side (only global_call_id matches), so binding
  // expectedCallId to our local id guarantees a spurious 'call_id_mismatch' —
  // a FATAL verify reason that tears the call down the instant the answer
  // arrives. Never bind the local call_id for federated calls; the Ed25519
  // signature over {fingerprint, identity, peer} still prevents tampering.
  const bindCallId = !(opts && opts.bindCallId === false) && !federated;
  const keysServerId = String(
    opts?.keysServerId || opts?.originServerId || opts?.peerHomeServerId || _peerHomeServerId || '',
  ).trim();
  const myGid = String((typeof State !== 'undefined' && State.user?.global_user_id) || '').trim();

  let expectedIdentityPub = null;
  try {
    expectedIdentityPub = await Signal.getPeerIdentityKey(fromId, {
      noCache: federated,
      keysServerId,
      peerHomeServerId: keysServerId,
    });
  } catch {}
  if (!expectedIdentityPub && keysServerId) {
    try {
      expectedIdentityPub = await Signal.getPeerIdentityKey(fromId, { noCache: true });
    } catch {}
  }
  if (!expectedIdentityPub) {
    // Federated travel keys may 404 from the local bundle proxy — still verify
    // the Ed25519 signature against env.i embedded in the envelope.
    if (federated && envelope) {
      try {
        const laneOpts = {
          expectedFingerprint: fp,
          skipIdentityPin: true,
          skipPeerUserId: true,
          federated: true,
        };
        if (myGid) laneOpts.expectedPeerGlobalUserId = myGid;
        if (bindCallId) laneOpts.expectedCallId = Number(callId);
        const sigRes = await Signal.verifyCallFingerprint(envelope, laneOpts);
        if (sigRes && sigRes.ok) {
          return { ok: 'unverified', reason: 'identity_lane_mismatch' };
        }
        if (sigRes && _isVerifyFatal(sigRes.reason)) {
          return { ok: false, reason: sigRes.reason };
        }
      } catch {}
    }
    return { ok: 'unverified', reason: 'no_peer_identity' };
  }

  const buildVopts = (extra) => {
    const vopts = {
      expectedFingerprint: fp,
      expectedIdentityPub,
      federated,
      ...(extra || {}),
    };
    if (myGid) {
      vopts.expectedPeerGlobalUserId = myGid;
      vopts.skipPeerUserId = true;
    } else if (!federated && myId) {
      vopts.expectedPeerUserId = Number(myId);
    }
    if (bindCallId) {
      vopts.expectedCallId = Number(callId);
    }
    return vopts;
  };

  const _tryVerify = async (extra) => {
    try {
      return await Signal.verifyCallFingerprint(envelope, buildVopts(extra));
    } catch {
      return { ok: false, reason: 'verify_threw' };
    }
  };

  try {
    let res = await _tryVerify();
    if (res && res.ok) return { ok: true };

    if (res && res.reason === 'identity_mismatch') {
      try {
        if (typeof Signal.invalidatePeerCrypto === 'function') {
          await Signal.invalidatePeerCrypto(fromId);
        }
        const freshIdentity = await Signal.getPeerIdentityKey(fromId, {
          noCache: true,
          keysServerId,
          peerHomeServerId: keysServerId,
        });
        if (freshIdentity && freshIdentity !== expectedIdentityPub) {
          expectedIdentityPub = freshIdentity;
          res = await _tryVerify();
          if (res && res.ok) return { ok: true };
        }
      } catch {}
    }

    // Federated / travel-node calls: home bundle may not match the signing
    // key embedded in the envelope. Verify signature + fingerprint binding
    // against env.i instead of refusing the call.
    if (federated && res && (res.reason === 'identity_mismatch' || res.reason === 'peer_mismatch'
        || res.reason === 'stale')) {
      const sigRes = await _tryVerify({
        skipIdentityPin: true,
        skipPeerUserId: true,
        expectedIdentityPub: undefined,
        expectedPeerUserId: undefined,
        expectedPeerGlobalUserId: myGid || undefined,
        federated: true,
      });
      if (sigRes && sigRes.ok) {
        if (res.reason === 'stale') {
          console.warn('[calls][track-E] federated fp stale but signature ok — proceeding unverified');
          return { ok: 'unverified', reason: 'stale_federated' };
        }
        if (res.reason === 'peer_mismatch') {
          console.warn('[calls][track-E] federated peer bind relaxed — signature ok');
          return { ok: 'unverified', reason: 'peer_id_unbound' };
        }
        console.warn('[calls][track-E] federated identity lane mismatch — signature ok');
        return { ok: 'unverified', reason: 'identity_lane_mismatch' };
      }
    }

    if (res && res.reason === 'peer_mismatch') {
      let envPeerGid = '';
      try {
        const raw = JSON.parse(atob(String(envelope || '')));
        const payload = JSON.parse(String(raw.p || '{}'));
        envPeerGid = String(payload.peer_global_user_id || '').trim();
      } catch {}
      if (myGid && !envPeerGid) {
        console.warn('[calls][track-E] peer_mismatch without GID — proceeding unverified');
        return { ok: 'unverified', reason: 'peer_id_unbound' };
      }
    }

    if (res && (res.reason === 'bad_signature' || res.reason === 'fingerprint_mismatch'
        || res.reason === 'call_id_mismatch')) {
      return { ok: false, reason: res.reason };
    }
    if (res && res.reason === 'verify_threw') {
      return { ok: 'unverified', reason: 'verify_threw' };
    }
    return { ok: 'unverified', reason: (res && res.reason) || 'unknown' };
  } catch {
    return { ok: 'unverified', reason: 'verify_threw' };
  }
}

function _isVerifyFatal(reason) {
  // Hard-fail reasons mean a real signalling tamper, not an absence of
  // signing material. Cross-node lane mismatches downgrade to unverified.
  return reason === 'bad_signature'
      || reason === 'fingerprint_mismatch'
      || reason === 'call_id_mismatch';
}

function _isResolvedAvatar(avatar) {
  const value = String(avatar || '').trim();
  return !!value && value !== '🐸';
}

async function _ensureCallPeerAvatar(forceRender = false) {
  const safeNick = String(_callPeerNick || '').trim();
  if (!safeNick) return _callPeerAvatar;

  if (_isResolvedAvatar(_callPeerAvatar)) {
    if (forceRender) _renderPeerAvatar(safeNick, _callPeerAvatar);
    return _callPeerAvatar;
  }

  if (_activeDM?.nickname === safeNick && _isResolvedAvatar(_activeDM?.avatar)) {
    _callPeerAvatar = _activeDM.avatar;
  }

  if (!_isResolvedAvatar(_callPeerAvatar) && typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels)) {
    const dm = _dmChannels.find(ch => String(ch?.nickname || '').trim() === safeNick && _isResolvedAvatar(ch?.avatar));
    if (dm?.avatar) _callPeerAvatar = dm.avatar;
  }

  if (!_isResolvedAvatar(_callPeerAvatar) && typeof apiFetch === 'function') {
    try {
      const response = await apiFetch('/api/users/profile/' + encodeURIComponent(safeNick));
      if (response.ok) {
        const profile = await response.json();
        if (_isResolvedAvatar(profile?.avatar)) _callPeerAvatar = profile.avatar;
      }
    } catch {}
  }

  if (forceRender || _isResolvedAvatar(_callPeerAvatar)) {
    _renderPeerAvatar(safeNick, _callPeerAvatar);
  }
  return _callPeerAvatar;
}

function _renderPeerAvatar(peerNick, avatar) {
  const ra = document.getElementById('call-remote-avatar');
  if (!ra) return;
  const safeNick = String(peerNick || _callPeerNick || 'Peer').trim() || 'Peer';
  const avatarData = avatar !== undefined ? avatar : _callPeerAvatar;
  if (typeof UI !== 'undefined' && typeof UI.avatarEl === 'function') {
    ra.innerHTML = UI.avatarEl(avatarData || null, safeNick, 96);
  } else {
    // Fallback: render simple avatar with initial. The peer nickname /
    // avatar arrive across the federation trust boundary — always
    // ``esc()`` them before innerHTML to neutralize any HTML smuggled by
    // a hostile remote node.
    const s = String(avatarData || '');
    const isUrl = s.startsWith('data:image/') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/');
    const escNick = esc(safeNick.charAt(0).toUpperCase());
    if (s && isUrl) {
      ra.innerHTML = `<img src="${esc(s)}" alt="">`;
    } else if (s) {
      ra.innerHTML = `<span class="call-avatar-emoji">${esc(s.slice(0, 2))}</span>`;
    } else {
      ra.innerHTML = `<div class="call-avatar-initial">${escNick}</div>`;
    }
  }
}

function _persistIncomingCall(offer) {
  try {
    const callId = String(offer?.call_id || '').trim();
    if (!callId) return;
    localStorage.setItem('ft_pending_incoming_call', JSON.stringify({
      callId,
      peerNick: String(offer?.from_nickname || '').trim(),
      ts: Date.now(),
    }));
  } catch {}
}

function _clearPersistedIncomingCall() {
  try { localStorage.removeItem('ft_pending_incoming_call'); } catch {}
}

let _incomingMediaPrewarmAt = 0;
async function _prewarmIncomingMediaPermission(callType) {
  const now = Date.now();
  if (now - _incomingMediaPrewarmAt < 30000) return;
  _incomingMediaPrewarmAt = now;
  try {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const constraints = callType === 'video'
      ? { audio: true, video: true }
      : { audio: true };
    const s = await navigator.mediaDevices.getUserMedia(constraints);
    try { s.getTracks().forEach(t => t.stop()); } catch {}
  } catch {}
}

/* ── Initiate call ─────────────────────────────────────────────────────────── */
async function startCall (type, nick, uid) {
  if (_startCallInFlight) return;
  if (_callState !== 'idle') { toast('Already in a call', 'error'); return; }
  if (!_requireWebRtc()) return;
  _startCallInFlight = true;
  try {
  await _startCallBody(type, nick, uid);
  } finally {
    _startCallInFlight = false;
  }
}

async function _startCallBody (type, nick, uid) {
  _callType     = type;
  _callPeerNick = nick  || STATE.dmPeerNick;
  _callPeerUID  = uid   || _activeDM?.user_id;
  _callPeerAvatar = _activeDM?.avatar || null;
  _callId       = null;
  if (!_callPeerNick) {
    // Usually means they tapped call outside a DM. Phrase it so it actually
    // points at the cause instead of confusing "no peer connected" language.
    toast('Open a direct message to start a call', 'error');
    return;
  }
  // Paint the call overlay immediately so pressing "call" feels instant. The
  // WS reconnect wait, peer-id resolution and getUserMedia below all run
  // behind the "Calling…" screen instead of blocking before any UI appears.
  _callState = 'calling';
  showCallOverlay(type, _callPeerNick, 'Calling…', _callPeerAvatar);
  // If WS is mid-reconnect, give it a brief window to come back so the
  // call_offer rides a live socket. Don't abort if it's still not open —
  // _sendCallSignal() buffers into _outboundCallQueue and ws:open flushes,
  // so the dial still works once the socket finishes its handshake.
  if (!_wsLooksOpen()) {
    try { await _waitForWsOpen(8_000); } catch {}
  }
  if (!_callPeerUID && _callPeerNick) {
    try {
      const ch = (typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels))
        ? _dmChannels.find(c => String(c.nickname || '').toLowerCase() === String(_callPeerNick).toLowerCase())
        : null;
      if (ch?.with_user_id) _callPeerUID = ch.with_user_id;
    } catch {}
  }
  // _activeDM carries the federated peer's home server when the DM is
  // cross-node — feed it into the ICE config so RTC negotiates with the
  // peer's TURN as well as ours. Cleared on every fresh startCall so we
  // don't reuse a stale id from a previous call.
  const _dmChanForCall = (typeof _dmChannels !== 'undefined' && Array.isArray(_dmChannels))
    ? _dmChannels.find(c => String(c.nickname || '').toLowerCase() === String(_callPeerNick || '').toLowerCase())
    : null;
  _peerHomeServerId = String(
    _activeDM?.peer_home_server_id || _dmChanForCall?.peer_home_server_id || '',
  );
  _callPeerGid = String(
    _activeDM?.global_user_id || _activeDM?.peer_global_user_id
    || _dmChanForCall?.global_user_id || _dmChanForCall?.other_global_user_id || '',
  ).trim();
  if (_callPeerNick && (!_peerHomeServerId || !_callPeerGid || !_callPeerUID)) {
    try {
      const rp = await apiFetch('/api/users/profile/' + encodeURIComponent(_callPeerNick));
      if (rp.ok) {
        const u = await rp.json();
        const sid = String(u.peer_home_server_id || u.home_server_id || '').trim();
        if (sid) _peerHomeServerId = sid;
        if (u.id && !_callPeerUID) _callPeerUID = u.id;
        if (u.global_user_id) _callPeerGid = String(u.global_user_id || '').trim();
      }
    } catch {}
  }
  await _ensureCallPeerAvatar();

  try {
    _localStream = await navigator.mediaDevices.getUserMedia(
      type === 'video' ? { audio: true, video: true } : { audio: true }
    );
  } catch (e) {
    console.error('getUserMedia failed', e);
    toast('Microphone/camera permission denied', 'error');
    resetCall();
    closeCallOverlay();
    return;
  }

  // Now that we hold mic/cam permission, it is safe to start the native
  // foreground-service call notification on Android 14+.
  _startAndroidCallNotification(_callPeerNick);
  await _bestEffortRefreshSignalBundle();

  try {
    if (type === 'video') {
      const lv = document.getElementById('local-video');
      const la = document.getElementById('call-local-avatar');
      if (lv) { lv.srcObject = _localStream; lv.style.display = ''; }
      if (la) la.style.display = 'none';
    }

    _pc = await createPC();
    _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

    const offer = await _applyLocalOffer(_pc);

    // Track E: sign DTLS fingerprint with our Signal identity. Caller
    // doesn't know call_id yet (server assigns) so we sign with call_id=0
    // as a sentinel — the server-side `pending_call_offers.fp_sig`
    // passthrough preserves the envelope verbatim and the callee's
    // verifier downgrades to "unverified" if it can't bind a call_id.
    // (A future tweak: re-sign on call_created with the real id.)
    const fp_sig = await _signCallFp(0, _callPeerUID || 0, offer.sdp, _callPeerGid);

    _maybeWarnIdentityRotation(_callPeerUID);

    _sendCallSignal({
      type: 'call_offer',
      ..._callPeerRoutingFields(),
      to_global_user_id: _callPeerGid || _callPeerRoutingFields().to_global_user_id,
      call_type: type,
      sdp: offer.sdp,
      fp_sig: fp_sig || undefined,
    });

    // Auto-cancel if the callee never answers — prevents the "Calling…"
    // overlay from hanging forever when the other end is offline or ignores.
    clearTimeout(_callRingTimeout);
    _callRingTimeout = setTimeout(() => {
      if (_callState === 'calling') {
        toast(_callPeerNick + ' did not answer');
        endCall();
      }
    }, 45_000);
  } catch (e) {
    // Any WebRTC / signaling failure should NOT crash the whole app.
    console.error('startCall setup failed', e);
    _toastCallSetupError(_formatCallSetupError(e));
    endCall();
  }
}

/* ── Called from friends panel shortcut ────────────────────────────────────── */
async function callNick (nick, type) {
  await openDMWithNick(nick);
  // startCall paints the overlay instantly and waits for the WS itself, so
  // there's no need for an artificial pre-dial delay here.
  startCall(type, nick);
}

/* ── Receive offer (incoming) ──────────────────────────────────────────────── */
async function handleCallOffer (data) {
  // Mid-call renegotiation from the same peer (camera turned on, screen-share, etc.)
  if (data.renegotiate && _callState === 'active' && _pc) {
    const okCall = data.call_id && _callId && String(data.call_id) === String(_callId);
    const okNick = data.from_nickname === _callPeerNick;
    const okUid = !data.from_id || !_callPeerUID || Number(data.from_id) === Number(_callPeerUID);
    if ((okCall || okNick) && okUid) {
      try {
        const peerHome = String(data.peer_home_server_id || data.origin_server_id || '').trim();
        if (peerHome) _peerHomeServerId = peerHome;
        const ice = await buildIceServers(_peerHomeServerId || '');
        if (data.force_relay) {
          try { _pc.setConfiguration({ iceServers: ice, iceTransportPolicy: 'relay' }); } catch {}
        } else {
          try { _pc.setConfiguration({ iceServers: ice }); } catch {}
        }
        await _pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const ans = await _pc.createAnswer();
        await _pc.setLocalDescription(ans);
        const renegFp = await _signCallFp(
          data.call_id || _callId || 0,
          _callPeerUID || data.from_id || 0,
          ans.sdp,
          _callPeerGid || data.from_global_user_id || '',
        );
        _sendCallSignal({
          type: 'call_answer',
          ..._callPeerRoutingFields(),
          call_id: data.call_id,
          sdp: ans.sdp,
          renegotiate: true,
          fp_sig: renegFp || undefined,
        });
      } catch (e) { console.warn('renegotiate answer failed', e); }
      return;
    }
    if (okCall) return;
  }
  if (_callState !== 'idle') {
    // Same call we're already on: drop silently. The caller's live WS push
    // and our REST recovery both deliver the same offer to a cold-started
    // client — without this, the second arrival triggers call_reject(busy)
    // and the caller hangs up while we're still ringing/active.
    if (data.call_id && _callId && String(data.call_id) === String(_callId)) {
      if (_callState === 'ringing') ensureIncomingCallSurfaceVisible();
      return;
    }
    _sendCallSignal({ type: 'call_reject', to_nickname: data.from_nickname, reason: 'busy' });
    return;
  }
  _callState    = 'ringing';
  _callType     = data.call_type || 'voice';
  _callPeerNick = data.from_nickname;
  _callPeerUID  = data.from_id || _callPeerUID;
  _callPeerGid  = String(data.from_global_user_id || data.peer_global_user_id || _callPeerGid || '').trim();
  _callPeerAvatar = data.from_avatar || null;
  _callId       = data.call_id || null;
  _callGlobalId = data.global_call_id || _callGlobalId;
  // Track the caller's home server so createPC's ICE config merges the
  // remote TURN bundle. Without this federated calls only attempted the
  // local node's TURN and lost cross-region NAT traversal.
  _peerHomeServerId = String(data.peer_home_server_id || data.origin_server_id || '');
  if (data.federated) toast('Incoming call from another node', 'info');
  _pendingOffer = { sdp: data.sdp, call_id: data.call_id || null, from_id: data.from_id, fp_sig: data.fp_sig };
  // Ring + popup immediately so Frog Social / FrogChannel / any view still
  // gets Accept/Decline even while Signal verification runs in the background.
  _persistIncomingCall(data);
  showIncomingCall(data.from_nickname, data.call_type, data.from_avatar || null);
  void _prewarmIncomingMediaPermission(data.call_type || 'voice');
  try { Notifications.startRinging(data.from_nickname); } catch {}
  try {
    if (window.desktopApp?.showNotification) {
      const label = (data.call_type === 'video') ? 'video' : 'voice';
      window.desktopApp.showNotification('📞 Incoming call', `${data.from_nickname || 'Someone'} is calling (${label})`);
    }
  } catch {}
  // Native tray ring only while the WebView is visible. When backgrounded,
  // FCM posts the incoming-call notification — ringForCall here duplicates it.
  try {
    if (
      document.visibilityState === 'visible' &&
      window.Android &&
      typeof window.Android.ringForCall === 'function'
    ) {
      window.Android.ringForCall(String(data.from_nickname || ''), String(data.call_id || ''));
    }
  } catch {}
  // Track E: verify caller's signed DTLS fingerprint envelope (async after UI).
  let verifyFatal = false;
  try {
    _callUnverified = false;
    const v = await _verifyCallFp(data.fp_sig, data.call_id, data.from_id, data.sdp, {
      bindCallId: false,
      federated: !!(data.federated || data.origin_server_id),
      originServerId: String(data.origin_server_id || data.peer_home_server_id || '').trim(),
    });
    if (v.ok === false && _isVerifyFatal(v.reason)) {
      verifyFatal = true;
      _toastCallTamper('Signalling tampering detected (' + v.reason + ') — call refused');
      console.error('[calls][track-E] inbound offer rejected:', v.reason);
      _sendCallSignal({ type: 'call_reject', to_nickname: data.from_nickname, call_id: data.call_id || undefined, reason: 'tampering' });
    } else if (v.ok !== true) {
      _callUnverified = true;
      console.warn('[calls][track-E] inbound offer UNVERIFIED:', v.reason);
    }
  } catch (e) {
    console.warn('[calls][track-E] verify offer threw', e);
    _callUnverified = true;
  }
  if (verifyFatal) {
    try { hideIncomingCall(); } catch {}
    try { Notifications.stopRinging(); } catch {}
    _pendingOffer = null;
    _callState = 'idle'; _callPeerNick = null; _callPeerUID = null; _callId = null;
    _clearPersistedIncomingCall();
    return;
  }
  _maybeWarnIdentityRotation(_callPeerUID);
  // Auto-accept if the user already tapped the notification's Accept button
  // before this WS offer arrived. Skip the incoming-call UI entirely.
  if (_autoAcceptPending) {
    _autoAcceptPending = false;
    setTimeout(() => { try { acceptCall(); } catch {} }, 0);
  }
}

let _pendingOffer = null;
let _acceptInFlight = false;

async function acceptCall () {
  _clearPersistedIncomingCall();
  hideIncomingCall();
  try { Notifications.stopRinging(); } catch {}
  try { window.Android?.dismissRing?.(); } catch {}
  // Re-entrancy guard. Cold-start-from-notification can trigger acceptCall
  // twice (once via _autoAcceptPending, once via the user tapping the
  // in-app accept button) and the second invocation would race the first's
  // `finally { _pendingOffer = null }` and crash on `_pendingOffer.sdp`.
  if (_acceptInFlight) return;
  if (!_pendingOffer?.sdp) {
    // Offer hasn't landed yet (notification tap raced ahead of the WS
    // call_offer push). Queue the intent so it auto-accepts on arrival.
    _autoAcceptPending = true;
    return;
  }
  if (!_requireWebRtc()) return;
  _acceptInFlight = true;
  // Snapshot so a concurrent reset/finally can't null it out from under
  // the awaits below.
  const offer = _pendingOffer;
  await _ensureRoomsLoadedForCalls();
  const wsReady = await ensureCallSignalingReady({ timeoutMs: 15000 });
  if (!wsReady) {
    toast('Could not connect to signaling — please try again', 'error');
    endCall(true, { wasConnected: false });
    return;
  }
  await _ensureCallPeerAvatar();
  showCallOverlay(_callType, _callPeerNick, 'Connecting…', _callPeerAvatar);
  _callState = 'calling';

  try {
    _localStream = await navigator.mediaDevices.getUserMedia(
      _callType === 'video' ? { audio: true, video: true } : { audio: true }
    );
  } catch (e) {
    console.error('getUserMedia (accept) failed', e);
    toast('Microphone/camera permission denied', 'error');
    endCall(true, { wasConnected: false });
    return;
  }

  // Permission granted — safe to start the native call notification now.
  _startAndroidCallNotification(_callPeerNick);

  try {
    _pc = await createPC();
    _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

    await _pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    _remoteDescApplied = true;
    _flushPendingIce();
    const answer = await _pc.createAnswer();
    await _pc.setLocalDescription(answer);

    await _bestEffortRefreshSignalBundle();
    const answerCallId = offer.call_id || _callId || 0;
    const peerUid = _callPeerUID || offer.from_id || 0;
    const fp_sig = await _signCallFp(answerCallId, peerUid, answer.sdp, _callPeerGid);

    _sendCallAnswerReliable({
      type: 'call_answer',
      ..._callPeerRoutingFields(),
      to_id: peerUid || _callPeerRoutingFields().to_id,
      call_id: offer.call_id || _callId || undefined,
      sdp: answer.sdp,
      fp_sig: fp_sig || undefined,
    });
    _callState = 'active';
    _armConnectingHardCap();

    // Open the DM thread after answer is queued — don't block signaling on
    // /api/dms/open while launch() may still be switching channels/WS.
    try {
      if (_callPeerNick && typeof openDMWithNick === 'function') {
        if (!_activeDM || _activeDM.nickname !== _callPeerNick) {
          void openDMWithNick(_callPeerNick).catch(() => {});
        }
      }
    } catch {}

    if (_callType === 'video') {
      const lv = document.getElementById('local-video');
      const la = document.getElementById('call-local-avatar');
      if (lv) { lv.srcObject = _localStream; lv.style.display = ''; }
      if (la) la.style.display = 'none';
    }
  } catch (e) {
    console.error('acceptCall setup failed', e);
    _toastCallSetupError(_formatCallSetupError(e));
    endCall(true, { wasConnected: false });
    return;
  } finally {
    _pendingOffer = null;
    _acceptInFlight = false;
  }
}

function rejectCall () {
  _clearPersistedIncomingCall();
  _sendCallSignal({
    type: 'call_reject',
    ..._callPeerRoutingFields(),
    call_id: _callId || undefined,
    reason: 'declined',
  });
  hideIncomingCall();
  try { Notifications.stopRinging(); } catch {}
  try { window.Android?.dismissRing?.(); } catch {}
  resetCall();
}

/* ── Call created confirmation (server sends call_id back to caller) ────────── */
async function handleCallCreated (data) {
  if (!data) return;
  if (data.call_id && (_callState === 'calling' || !_callId)) {
    _callId = data.call_id;
  }
  // Track the callee's home server announced by our local node so the
  // caller's createPC merges that node's TURN bundle on any later
  // ICE-restart. Falls back to whatever startCall pinned from the DM row.
  const peerHome = String(data.peer_home_server_id || data.callee_home_server_id || '');
  if (peerHome) _peerHomeServerId = peerHome;
  if (data.global_call_id) _callGlobalId = data.global_call_id;
  if (peerHome) {
    try {
      const ice = await buildIceServers(_peerHomeServerId);
      const pc = _pc;
      if (!pc || typeof pc.setConfiguration !== 'function') return;
      const pol = pc.getConfiguration?.()?.iceTransportPolicy;
      pc.setConfiguration({ iceServers: ice, iceTransportPolicy: pol || 'all' });
    } catch (e) { console.warn('refresh ICE after call_created failed', e); }
  }
  if (data.federated) {
    try { toast('Calling peer on another node…', 'info'); } catch {}
  }
  _flushPreCallIdIce();
}

/* ── Receive answer ────────────────────────────────────────────────────────── */
async function handleCallAnswer (data) {
  if (!_pc) return;
  clearTimeout(_callRingTimeout); _callRingTimeout = null;
  // Pick up the peer's home server id if the answer includes it. Useful
  // for ICE-restart paths where we re-call buildIceServers after the
  // initial setRemoteDescription so the relay set stays in sync.
  if (data && (data.peer_home_server_id || data.origin_server_id)) {
    _peerHomeServerId = String(data.peer_home_server_id || data.origin_server_id || _peerHomeServerId);
  }
  // Track E: verify callee's signed DTLS fingerprint envelope against the
  // SDP we're about to apply. For same-node calls the callee signs with the
  // shared call_id so it's bound here; for federated calls the local ids
  // differ per node, so _verifyCallFp skips the call_id binding (otherwise a
  // structural 'call_id_mismatch' would fatally end every cross-node call).
  // Fatal verify reasons → tear down before the DTLS handshake can start.
  try {
    const callIdForVerify = data.call_id || _callId || 0;
    const fromIdForVerify = data.from_id || _callPeerUID || 0;
    const v = await _verifyCallFp(data.fp_sig, callIdForVerify, fromIdForVerify, data.sdp, {
      federated: !!(data.federated || data.origin_server_id),
      originServerId: String(data.origin_server_id || data.peer_home_server_id || _peerHomeServerId || '').trim(),
    });
    if (v.ok === false && _isVerifyFatal(v.reason)) {
      _toastCallTamper('Signalling tampering detected (' + v.reason + ') — call ended');
      console.error('[calls][track-E] inbound answer rejected:', v.reason);
      endCall();
      return;
    }
    if (v.ok !== true) {
      _callUnverified = true;
      console.warn('[calls][track-E] inbound answer UNVERIFIED:', v.reason);
    }
  } catch (e) { console.warn('[calls][track-E] verify answer threw', e); _callUnverified = true; }
  try {
    await _pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    _remoteDescApplied = true;
    _flushPendingIce();
  } catch (e) {
    console.warn('setRemoteDescription (answer) failed', e);
    // Don't silently swallow — the call is dead.
    toast('Call setup failed (answer)', 'error');
    endCall();
    return;
  }
  // Mid-call renegotiation answer — don't change state / status text.
  if (data.renegotiate) return;
  _callId = data.call_id || _callId;
  _callState = 'active';
  _armConnectingHardCap();
  // Caller side: ensure DM opens if answer happened while user is elsewhere.
  try {
    if (_callPeerNick && typeof openDMWithNick === 'function') {
      if (!_activeDM || _activeDM.nickname !== _callPeerNick) {
        openDMWithNick(_callPeerNick);
      }
    }
  } catch {}
  try { Notifications.stopRinging(); } catch {}
  startCallTimer();
  const st = document.getElementById('call-status-text');
  if (st) st.textContent = 'Connected';
}

/* ── ICE candidates ────────────────────────────────────────────────────────── */
async function handleIceCandidate (data) {
  if (!_pc || !data.candidate) return;
  let parsed;
  try { parsed = JSON.parse(data.candidate); } catch { return; }
  // Buffer until setRemoteDescription is applied — otherwise addIceCandidate
  // throws and the candidate is lost forever, which is the #1 cause of
  // "answered but stuck on Connecting…" on cold-start callees.
  if (!_remoteDescApplied) {
    _pendingIceQueue.push(parsed);
    return;
  }
  try { await _pc.addIceCandidate(parsed); } catch (e) {
    // Late-arriving candidates after a relay restart routinely fail and are
    // non-fatal — keep silent.
  }
}

async function _flushPendingIce () {
  if (!_pc || !_pendingIceQueue.length) return;
  const queue = _pendingIceQueue.slice();
  _pendingIceQueue.length = 0;
  for (const c of queue) {
    try { await _pc.addIceCandidate(c); } catch {}
  }
}

function _armConnectingHardCap () {
  clearTimeout(_connectingHardCap);
  _connectingHardCap = setTimeout(async () => {
    if (!_pc) return;
    const s = _pc.connectionState;
    if (s === 'connected' || _callState !== 'active') return;
    // Still not connected after 30 s of being 'active'. Try one relay-only
    // restart — forces TURN, which resolves carrier-NAT / firewall blocks
    // that prevent direct paths from ever completing.
    if (!_didRelayRetry && _pc.restartIce) {
      _didRelayRetry = true;
      console.warn('[calls] connecting hard-cap hit — forcing ICE restart (relay)');
      try {
        const ice = await buildIceServers(_peerHomeServerId || '');
        try { _pc.setConfiguration({ iceServers: ice, iceTransportPolicy: 'relay' }); } catch {}
        _pc.restartIce();
        const offer = await _pc.createOffer({ iceRestart: true });
        await _pc.setLocalDescription(offer);
        const restartFp = await _signCallFp(_callId || 0, _callPeerUID || 0, offer.sdp, _callPeerGid);
        _sendCallSignal({
          type: 'call_offer',
          ..._callPeerRoutingFields(),
          call_id: _callId || undefined,
          call_type: _callType,
          sdp: offer.sdp,
          renegotiate: true,
          force_relay: true,
          fp_sig: restartFp || undefined,
        });
        // Give the relay attempt another 20 s before giving up entirely.
        setTimeout(() => {
          if (_pc && _pc.connectionState !== 'connected' && _callState === 'active') {
            toast('Could not establish connection — your network may be blocking calls', 'error');
            endCall();
          }
        }, 20_000);
        return;
      } catch (e) { console.warn('relay restart failed', e); }
    }
    toast('Could not establish connection', 'error');
    endCall();
  }, 30_000);
}

function _callSignalMatchesSession(data) {
  if (!data?.call_id || !_callId) return true;
  return String(data.call_id) === String(_callId);
}

/* ── Remote rejected ───────────────────────────────────────────────────────── */
function handleCallReject (data) {
  if (!_callSignalMatchesSession(data)) return;
  _clearPersistedIncomingCall();
  _callId = data?.call_id || _callId;
  const who = data?.from_nickname || _callPeerNick || 'User';
  toast(who + ' declined the call');
  endCall(false);
}

function handleCallError(data) {
  const reason = String(data?.reason || '').trim();
  if (!reason) {
    toast('Call failed', 'error');
    endCall(false);
    return;
  }
  if (reason === 'peer_offline') {
    toast((_callPeerNick || 'User') + ' is offline right now — trying push ring', 'info');
    return;
  }
  if (reason === 'busy') {
    toast((_callPeerNick || 'User') + ' is busy', 'info');
  } else if (reason === 'user_not_found') {
    toast('Could not find that user', 'error');
  } else if (reason === 'federation_route_failed' || reason === 'no_callee_route') {
    toast('Cannot reach that user across nodes — check you are friends and both nodes are online, then try again.', 'error', 8000);
  } else if (reason === 'not_friends') {
    toast('Cross-node calls require being friends — add them on this node or wait for sync to finish.', 'error', 8000);
  } else if (reason === 'blocked') {
    toast('Call blocked', 'error');
  } else if (reason === 'tampering') {
    toast('Call blocked: signalling verification failed', 'error');
  } else {
    toast('Call failed: ' + reason, 'error');
  }
  endCall(false);
}

/* ── Call handled elsewhere (this user accepted/declined on another session) ─ */
function handleCallHandled (data) {
  // Only act if we are currently in the ringing-incoming state (or have an
  // incoming-call UI persisted). This prevents stale events from disrupting
  // an active call.
  try { _clearPersistedIncomingCall(); } catch {}
  try { Notifications.stopRinging(); } catch {}
  try { window._ringtoneCtx?.stop?.(); } catch {}
  window._ringtoneCtx = null;
  try { window.Android?.dismissRing?.(); } catch {}
  // If we were in the ringing-incoming state on this session, hide the UI
  // and reset. If we are mid-active-call (e.g. accepted here), do nothing.
  if (_callState === 'ringing') {
    try { hideIncomingCall(); } catch {}
    try { resetCall(); } catch {}
  } else {
    // Even if state isn't 'ringing-incoming', forcibly hide any leftover
    // incoming-call card so a stuck UI clears.
    try {
      const el = document.getElementById('incoming-call');
      if (el && !el.classList.contains('hidden')) {
        el.classList.add('hidden');
        try { resetCall(); } catch {}
      }
    } catch {}
  }
}
try { window.handleCallHandled = handleCallHandled; } catch {}

/* ── Remote ended ──────────────────────────────────────────────────────────── */
function handleCallEnd (data) {
  if (!_callSignalMatchesSession(data)) return;
  _clearPersistedIncomingCall();
  _callId = data?.call_id || _callId;
  const wasRinging = _callState === 'ringing';
  const wasCalling = _callState === 'calling';
  const who = _callPeerNick || data?.from_nickname || 'Someone';
  if (wasRinging) {
    toast(`📵 Missed call from ${who}`, 'info');
    try {
      if (window.Android?.showNotification) {
        const label = (_callType === 'video') ? 'video' : 'voice';
        window.Android.showNotification('📵 Missed call', `Missed ${label} call from ${who}`);
      }
    } catch {}
    try {
      if (window.desktopApp?.showNotification) {
        const label = (_callType === 'video') ? 'video' : 'voice';
        window.desktopApp.showNotification('📵 Missed call', `Missed ${label} call from ${who}`);
      }
    } catch {}
  } else if (wasCalling) {
    toast(who + ' did not answer', 'info');
  } else {
    toast('Call ended');
  }
  endCall(false);
}

/* ── End call ──────────────────────────────────────────────────────────────── */
function endCall (notifyPeer = true, opts) {
  if (notifyPeer) {
    const forced = opts && typeof opts.wasConnected === 'boolean' ? opts.wasConnected : null;
    const wasConnected = forced === null
      ? (_callState === 'active') || ((_callSeconds | 0) > 0)
      : forced;
    const durationSecs = (_callSeconds | 0) > 0 ? (_callSeconds | 0) : undefined;
    try {
      _sendCallSignal({
        type: 'call_end',
        ..._callPeerRoutingFields(),
        call_id: _callId || undefined,
        was_connected: wasConnected,
        duration_seconds: durationSecs,
      });
    } catch {}
  }
  try { hideIncomingCall(); } catch {}
  try { closeCallOverlay(); } catch (e) { console.warn('closeCallOverlay failed', e); }
  resetCall();
}

// Buffered send for the callee's `call_answer`. Aggressive Android doze and
// brief network blips routinely drop the WS between accept-tap and the
// outbound answer; the global wsSend() silently no-ops when the socket is
// not OPEN, leaving the caller stuck on "Ringing…". This retries every
// 500 ms for up to 10 s until the message actually goes out.
function _sendCallAnswerReliable (payload) {
  clearTimeout(_pendingAnswerRetryTimer);
  _pendingAnswerSend = payload;
  const deadline = Date.now() + 20_000;
  let lastReconnectAt = 0;
  const attempt = () => {
    if (!_pendingAnswerSend) return;
    const open = (typeof WS !== 'undefined' && typeof WS.isOpen === 'function')
      ? WS.isOpen() : true;
    if (open) {
      try { wsSend(_pendingAnswerSend); _pendingAnswerSend = null; return; } catch {}
    } else {
      const now = Date.now();
      if (now - lastReconnectAt > 2000) {
        lastReconnectAt = now;
        try {
          if (typeof WS !== 'undefined' && typeof WS.connect === 'function') {
            WS.connect(_pickCallBootstrapRoom());
          }
        } catch {}
      }
    }
    if (Date.now() >= deadline) {
      _pendingAnswerSend = null;
      console.warn('[calls] could not deliver call_answer within 20 s — giving up');
      toast('Could not connect — please try again', 'error');
      endCall();
      return;
    }
    _pendingAnswerRetryTimer = setTimeout(attempt, 500);
  };
  attempt();
}

function resetCall () {
  try {
    if (_pc) {
      try {
        _pc.onicecandidate = null;
        _pc.ontrack = null;
        _pc.onconnectionstatechange = null;
        _pc.oniceconnectionstatechange = null;
        _pc.getSenders?.().forEach(s => { try { s.replaceTrack(null); } catch {} });
        _pc.close();
      } catch {}
      _pc = null;
    }
    if (_localStream) { try { _localStream.getTracks().forEach(t => t.stop()); } catch {} _localStream = null; }
    if (_screenStream) { try { _screenStream.getTracks().forEach(t => t.stop()); } catch {} _screenStream = null; }
    // Tear down both directions of native screen share: the inbound _screenPc
    // (remote sharing to us) and our own native capture (if we were sharing).
    try { _teardownScreen(); } catch {}
    if (_nativeScreenSharing) {
      try { window.Android && window.Android.stopScreenShare && window.Android.stopScreenShare(); } catch {}
      _nativeScreenSharing = false;
    }
    clearInterval(_callTimer); _callTimer = null; _callSeconds = 0;
    clearTimeout(_callRingTimeout); _callRingTimeout = null;
    clearTimeout(_reconnectTimer); _reconnectTimer = null;
    clearTimeout(_connectingHardCap); _connectingHardCap = null;
    clearTimeout(_pendingAnswerRetryTimer); _pendingAnswerRetryTimer = null;
    _pendingAnswerSend = null;
    _pendingIceQueue.length = 0;
    _preCallIdIceQueue.length = 0;
    _outboundCallQueue.length = 0;
    _voiceOutboundQueue.length = 0;
    _remoteDescApplied = false;
    _callUnverified = false;
    _didRelayRetry = false;
    _autoAcceptPending = false;
    _callState = 'idle'; _callPeerNick = null; _callPeerUID = null; _callPeerGid = '';
    _callId = null; _callGlobalId = '';
    _callPeerAvatar = null;
    _mutedAudio = false; _mutedVideo = false; _speakerMuted = false;
    try { _stopVAD(); } catch {}
    try { _stopCallQualityMonitor(); } catch {}
    const rv = document.getElementById('remote-video');
    const remoteAudio = document.getElementById('remote-audio');
    const lv = document.getElementById('local-video');
    if (rv) {
      rv.srcObject = null;
      rv.style.display = 'none';
      rv.classList.remove('ft-remote-audio-sink');
      try { rv.muted = false; rv.dataset.userMuted = '0'; } catch {}
    }
    if (remoteAudio) {
      remoteAudio.srcObject = null;
      try { remoteAudio.muted = false; remoteAudio.dataset.userMuted = '0'; } catch {}
    }
    const _spkBtn = document.getElementById('btn-call-speaker');
    if (_spkBtn) { _spkBtn.textContent = '🔊'; _spkBtn.classList.remove('muted'); _spkBtn.title = 'Speaker'; }
    if (lv) { lv.srcObject = null; lv.style.display = 'none'; }
    // Show avatars again
    const ra = document.getElementById('call-remote-avatar');
    const la = document.getElementById('call-local-avatar');
    if (ra) ra.style.display = '';
    if (la) la.style.display = '';
    const tm = document.getElementById('call-timer'); if (tm) tm.textContent = '';
    // Tear down the minimized call pill alongside the overlay.
    document.getElementById('call-minibar')?.classList.remove('active');
    const mtm = document.getElementById('call-mini-timer'); if (mtm) mtm.textContent = '00:00';
    document.getElementById('call-tile-remote')?.classList.remove('speaking');
    document.getElementById('call-tile-local')?.classList.remove('speaking');
    const bMute = document.getElementById('btn-call-mute');
    if (bMute) { bMute.textContent = '🎤'; bMute.classList.remove('muted'); }
    try { _syncCamButton(); } catch {}
    try { _syncMiniScreenButton(); } catch {}
    try { window.Android?.dismissRing?.(); } catch {}
    try { window.Android?.endCallNotification?.(); } catch {}
    // If launch() skipped WS.connect while a call was active, resync now.
    try {
      const room = State?.currentRoom;
      if (room && State?.currentRoomType !== 'dm' && typeof WS !== 'undefined' && WS.connect) {
        WS.connect(room);
      }
    } catch {}
  } catch (e) {
    console.warn('resetCall error (non-fatal)', e);
  }
}

/* ── RTCPeerConnection factory ─────────────────────────────────────────────── */
async function createPC () {
  const ice = await buildIceServers(_peerHomeServerId || '');
  const pc = new RTCPeerConnection({ iceServers: ice });

  pc.onicecandidate = e => {
    if (!e.candidate || !_callPeerNick) return;
    if (!_callId) {
      _queueIceUntilCallId(e.candidate);
      return;
    }
    _sendCallSignal({
      type: 'ice_candidate',
      ..._callPeerRoutingFields(),
      call_id: _callId,
      candidate: JSON.stringify(e.candidate),
    });
  };

  pc.ontrack = e => {
    try {
      const rv = document.getElementById('remote-video');
      const ra = document.getElementById('call-remote-avatar');
      const raSink = document.getElementById('remote-audio');
      if (!rv && !raSink) return;

      const stream = _mediaStreamFromTrackEvent(e, rv?.srcObject || null);
      if (rv && stream) rv.srcObject = stream;

      if (e.track?.kind === 'video') {
        if (rv) {
          rv.classList.remove('ft-remote-audio-sink');
          rv.style.display = '';
        }
        if (ra) ra.style.display = 'none';
        _ensureMediaPlayback(rv, 'call-remote-video');
      } else if (e.track?.kind === 'audio') {
        // WebKit won't play audio through display:none <video> (voice calls).
        if (rv) {
          rv.classList.add('ft-remote-audio-sink');
          rv.style.removeProperty('display');
        }
        if (raSink) {
          raSink.srcObject = stream;
          _ensureMediaPlayback(raSink, 'call-remote-audio');
        }
        _ensureMediaPlayback(rv, 'call-remote-video-audio');
      }

      if (e.track?.kind === 'audio' && stream) _startRemoteVAD(stream);
    } catch (err) {
      console.warn('ontrack failed', err);
    }
  };

  pc.onconnectionstatechange = () => {
    try {
      const s = pc.connectionState;
      const st = document.getElementById('call-status-text');
      if (s === 'connected') {
        _callState = 'active';
        _ensureCallPeerAvatar(true).catch(() => {});
        startCallTimer();
        if (st) st.textContent = 'Connected';
        _ensureMediaPlayback(document.getElementById('remote-video'), 'call-connected');
        _ensureMediaPlayback(document.getElementById('remote-audio'), 'call-connected-audio');
        // Clear any pending reconnect timer — we're back.
        clearTimeout(_reconnectTimer); _reconnectTimer = null;
        // Always show cam — user can enable mid-call. Screen-share button only
        // where getDisplayMedia exists (not the Android WebView).
        const bCam = document.getElementById('btn-call-cam');
        if (bCam) bCam.style.display = '';
        _applyScreenShareButtonVisibility();
        _startLocalVAD();
        _startCallQualityMonitor();
      } else if (s === 'disconnected') {
        // Transient network hiccup — give ICE 15s to recover before tearing down.
        if (st) st.textContent = 'Reconnecting…';
        try { _setCallQualityReconnecting(); } catch {}
        clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => {
          if (_pc && (_pc.connectionState === 'disconnected' || _pc.connectionState === 'failed')) {
            toast('Connection lost'); endCall();
          }
        }, 15_000);
      } else if (s === 'failed' || s === 'closed') {
        if (_callState === 'active' || _callState === 'calling') {
          toast(s === 'failed' ? 'Connection failed' : 'Call disconnected');
          endCall();
        }
      } else if (s === 'connecting') {
        if (st && _callState !== 'active') st.textContent = 'Connecting…';
      }
    } catch (err) {
      console.warn('onconnectionstatechange failed', err);
    }
  };

  // Additional ICE-state listener gives us earlier warning on bad networks
  // (Firefox fires iceConnectionState changes sooner than connectionState).
  pc.oniceconnectionstatechange = () => {
    try {
      const st = document.getElementById('call-status-text');
      const ice = pc.iceConnectionState;
      if (ice === 'checking' && _callState === 'calling') {
        if (st) st.textContent = 'Connecting…';
      } else if (ice === 'disconnected' && _callState === 'active') {
        if (st) st.textContent = 'Reconnecting…';
      } else if (ice === 'connected' && _callState === 'active') {
        if (st) st.textContent = 'Connected';
      }
    } catch {}
  };

  return pc;
}

/* ── Controls ──────────────────────────────────────────────────────────────── */
function toggleCallMute () {
  if (!_localStream) return;
  _mutedAudio = !_mutedAudio;
  _localStream.getAudioTracks().forEach(t => t.enabled = !_mutedAudio);
  const btn = document.getElementById('btn-call-mute');
  btn.textContent = _mutedAudio ? '🔇' : '🎤';
  btn.classList.toggle('muted', _mutedAudio);
  const ind = document.getElementById('call-mute-indicator');
  if (ind) ind.style.display = _mutedAudio ? 'flex' : 'none';
  // Mirror into the minimized pill (its mute button may be the visible one).
  if (typeof _syncMiniMuteButton === 'function') _syncMiniMuteButton();
}

/* Renegotiate with peer after adding/replacing a track mid-call (voice→video, screen-share, etc.). */
async function _renegotiate () {
  if (!_pc || !_callPeerNick) return;
  try {
    await _bestEffortRefreshSignalBundle();
    const offer = await _pc.createOffer();
    await _pc.setLocalDescription(offer);
    const fp_sig = await _signCallFp(_callId || 0, _callPeerUID || 0, offer.sdp, _callPeerGid);
    _sendCallSignal({
      type: 'call_offer',
      ..._callPeerRoutingFields(),
      call_id: _callId || undefined,
      call_type: _callType,
      sdp: offer.sdp,
      renegotiate: true,
      fp_sig: fp_sig || undefined,
    });
    try {
      if (window.FrogTalkAndroid && typeof window.FrogTalkAndroid.onCallRenegotiate === 'function') {
        window.FrogTalkAndroid.onCallRenegotiate(String(_callId || _callGlobalId || ''));
      }
    } catch {}
  } catch (e) { console.warn('renegotiate failed', e); }
}

async function toggleCallCamera () {
  const btn = document.getElementById('btn-call-cam');
  if (!_pc) { toast('No active call', 'error'); return; }
  // Case 1: we already have a camera track — just toggle enable.
  const existingVideo = _localStream && _localStream.getVideoTracks()[0];
  if (existingVideo && !_screenStream) {
    _mutedVideo = !_mutedVideo;
    existingVideo.enabled = !_mutedVideo;
    _syncCamButton();
    return;
  }
  // Case 2: voice call — acquire camera on demand and add/replace track.
  try {
    const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const camTrack = camStream.getVideoTracks()[0];
    if (!camTrack) { toast('No camera available', 'error'); return; }
    // Add to local stream so endCall cleanup stops it too.
    if (_localStream) _localStream.addTrack(camTrack); else _localStream = camStream;
    // Attach to local preview.
    const lv = document.getElementById('local-video');
    if (lv) {
      lv.srcObject = _localStream;
      lv.style.display = '';
      const la = document.getElementById('call-local-avatar');
      if (la) la.style.display = 'none';
    }
    // Send to peer: replace existing sender or add new one.
    const videoSender = _pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
      await videoSender.replaceTrack(camTrack);
    } else {
      _pc.addTrack(camTrack, _localStream);
      await _renegotiate();
    }
    _callType = 'video';   // upgrade label
    _mutedVideo = false;
    _syncCamButton();
    toast('Camera on', 'info');
  } catch (e) {
    console.error('camera enable failed', e);
    toast('Camera access denied', 'error');
  }
}

/* ── Inbound native screen share (receive side) ─────────────────────────────
 * The sharer runs a one-way sendonly screen PeerConnection (Android native via
 * MediaProjection). It offers; we answer on a dedicated _screenPc and render the
 * incoming track in the #call-tile-screen tile so the call's own faces/video on
 * _pc / #remote-video stay untouched. Signaling rides screen_offer/answer/ice/
 * end, relayed by the server exactly like the call_* frames.
 *
 * Routing fields for replies reuse _callPeerRoutingFields() (we always reply to
 * the same call peer). We never initiate from the web side in v1 — the web
 * client only answers — so handleScreenAnswer is a defensive stub.
 */
function _selfUid () {
  try { return Number((typeof State !== 'undefined' && State.user?.id) || 0); } catch { return 0; }
}
function _screenForThisCall (data) {
  // Must reference the active call and not our own echo (send_to_user fans out
  // to all of the sharer's own sockets too).
  if (!data) return false;
  if (_callState !== 'active') return false;
  if (Number(data.from_id) === _selfUid()) return false;
  if (!_callId || String(data.call_id) !== String(_callId)) return false;
  return true;
}

async function handleScreenOffer (data) {
  try {
    if (!_screenForThisCall(data)) return;
    // Replace any prior screen PC (sharer re-pressed / restarted).
    _teardownScreen({ keepTile: true });
    _screenFromUid = Number(data.from_id) || _callPeerUID || null;
    const peerHome = String(data.peer_home_server_id || data.origin_server_id || _peerHomeServerId || '').trim();
    const ice = await buildIceServers(peerHome);
    _screenPc = new RTCPeerConnection({ iceServers: ice });
    _screenRemoteDescApplied = false;
    _screenPendingIce.length = 0;
    if (data.force_relay) {
      try { _screenPc.setConfiguration({ iceServers: ice, iceTransportPolicy: 'relay' }); } catch {}
    }
    _screenPc.onicecandidate = e => {
      if (!e.candidate) return;
      _sendCallSignal({
        type: 'screen_ice',
        ..._callPeerRoutingFields(),
        call_id: _callId || undefined,
        candidate: JSON.stringify(e.candidate),
      });
    };
    _screenPc.ontrack = e => {
      try {
        const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
        if (e.track && e.track.kind === 'video') _renderRemoteScreen(stream);
      } catch (err) { console.warn('screen ontrack failed', err); }
    };
    _screenPc.onconnectionstatechange = () => {
      const s = _screenPc && _screenPc.connectionState;
      if (s === 'failed' || s === 'closed') _teardownScreen();
    };
    await _screenPc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    _screenRemoteDescApplied = true;
    // Drain any ICE that arrived before the remote desc was applied.
    const q = _screenPendingIce.slice(); _screenPendingIce.length = 0;
    for (const c of q) { try { await _screenPc.addIceCandidate(c); } catch {} }
    const ans = await _screenPc.createAnswer();
    await _screenPc.setLocalDescription(ans);
    _sendCallSignal({
      type: 'screen_answer',
      ..._callPeerRoutingFields(),
      call_id: _callId || undefined,
      sdp: ans.sdp,
    });
  } catch (e) {
    console.warn('handleScreenOffer failed', e);
    _teardownScreen();
  }
}

async function handleScreenAnswer (data) {
  // v1: the web client never offers screen share, so this only fires if a
  // future client does. Apply defensively if we have an unanswered _screenPc.
  try {
    if (!_screenForThisCall(data) || !_screenPc) return;
    if (_screenPc.signalingState === 'have-local-offer') {
      await _screenPc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    }
  } catch (e) { console.warn('handleScreenAnswer failed', e); }
}

async function handleScreenIce (data) {
  try {
    if (Number(data.from_id) === _selfUid()) return;
    if (!_screenPc || !data.candidate) return;
    let parsed; try { parsed = JSON.parse(data.candidate); } catch { return; }
    if (!_screenRemoteDescApplied) { _screenPendingIce.push(parsed); return; }
    try { await _screenPc.addIceCandidate(parsed); } catch {}
  } catch (e) { console.warn('handleScreenIce failed', e); }
}

function handleScreenEnd (data) {
  if (data && Number(data.from_id) === _selfUid()) return;
  _teardownScreen();
}

// ── Callbacks invoked by the Android native shell (evaluateJavascript) ──────
// The native MediaProjection peer reports its own state so the button + toast
// reflect reality (consent granted, user cancelled, capture failed/ended).
function onNativeScreenShareStarted () {
  _nativeScreenSharing = true;
  const btn = document.getElementById('btn-call-screen');
  if (btn) btn.textContent = '⏹️';
  try { toast('Sharing your screen', 'info'); } catch {}
}
function onNativeScreenShareStopped () {
  _nativeScreenSharing = false;
  const btn = document.getElementById('btn-call-screen');
  if (btn) btn.textContent = '🖥️';
}
function onNativeScreenShareError (msg) {
  _nativeScreenSharing = false;
  const btn = document.getElementById('btn-call-screen');
  if (btn) btn.textContent = '🖥️';
  const m = String(msg || '').trim();
  // "cancelled" = user dismissed the system consent dialog → stay silent.
  if (m && m.toLowerCase() !== 'cancelled') {
    try { toast('Screen share failed: ' + m, 'error', 6000); } catch {}
  }
}

function _renderRemoteScreen (stream) {
  const tile = document.getElementById('call-tile-screen');
  const sv = document.getElementById('screen-video');
  if (!tile || !sv) return;
  sv.srcObject = stream;
  sv.style.display = '';
  tile.style.display = '';
  _screenActive = true;
  try {
    const nm = document.getElementById('call-tile-screen-name');
    if (nm) nm.textContent = '📺 ' + (_callPeerNick || 'Peer') + "'s screen";
  } catch {}
  // Switch the participants area into screen layout (CSS grid handles the rest).
  try { document.getElementById('call-participants')?.classList.add('has-screen'); } catch {}
  _ensureMediaPlayback(sv, 'screen-share');
}

function _teardownScreen (opts) {
  try {
    if (_screenPc) {
      try {
        _screenPc.onicecandidate = null;
        _screenPc.ontrack = null;
        _screenPc.onconnectionstatechange = null;
        _screenPc.close();
      } catch {}
      _screenPc = null;
    }
  } catch {}
  _screenRemoteDescApplied = false;
  _screenPendingIce.length = 0;
  _screenActive = false;
  _screenFromUid = null;
  if (opts && opts.keepTile) return;
  try {
    const tile = document.getElementById('call-tile-screen');
    const sv = document.getElementById('screen-video');
    if (sv) { sv.srcObject = null; sv.style.display = 'none'; }
    if (tile) tile.style.display = 'none';
    document.getElementById('call-participants')?.classList.remove('has-screen');
  } catch {}
}

// Android System WebView does not implement getDisplayMedia()/screen capture
// (there is no screen-capture resource in android.webkit.PermissionRequest, and
// the page's RTCPeerConnection can't be fed a native MediaProjection track), so
// browser-style screen share is impossible in the WebView. Instead, when the
// native shell exposes window.Android.startScreenShare (newer APKs), the 🖥️
// button drives a NATIVE MediaProjection peer that joins the call over screen_*
// signaling. Older shells without the bridge keep the button hidden.
function _isAndroidWebView () {
  return /Android/i.test(navigator.userAgent || '') && !!window.Android;
}
function _androidNativeScreenShareAvailable () {
  try {
    return _isAndroidWebView()
      && !!window.Android
      && typeof window.Android.startScreenShare === 'function'
      && (typeof window.Android.isScreenShareSupported !== 'function'
          || !!window.Android.isScreenShareSupported());
  } catch { return false; }
}
function _screenShareSupported () {
  // Either a real getDisplayMedia (desktop/browser) OR the Android native
  // MediaProjection bridge (newer APKs).
  if (_androidNativeScreenShareAvailable()) return true;
  return !_isAndroidWebView()
    && !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function');
}
function _applyScreenShareButtonVisibility () {
  const bSc = document.getElementById('btn-call-screen');
  if (bSc) bSc.style.display = _screenShareSupported() ? '' : 'none';
}

// Build the JSON args the native shell needs to open its own authed WS and
// route screen_* signals to the call peer.
function _nativeScreenArgs () {
  const r = _callPeerRoutingFields();
  let token = '';
  try { token = String((typeof State !== 'undefined' && (State.token || State.sessionToken)) || ''); } catch {}
  let room = '';
  try { room = String((typeof State !== 'undefined' && State.currentRoom) || ''); } catch {}
  let ice = [];
  try { ice = _iceConfigCache && Array.isArray(_iceConfigCache.servers) ? _iceConfigCache.servers : []; } catch {}
  return {
    call_id: _callId || 0,
    to_id: r.to_id || 0,
    to_global_user_id: r.to_global_user_id || '',
    to_nickname: _callPeerNick || '',
    peer_home_server_id: _peerHomeServerId || '',
    global_call_id: _callGlobalId || '',
    ice_servers: ice,
    token,
    room,
  };
}

async function toggleScreenShare () {
  const btn = document.getElementById('btn-call-screen');
  if (!_pc) { toast('No active call', 'error'); return; }
  const isAndroidWebView = _isAndroidWebView();

  // ── Android native MediaProjection path ──────────────────────────────────
  if (isAndroidWebView && _androidNativeScreenShareAvailable()) {
    if (_nativeScreenSharing) {
      try { window.Android.stopScreenShare(); } catch {}
      _nativeScreenSharing = false;
      if (btn) btn.textContent = '🖥️';
      toast('Screen share stopped', 'info');
      return;
    }
    try {
      // Native side shows the system consent dialog, starts the foreground
      // capture service + WebRTC peer, and signals over its own WS. We learn
      // success/cancel via window.onNativeScreenShare* callbacks below.
      window.Android.startScreenShare(JSON.stringify(_nativeScreenArgs()));
      if (btn) btn.textContent = '⏹️';
      toast('Starting screen share…', 'info');
    } catch (e) {
      console.warn('native startScreenShare failed', e);
      toast('Could not start screen share', 'error');
    }
    return;
  }
  if (isAndroidWebView) {
    // Old shell without the native bridge — be honest.
    toast('Screen sharing needs the latest FrogTalk app update on Android.', 'info', 6000);
    return;
  }

  // ── Desktop / browser getDisplayMedia path ───────────────────────────────
  // Already sharing — stop and revert.
  if (_screenStream) {
    _screenStream.getTracks().forEach(t => t.stop());
    _screenStream = null;
    const videoSender = _pc.getSenders().find(s => s.track && s.track.kind === 'video');
    const camTrack = _localStream?.getVideoTracks().find(t => t.readyState === 'live');
    if (videoSender) {
      if (camTrack) {
        await videoSender.replaceTrack(camTrack);
      } else {
        // No camera to revert to — stop sending video entirely.
        try { await videoSender.replaceTrack(null); } catch {}
      }
    }
    if (btn) btn.textContent = '🖥️';
    toast('Screen share stopped', 'info');
    return;
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    toast('Screen share is not supported on this device/browser', 'error');
    return;
  }
  // Step 1 — capture the screen. Kept separate from the track-attach step so a
  // capture failure (very common on Linux/Wayland when xdg-desktop-portal isn't
  // wired) reports the REAL reason instead of a generic "failed". A genuine
  // cancel (picker dismissed) surfaces as NotAllowedError/AbortError → silent.
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    const name = (e && e.name) || '';
    if (name === 'NotAllowedError' || name === 'AbortError') return; // user cancelled
    console.warn('screen share getDisplayMedia failed:', name, e);
    const detail = name || (e && e.message) || 'unknown error';
    toast('Could not start screen share: ' + detail, 'error', 7000);
    return;
  }
  // Step 2 — attach the captured track to the call (replace existing video, or
  // add + renegotiate for a voice-only call).
  try {
    _screenStream = stream;
    const screenTrack = _screenStream.getVideoTracks()[0];
    if (!screenTrack) { toast('No screen video track was captured', 'error'); _screenStream = null; return; }
    const videoSender = _pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
      await videoSender.replaceTrack(screenTrack);
    } else {
      _pc.addTrack(screenTrack, _screenStream);
      await _renegotiate();
    }
    if (btn) btn.textContent = '⏹️';
    toast('Sharing screen', 'info');
    screenTrack.onended = () => { toggleScreenShare().catch(()=>{}); };
  } catch (e) {
    console.warn('screen share attach failed:', e);
    toast('Screen share failed to attach: ' + ((e && e.name) || (e && e.message) || 'error'), 'error', 7000);
    try { _screenStream && _screenStream.getTracks().forEach(t => t.stop()); } catch {}
    _screenStream = null;
  }
}

function toggleCallSpeaker () {
  // Remote audio plays through BOTH #remote-video (the audio sink on voice
  // calls) and #remote-audio, so mute them together. Tag each with
  // data-user-muted so _ensureMediaPlayback's autoplay keeper won't un-mute
  // them on the next track event or reconnect.
  const els = ['remote-video', 'remote-audio']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  if (!els.length) return;
  _speakerMuted = !_speakerMuted;
  els.forEach(el => {
    el.muted = _speakerMuted;
    try { el.dataset.userMuted = _speakerMuted ? '1' : '0'; } catch {}
  });
  const btn = document.getElementById('btn-call-speaker');
  if (btn) {
    btn.textContent = _speakerMuted ? '🔈' : '🔊';
    btn.classList.toggle('muted', _speakerMuted);
    btn.title = _speakerMuted ? 'Unmute speaker' : 'Mute speaker';
  }
}

/* ── Track E Phase 2 — Safety Number panel ─────────────────────────────────
 * Opens a modal with the 60-digit Signal-style numeric fingerprint of the
 * combined identity keys. Both peers see identical digits iff no MITM /
 * key rotation has occurred. */
async function showCallSafetyNumber () {
  if (typeof openModal !== 'function') return;
  openModal('modal-call-safety');
  const out = document.getElementById('call-safety-number');
  const status = document.getElementById('call-safety-status');
  if (!out) return;
  out.textContent = '…';
  if (status) status.textContent = '';
  if (!window.Signal || !Signal.isReady?.()) {
    out.textContent = '—';
    if (status) status.textContent = 'Signal identity not available on this device.';
    return;
  }
  if (!_callPeerUID) {
    out.textContent = '—';
    if (status) status.textContent = 'No active call peer.';
    return;
  }
  try {
    const num = await Signal.safetyNumberWith(_callPeerUID);
    if (!num) {
      out.textContent = '—';
      if (status) status.textContent = 'Peer has no published Signal identity yet.';
      return;
    }
    // Two-line layout: 6 groups per row.
    const groups = num.split(' ');
    out.innerHTML = groups.slice(0, 6).join(' ') + '<br>' + groups.slice(6).join(' ');
    if (status) {
      status.textContent = _callUnverified
        ? '⚠️ This call is UNVERIFIED — peer fingerprint signature missing or unreadable.'
        : '✅ DTLS fingerprint signature verified for this call.';
    }
  } catch (e) {
    console.warn('[calls] safetyNumberWith failed', e);
    out.textContent = '—';
    if (status) status.textContent = 'Failed to compute safety number.';
  }
}

// Identity-rotation toast — fires once per call setup if the peer's
// identity key has changed since we last saw them. Hooked from
// handleCallOffer + startCall.
async function _maybeWarnIdentityRotation (peerUserId) {
  try {
    if (!peerUserId || !window.Signal || !Signal.isReady?.()) return;
    const rotated = await Signal.peerIdentityRotated(peerUserId);
    if (rotated) {
      toast('Safety number changed for ' + (_callPeerNick || 'peer') + ' — verify before sharing sensitive info', 'warn');
    }
  } catch {}
}

/* ── Timer ─────────────────────────────────────────────────────────────────── */
function startCallTimer () {
  _callSeconds = 0;
  clearInterval(_callTimer);
  _callTimer = setInterval(() => {
    _callSeconds++;
    const m = Math.floor(_callSeconds / 60).toString().padStart(2,'0');
    const s = (_callSeconds % 60).toString().padStart(2,'0');
    const txt = m + ':' + s;
    const el = document.getElementById('call-timer');
    if (el) el.textContent = txt;
    // Keep the minimized pill's timer ticking in lockstep.
    const mel = document.getElementById('call-mini-timer');
    if (mel) mel.textContent = txt;
  }, 1000);
}

/* ── UI helpers ────────────────────────────────────────────────────────────── */
function showCallOverlay (type, peerNick, status, avatar) {
  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setText('call-peer-name', peerNick || '');
  setText('call-status-text', status || '');
  setText('call-tile-remote-name', peerNick || 'Peer');
  setText('call-tile-local-name', State.user?.nickname || 'You');
  // Set avatars
  const selfAv = document.getElementById('call-self-avatar');
  if (selfAv) {
    // Avatars can be an emoji, not just a URL. The old code rendered ANY
    // truthy avatar as <img src=…>, so an emoji (or any non-URL) avatar
    // produced the browser's broken-image "torn file" box in the call tile.
    // Route through UI.avatarEl, which is URL-aware (img | emoji | tinted
    // default frog) exactly like the remote tile (_renderPeerAvatar).
    const _selfNick = State.user?.nickname || 'You';
    if (typeof UI !== 'undefined' && typeof UI.avatarEl === 'function') {
      selfAv.innerHTML = UI.avatarEl(State.user?.avatar || null, _selfNick, 96);
    } else {
      const s = String(State.user?.avatar || '');
      const isUrl = s.startsWith('data:image/') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/');
      if (s && isUrl) selfAv.innerHTML = `<img src="${esc(s)}" alt="">`;
      else if (s) selfAv.innerHTML = `<span class="call-avatar-emoji">${esc(s.slice(0, 2))}</span>`;
      else selfAv.innerHTML = `<div class="call-avatar-initial">${esc(String(_selfNick)[0].toUpperCase())}</div>`;
    }
  }
  _renderPeerAvatar(peerNick, avatar);
  _ensureCallPeerAvatar(true).catch(() => {});
  document.getElementById('call-overlay')?.classList.remove('hidden');
  // Showing the full overlay supersedes any minimized pill.
  document.getElementById('call-minibar')?.classList.remove('active');
  // Every call opens un-muted. Reset the mute button + indicator so a muted
  // state from a previous call (or a stale default) never bleeds into a fresh
  // call and makes the user look muted when they never pressed mute.
  _mutedAudio = false;
  const _bMuteEl = document.getElementById('btn-call-mute');
  if (_bMuteEl) { _bMuteEl.textContent = '🎤'; _bMuteEl.classList.remove('muted'); }
  const _muteIndEl = document.getElementById('call-mute-indicator');
  if (_muteIndEl) _muteIndEl.style.display = 'none';
  // Show all control buttons immediately
  const bCam = document.getElementById('btn-call-cam');
  if (bCam) bCam.style.display = '';
  // Screen share is desktop/standard-browser only (no getDisplayMedia in the
  // Android WebView), so only show the button where it can actually work.
  _applyScreenShareButtonVisibility();
  // Camera defaults OFF for a voice call — paint the off (🚫) state so the
  // button is honest, and hide the empty local-video tile.
  _syncCamButton();
  // Start voice activity detection on local stream (safe if no stream yet)
  try { _startLocalVAD(); } catch (e) { console.warn('VAD start failed', e); }
  // NOTE: Android call notification is now started AFTER getUserMedia resolves
  // (see _startAndroidCallNotification) — Android 14 requires the app to hold
  // mic/cam permission *before* the foreground service with those types starts.
}

// Start the native in-call notification. Call this ONLY after the local media
// stream has been acquired, so Android 14's foreground-service-type policy
// accepts the microphone/camera type.
function _startAndroidCallNotification(peerNick) {
  try {
    if (window.Android?.startCallNotification) {
      window.Android.startCallNotification(peerNick);
    }
  } catch (e) {
    // Never let a native bridge failure kill the call flow.
    console.warn('startCallNotification failed', e);
  }
}

function closeCallOverlay () {
  document.getElementById('call-overlay').classList.add('hidden');
  // The call is over — clear the minimized pill too.
  document.getElementById('call-minibar')?.classList.remove('active');
  _stopVAD();
  // Android: dismiss call notification
  try { if (window.Android?.endCallNotification) window.Android.endCallNotification(); } catch {}
}

/* ── Minimize ↔ restore ───────────────────────────────────────────────────── */
// Collapse the full-screen 1-on-1 call into the sidebar pill WITHOUT ending the
// call, stopping media/VAD, or dismissing the Android notification — it's purely
// a view toggle. Mirrors how #voice-channel-bar floats near the self panel.
function minimizeCall () {
  if (_callState === 'idle') return;
  const overlay = document.getElementById('call-overlay');
  const bar = document.getElementById('call-minibar');
  if (!overlay || !bar) return;
  overlay.classList.add('hidden');
  const nameEl = document.getElementById('call-mini-name');
  if (nameEl) nameEl.textContent = _callPeerNick || 'In call';
  // Avatar — reuse the URL/emoji-aware renderer the call tiles use.
  const avEl = document.getElementById('call-mini-avatar');
  if (avEl) {
    try {
      if (typeof UI !== 'undefined' && typeof UI.avatarEl === 'function') {
        avEl.innerHTML = UI.avatarEl(_callPeerAvatar || null, _callPeerNick || '', 38);
      } else {
        avEl.textContent = '🐸';
      }
    } catch { avEl.textContent = '🐸'; }
  }
  // Seed the pill timer from the live overlay timer so it doesn't flash 00:00.
  const t = document.getElementById('call-timer');
  const mt = document.getElementById('call-mini-timer');
  if (mt) mt.textContent = (t && t.textContent) ? t.textContent : '00:00';
  _syncMiniMuteButton();
  _syncCamButton();
  _syncMiniScreenButton();
  bar.classList.add('active');
}

// Restore the full call overlay from the minimized pill.
function maximizeCall () {
  document.getElementById('call-minibar')?.classList.remove('active');
  if (_callState === 'idle') return;
  document.getElementById('call-overlay')?.classList.remove('hidden');
}

// Keep the pill mute button in sync with the overlay mute state.
function _syncMiniMuteButton () {
  const mb = document.getElementById('call-mini-mute');
  if (!mb) return;
  mb.textContent = _mutedAudio ? '🔇' : '🎤';
  mb.classList.toggle('muted', !!_mutedAudio);
}

// Reflect camera on/off on BOTH the overlay and the pill camera buttons, and
// show the local video tile only while the camera is actually on — otherwise the
// avatar, so a disabled track never leaves a frozen/black "broken" tile.
function _syncCamButton () {
  const camOn = !!(_localStream && _localStream.getVideoTracks().some(t => t.enabled && t.readyState === 'live'));
  for (const id of ['btn-call-cam', 'call-mini-cam']) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.textContent = camOn ? '📷' : '🚫';
    b.classList.toggle('muted', !camOn);
    b.title = camOn ? 'Turn camera off' : 'Turn camera on';
  }
  const lv = document.getElementById('local-video');
  const la = document.getElementById('call-local-avatar');
  if (camOn) {
    if (lv) lv.style.display = '';
    if (la) la.style.display = 'none';
  } else {
    if (lv) lv.style.display = 'none';
    if (la) la.style.display = '';
  }
}

// Reflect screen-share state on the pill screen button (and hide it where
// screen share isn't supported, mirroring the overlay button).
function _syncMiniScreenButton () {
  const mb = document.getElementById('call-mini-screen');
  if (!mb) return;
  const sharing = !!(_screenStream || _nativeScreenSharing);
  mb.classList.toggle('active', sharing);
  mb.title = sharing ? 'Stop sharing screen' : 'Share screen';
  mb.style.display = (typeof _screenShareSupported === 'function' && _screenShareSupported()) ? '' : 'none';
}

function showIncomingCall (nick, type, avatar) {
  const safeNick = String(nick || '').trim() || 'Unknown';
  try { document.body.classList.remove('in-welcome'); } catch {}
  try { document.body.classList.add('ft-incoming-call-active'); } catch {}
  try {
    if (typeof selectServer === 'function') selectServer('dms');
  } catch {}
  const card = document.getElementById('incoming-call');
  if (card && card.parentElement !== document.body) {
    try { document.body.appendChild(card); } catch {}
  }
  const nameEl = document.getElementById('icall-name');
  const typeEl = document.getElementById('icall-type');
  const avatarEl = document.getElementById('icall-avatar');
  if (nameEl) nameEl.textContent = safeNick;
  if (typeEl) typeEl.textContent = (type === 'video' ? '📹 Video' : '📞 Voice') + ' Call';
  if (avatarEl && typeof UI !== 'undefined' && typeof UI.avatarEl === 'function') {
    avatarEl.innerHTML = UI.avatarEl(avatar || _callPeerAvatar, safeNick, 68);
  } else if (avatarEl) {
    avatarEl.textContent = safeNick.charAt(0).toUpperCase();
  }
  if (card) card.classList.remove('hidden');
  _refreshIncomingAcceptAvailability();
  // Primary ringtone engine lives in notifications.js; this fallback only runs
  // if that module isn't available for any reason.
  if (!window.Notifications?.startRinging) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      let _stopped = false;
      function ringBeep(freq, start, dur) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
        gain.gain.setValueAtTime(0.3, start + dur - 0.02);
        gain.gain.linearRampToValueAtTime(0, start + dur);
        osc.start(start);
        osc.stop(start + dur);
      }
      function scheduleRing(t) {
        if (_stopped) return;
        ringBeep(480, t, 0.4);
        ringBeep(480, t + 0.5, 0.4);
        setTimeout(() => scheduleRing(ctx.currentTime + 1.8), 1800);
      }
      scheduleRing(ctx.currentTime);
      const safeClose = () => {
        _stopped = true;
        try {
          if (ctx.state !== 'closed') ctx.close();
        } catch {}
      };
      setTimeout(safeClose, 30000);
      window._ringtoneCtx = { ctx, stop: safeClose };
    } catch {}
  }
}

function _refreshIncomingAcceptAvailability() {
  try {
    const btn = document.querySelector('#incoming-call .incoming-call-btn.accept');
    if (!btn) return;
    const ready = !!_pendingOffer?.sdp && _wsLooksOpen();
    btn.disabled = !ready;
    btn.setAttribute('aria-disabled', ready ? 'false' : 'true');
    btn.title = ready ? 'Accept call' : 'Preparing call signaling…';
  } catch {}
}

function isIncomingCallActive () {
  try {
    const card = document.getElementById('incoming-call');
    const visible = !!(card && !card.classList.contains('hidden'));
    return _callState === 'ringing' || visible || !!_pendingOffer?.sdp;
  } catch {
    return false;
  }
}

/** Re-show Accept/Decline when we already hold the offer but the overlay was hidden. */
function ensureIncomingCallSurfaceVisible() {
  try {
    if (!_pendingOffer?.sdp) return false;
    const card = document.getElementById('incoming-call');
    const visible = !!(card && !card.classList.contains('hidden'));
    if (_callState !== 'ringing' && _callState !== 'idle') return false;
    if (_callState === 'idle') _callState = 'ringing';
    const nick = _callPeerNick || 'Unknown';
    if (!visible) {
      showIncomingCall(nick, _callType, _callPeerAvatar);
      try { Notifications.startRinging(nick); } catch {}
    }
    _refreshIncomingAcceptAvailability();
    return true;
  } catch {
    return false;
  }
}

function clearStaleIncomingCallUi(reason) {
  try { hideIncomingCall(); } catch {}
  try { Notifications.stopRinging(); } catch {}
  try { window.Android?.dismissRing?.(); } catch {}
  _clearPersistedIncomingCall();
  try { window.App?.clearPendingIncomingCall?.(); } catch {}
  _pendingOffer = null;
  _autoAcceptPending = false;
  if (_callState === 'ringing') {
    resetCall();
    if (reason === 'gone') toast('This call is no longer available', 'info');
    else if (reason === 'ended') toast('Call ended', 'info');
  }
}

/**
 * Cold boot / bfcache restore: hide any leftover call UI. Does not notify peer
 * (no live WebRTC session exists after a full reload).
 */
function resetStaleCallUiOnBoot() {
  try { hideIncomingCall(); } catch {}
  try { closeCallOverlay(); } catch {}
  try { Notifications.stopRinging(); } catch {}
  try { window.Android?.dismissRing?.(); } catch {}
  try { window.Android?.endCallNotification?.(); } catch {}
  _pendingOffer = null;
  _autoAcceptPending = false;
  clearTimeout(_pendingAnswerRetryTimer);
  _pendingAnswerSend = null;
  if (!_pc && (_callState === 'ringing' || _callState === 'calling' || _callState === 'active')) {
    resetCall();
  }
}

function _abandonCallOnPageHide() {
  if (_callState !== 'ringing' && _callState !== 'calling' && _callState !== 'active') return;
  const token = (typeof State !== 'undefined' && State.token) ? String(State.token) : '';
  if (!token) return;
  const body = JSON.stringify({ call_id: _callId || undefined });
  try {
    fetch('/api/calls/abandon', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
      },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

async function reconcileCallSessionOnLogin() {
  const token = (typeof State !== 'undefined' && State.token) ? String(State.token) : '';
  if (!token) return;
  try {
    const res = await fetch('/api/calls/reconcile', {
      method: 'POST',
      headers: { 'X-Session-Token': token },
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (!data?.pending_call_id) {
      _clearPersistedIncomingCall();
      try { window.App?.clearPendingIncomingCall?.(); } catch {}
      if (_callState === 'ringing' && !_pendingOffer?.sdp) {
        clearStaleIncomingCallUi('gone');
      }
    }
  } catch {}
}

try { window.isIncomingCallActive = isIncomingCallActive; } catch {}
try { window.ensureIncomingCallSurfaceVisible = ensureIncomingCallSurfaceVisible; } catch {}
try { window.clearStaleIncomingCallUi = clearStaleIncomingCallUi; } catch {}
try { window.resetStaleCallUiOnBoot = resetStaleCallUiOnBoot; } catch {}
try { window.reconcileCallSessionOnLogin = reconcileCallSessionOnLogin; } catch {}

function hideIncomingCall () {
  document.getElementById('incoming-call')?.classList.add('hidden');
  try { document.body.classList.remove('ft-incoming-call-active'); } catch {}
  try { Notifications.stopRinging(); } catch {}
  try { window._ringtoneCtx?.stop?.(); } catch {}
  window._ringtoneCtx = null;
}

/* ── Called from user-info modal ────────────────────────────────────────────── */
function callUserInfo (type) {
  const nick = document.getElementById('userinfo-name').dataset.nick;
  if (!nick) return;
  closeModal('modal-user-info');
  openDMWithNick(nick).then(() => startCall(type, nick));
}


/* ═══════════════════════════════════════════════════════════════════════════ */
/* ────────────────── GROUP VOICE CHANNEL (MESH TOPOLOGY) ──────────────────── */
/* ═══════════════════════════════════════════════════════════════════════════ */

// Map of peer key -> { pc, nickname, avatar, userId, globalUserId, ... }
const _voicePeers = new Map();
let _voiceStream = null;
let _voiceRoom = null;

/* ── Discord-style voice presence bar for current channel ──────────────────
   Tracks everyone currently in voice for the channel the user is VIEWING,
   even before they've joined the call themselves. */
let _presenceRoom = null;                 // room name currently displayed
const _presenceRoster = new Map();        // room name -> array of {user_id, global_user_id, nickname, avatar}

function _voicePeerKey(data) {
  if (!data) return '';
  const gid = data.global_user_id || data.from_global_user_id || data.globalUserId;
  if (gid) return `g:${gid}`;
  const uid = data.user_id ?? data.from_id ?? data.userId;
  if (uid) return `u:${uid}`;
  return '';
}

function _normalizeVoiceParticipant(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    user_id: Number(p.user_id) || 0,
    global_user_id: String(p.global_user_id || '').trim(),
    nickname: String(p.nickname || '').trim() || '?',
    avatar: String(p.avatar || ''),
    federated: !!p.federated,
    home_server_id: String(p.home_server_id || '').trim(),
  };
}

/** One roster row per global_user_id; prefer local over federated. */
function _dedupeVoiceRoster(parts) {
  const byGid = new Map();
  const noGid = [];
  const seenUid = new Set();
  for (const raw of parts || []) {
    const p = _normalizeVoiceParticipant(raw);
    if (!p) continue;
    if (p.global_user_id) {
      const cur = byGid.get(p.global_user_id);
      if (!cur || (cur.federated && !p.federated)) byGid.set(p.global_user_id, p);
    } else if (p.user_id) {
      if (seenUid.has(p.user_id)) continue;
      seenUid.add(p.user_id);
      noGid.push(p);
    }
  }
  return [...noGid, ...byGid.values()];
}

async function refreshVoicePresenceBar(roomName) {
  _presenceRoom = roomName || null;
  const bar = document.getElementById('voice-presence-bar');
  if (!bar) return;
  if (!roomName || (typeof State !== 'undefined' && State.currentRoomType === 'dm')) {
    bar.style.display = 'none';
    return;
  }
  try {
    const r = await apiFetch(`/api/rooms/${encodeURIComponent(roomName)}/voice-participants`);
    if (!r.ok) { bar.style.display = 'none'; return; }
    const data = await r.json();
    const parts = Array.isArray(data.participants) ? data.participants : [];
    _presenceRoster.set(roomName, _dedupeVoiceRoster(parts));
    _renderVoicePresenceBar(roomName);
  } catch {
    bar.style.display = 'none';
  }
}

function _renderVoicePresenceBar(roomName) {
  const bar = document.getElementById('voice-presence-bar');
  if (!bar || !roomName || roomName !== _presenceRoom) return;
  let roster = (_presenceRoster.get(roomName) || []).slice();
  // Ensure self appears when we are in voice here (server broadcast excludes us)
  const myId = State.user?.id;
  const myGid = State.user?.global_user_id || '';
  if (_voiceRoom === roomName && myId && !roster.some(p =>
    (myGid && p.global_user_id === myGid) || (p.user_id && p.user_id === myId))) {
    roster.unshift({
      user_id: myId,
      global_user_id: myGid,
      nickname: State.user?.nickname || 'You',
      avatar: State.user?.avatar || '',
    });
  }
  if (!roster.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }

  const iAmHere = _voiceRoom === roomName;
  // Every interpolated value below crosses the federated trust boundary —
  // nicknames and avatars can be authored by a remote node. Always run
  // them through ``esc()`` (full HTML entity escape) before splatting
  // into innerHTML; a partial ``replace(/"/g, '&quot;')`` leaves <script>
  // tags and 'on*' handlers live. Avatar URLs are additionally restricted
  // to image-bearing schemes so a hostile node can't smuggle text/html
  // via data: URLs.
  const isSafeAvatar = (av) => {
    if (!av) return false;
    const s = String(av);
    return s.startsWith('data:image/') || s.startsWith('http://') || s.startsWith('https://');
  };
  const avatars = roster.slice(0, 12).map(p => {
    const self = (myGid && p.global_user_id === myGid) || (myId && p.user_id === myId);
    const rawNick = String(p.nickname || '?');
    const safeNick = esc(rawNick);
    const initials = esc(rawNick.slice(0, 2).toUpperCase());
    let img;
    if (isSafeAvatar(p.avatar)) {
      img = `<img src="${esc(p.avatar)}" alt="">`;
    } else if (p.avatar && /^\p{Extended_Pictographic}/u.test(String(p.avatar))) {
      // Emoji-only avatar: only render the first grapheme to keep
      // an attacker from sneaking trailing markup past the test.
      img = `<span class="vp-avatar-emoji">${esc(String(p.avatar).slice(0, 2))}</span>`;
    } else {
      img = initials;
    }
    const uid = String(p.user_id || 0).replace(/[^0-9]/g, '');
    return `<div class="vp-avatar${self ? ' self' : ''}" title="${safeNick}" data-uid="${uid}">${img}</div>`;
  }).join('');
  const extraCount = roster.length - 12;
  const extra = roster.length > 12
    ? `<div class="vp-avatar" title="+${extraCount} more">+${extraCount}</div>`
    : '';

  bar.innerHTML = `
    <div class="vp-label">🔊 In voice · ${roster.length}</div>
    <div class="vp-list">${avatars}${extra}</div>
    ${iAmHere
      ? `<button class="vp-join leave" onclick="leaveVoiceChannel()">Leave</button>`
      : `<button class="vp-join" onclick="joinVoiceChannel()">Join</button>`}
  `;
  bar.style.display = 'flex';
}

// Federated participants arrive with user_id=0 (no local row) and a
// distinct global_user_id; key the roster on whichever identifier the
// server provided so multiple remote users don't collapse to a single
// "user_id === 0" entry.
function _presenceKey(p) {
  return p?.global_user_id ? `g:${p.global_user_id}` : `u:${p?.user_id || 0}`;
}

function _peerKeyFromParticipant(p) {
  if (!p) return '';
  if (p.self) return 'self';
  if (p.global_user_id) return `g:${p.global_user_id}`;
  if (p.user_id) return `u:${p.user_id}`;
  return `n:${p.nickname || '?'}`;
}

function _isSafeVoiceAvatar(av) {
  if (!av) return false;
  const s = String(av);
  return s.startsWith('data:image/') || s.startsWith('http://') || s.startsWith('https://');
}

function _enrichPeerFromRoster(peerKey) {
  const peer = _voicePeers.get(peerKey);
  if (!peer || !_voiceRoom) return;
  const roster = _presenceRoster.get(_voiceRoom) || [];
  const gid = peer.globalUserId || '';
  const uid = peer.userId || 0;
  const match = roster.find(p =>
    (gid && p.global_user_id === gid) || (uid && p.user_id === uid));
  if (!match) return;
  if (match.nickname) peer.nickname = match.nickname;
  if (match.avatar && !peer.avatar) peer.avatar = match.avatar;
}

/** Roster for the active voice bar (server truth + self + mesh peers). */
function _voiceBarRoster() {
  if (!_voiceRoom) return [];
  let roster = _dedupeVoiceRoster(_presenceRoster.get(_voiceRoom) || []);
  const myGid = State.user?.global_user_id || '';
  const myUid = State.user?.id || 0;
  const hasSelf = roster.some(p =>
    (myGid && p.global_user_id === myGid) || (myUid && p.user_id === myUid));
  if (!hasSelf && myUid) {
    roster.unshift(_normalizeVoiceParticipant({
      user_id: myUid,
      global_user_id: myGid,
      nickname: State.user?.nickname || 'You',
      avatar: State.user?.avatar || '',
    }));
  }
  for (const [peerKey, peer] of _voicePeers) {
    const gid = peer.globalUserId || '';
    const uid = peer.userId || 0;
    if (roster.some(p => (gid && p.global_user_id === gid) || (uid && p.user_id === uid))) continue;
    roster.push(_normalizeVoiceParticipant({
      user_id: uid,
      global_user_id: gid,
      nickname: peer.nickname,
      avatar: peer.avatar,
    }));
  }
  return roster;
}

function _isSelfVoiceParticipant(p) {
  const myGid = State.user?.global_user_id || '';
  const myUid = State.user?.id || 0;
  return (myGid && p.global_user_id === myGid) || (myUid && p.user_id === myUid);
}

function _appendVoiceBarAvatar(btn, avatar, nickname) {
  const nick = String(nickname || '?');
  const initials = nick.slice(0, 2).toUpperCase();
  if (_isSafeVoiceAvatar(avatar)) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = nick;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => {
      img.replaceWith(Object.assign(document.createElement('span'), {
        className: 'voice-bar-initials',
        textContent: initials,
      }));
    };
    btn.appendChild(img);
  } else if (avatar && /^\p{Extended_Pictographic}/u.test(String(avatar))) {
    const em = document.createElement('span');
    em.className = 'voice-bar-emoji';
    em.textContent = String(avatar).slice(0, 2);
    btn.appendChild(em);
  } else {
    const span = document.createElement('span');
    span.className = 'voice-bar-initials';
    span.textContent = initials;
    btn.appendChild(span);
  }
}

function _presenceAdd(roomName, p) {
  const list = _presenceRoster.get(roomName) || [];
  const key = _presenceKey(p);
  if (!list.some(x => _presenceKey(x) === key)) list.push(p);
  _presenceRoster.set(roomName, list);
  if (roomName === _presenceRoom) _renderVoicePresenceBar(roomName);
}

function _presenceRemove(roomName, userIdOrPayload) {
  const target = (typeof userIdOrPayload === 'object' && userIdOrPayload !== null)
    ? userIdOrPayload
    : { user_id: userIdOrPayload };
  const key = _presenceKey(target);
  const list = _presenceRoster.get(roomName) || [];
  _presenceRoster.set(roomName, list.filter(x => _presenceKey(x) !== key));
  if (roomName === _presenceRoom) _renderVoicePresenceBar(roomName);
}

/** Returns nicknames of all users currently in voice call */
function getVoiceParticipantNicks() {
  const nicks = new Set();
  if (_voiceRoom && State.user?.nickname) nicks.add(State.user.nickname);
  for (const [, peer] of _voicePeers) {
    if (peer.nickname) nicks.add(peer.nickname);
  }
  const room = (typeof State !== 'undefined' && State.currentRoom) ? State.currentRoom : _presenceRoom;
  if (room) {
    for (const p of (_presenceRoster.get(room) || [])) {
      if (p.nickname) nicks.add(p.nickname);
    }
  }
  return nicks;
}
let _voiceMuted = false;
// Group-call video state (camera OR screen-share share one local video m-line).
let _voiceCamOn = false;
let _voiceScreenOn = false;
// Draggable always-on-top video popout (single instance, re-points srcObject).
let _popoutPeerKey = null;
let _popoutDragBound = false;

/** Sync Android tray notification while connected to a room voice channel. */
function _syncVoiceTrayNotification(statusText) {
  try {
    const android = window.Android;
    if (!android?.updateVoiceChannel) return;
    if (!_voiceRoom) {
      android.stopVoiceChannel?.();
      return;
    }
    const count = _voicePeers.size + 1;
    const status = statusText
      || document.getElementById('voice-bar-status')?.textContent
      || 'Connected';
    android.updateVoiceChannel(_voiceRoom, count, !!_voiceMuted, true, status);
    // Camera / screen-share state goes through a SEPARATE bridge method so the
    // call above stays signature-compatible with older (v248) native builds
    // that lack the media flags — those WebViews simply skip this.
    try { android.updateVoiceMedia?.(!!_voiceCamOn, !!_voiceScreenOn); } catch {}
  } catch {}
}

/**
 * Join the voice channel for the current room (public rooms only).
 */
async function joinVoiceChannel() {
  if (_voiceRoom) {
    if (_voiceRoom === State.currentRoom) return;
    toast('Already in a voice channel', 'error');
    return;
  }
  if (_callState !== 'idle') {
    toast('Cannot join voice channel during a call', 'error');
    return;
  }
  // If no room is selected, auto-switch to General so the Join Voice button
  // is useful from an empty top bar.
  if (!State.currentRoom || State.currentRoomType === 'dm') {
    const fallback = (State.rooms || []).find(r => r.name === 'general' && r.joined)
                  || (State.rooms || []).find(r => r.joined && r.type !== 'dm');
    if (fallback && typeof switchToRoom === 'function') {
      await switchToRoom(fallback.name, fallback.type, null, fallback.channel_type || 'text');
    } else {
      toast('Join a channel first to use voice', 'error');
      return;
    }
  }
  if (!_requireWebRtc()) return;

  try {
    _voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    toast('Microphone permission denied', 'error');
    return;
  }

  _voiceRoom = State.currentRoom;
  _voiceMuted = false;

  // Show voice channel bar
  document.getElementById('voice-channel-bar').classList.add('active');
  document.getElementById('voice-bar-title').textContent = `🔊 #${_voiceRoom}`;
  document.getElementById('voice-bar-status').textContent = 'Connecting…';
  document.getElementById('voice-mute-btn').textContent = '🎤';
  
  // Hide join button, show leave
  document.getElementById('voice-join-btn').style.display = 'none';

  // Tell server we're joining
  _sendVoiceSignal({ type: 'voice_join' });
  _syncVoiceTrayNotification('Connecting…');
  _updateVoiceBarParticipants();
  // Refresh member list to show voice badge
  if (typeof Users !== 'undefined' && State.onlineUsers) Users.updateList(State.onlineUsers);
}

/**
 * Leave the voice channel and clean up all peer connections.
 */
function leaveVoiceChannel() {
  if (!_voiceRoom) return;

  // Tell server we're leaving
  _sendVoiceSignal({ type: 'voice_leave' });

  // Close all peer connections
  for (const [uid, peer] of _voicePeers) {
    try { peer.pc.close(); } catch {}
  }
  _voicePeers.clear();
  _voicePeerMuted.clear();

  // Stop local stream
  if (_voiceStream) {
    _voiceStream.getTracks().forEach(t => t.stop());
    _voiceStream = null;
  }

  _voiceRoom = null;
  _voiceMuted = false;
  _voiceCamOn = false;
  _voiceScreenOn = false;
  closeVideoPopout();
  _updateVoiceCamButton();

  // Hide voice channel bar
  document.getElementById('voice-channel-bar').classList.remove('active');
  document.getElementById('voice-bar-participants').innerHTML = '';
  
  // Show join button again if in a room
  if (State.currentRoom && State.currentRoomType !== 'dm') {
    document.getElementById('voice-join-btn').style.display = '';
  }
  // Refresh member list to remove voice badge
  if (typeof Users !== 'undefined' && State.onlineUsers) Users.updateList(State.onlineUsers);
  // Refresh the Discord-style presence bar (removes self immediately)
  if (_presenceRoom && State.user?.id) _presenceRemove(_presenceRoom, State.user.id);
  _syncVoiceTrayNotification();
}

/**
 * Mute/unmute a specific peer's audio locally (peerKey: self | g:… | u:…).
 */
function toggleMutePeer(peerKey) {
  if (peerKey === 'self') {
    toggleVoiceMute();
    return;
  }
  const peer = _voicePeers.get(peerKey);
  if (!peer) return;
  const next = !_voicePeerMuted.get(peerKey);
  _voicePeerMuted.set(peerKey, next);
  peer.muted = next;
  const audioEl = document.getElementById(`voice-audio-${peerKey}`);
  if (audioEl) { audioEl.muted = next; try { audioEl.dataset.userMuted = next ? '1' : '0'; } catch {} }
  toast(next ? `Muted ${peer.nickname}` : `Unmuted ${peer.nickname}`);
  _updateVoiceBarParticipants();
}

/**
 * Toggle microphone mute in voice channel.
 */
function toggleVoiceMute() {
  if (!_voiceRoom || !_voiceStream) return;
  
  _voiceMuted = !_voiceMuted;
  _voiceStream.getAudioTracks().forEach(t => t.enabled = !_voiceMuted);
  document.getElementById('voice-mute-btn').textContent = _voiceMuted ? '🔇' : '🎤';
  // Let peers render a muted indicator next to our name.
  try { wsSend({ type: 'voice_mute', muted: _voiceMuted }); } catch {}
  // Repaint user list so our own icon updates too.
  try { if (typeof renderUsers === 'function') renderUsers(); } catch {}
  _updateVoiceBarParticipants();
  _syncVoiceTrayNotification();
}

/**
 * Returns the Set of nicknames whose mic is currently muted in voice.
 */
const _voicePeerMuted = new Map();  // user_id -> bool
function getVoiceMutedNicks() {
  const nicks = new Set();
  if (_voiceRoom && _voiceMuted && State.user?.nickname) nicks.add(State.user.nickname);
  for (const [uid, peer] of _voicePeers) {
    if (_voicePeerMuted.get(uid)) nicks.add(peer.nickname);
  }
  return nicks;
}

/** WS: another participant changed their mute state. */
function handleVoiceMute(data) {
  if (!data) return;
  const key = _voicePeerKey(data) || (data.user_id ? `u:${data.user_id}` : '');
  if (!key) return;
  _voicePeerMuted.set(key, !!data.muted);
  const peer = _voicePeers.get(key);
  if (peer) peer.muted = !!data.muted;
  try { if (typeof renderUsers === 'function') renderUsers(); } catch {}
  try { _renderVoicePresenceBar?.(_voiceRoom); } catch {}
  _updateVoiceBarParticipants();
}

/* ── Group-call camera / screen-share (mesh video) ─────────────────────────── */

/** Stable per-peer key for OUR identity (for deterministic glare tie-break). */
function _voiceMyKey() {
  const gid = State.user?.global_user_id || '';
  if (gid) return `g:${gid}`;
  const uid = State.user?.id || 0;
  return uid ? `u:${uid}` : 'self';
}

function _voiceHasLiveVideo(stream) {
  try {
    return !!stream && stream.getVideoTracks().some(t => t.readyState === 'live' && t.enabled !== false);
  } catch { return false; }
}

/** Reflect cam/screen state on the voice bar control buttons. */
function _updateVoiceCamButton() {
  const cam = document.getElementById('voice-cam-btn');
  if (cam) {
    cam.classList.toggle('active', _voiceCamOn);
    cam.title = _voiceCamOn ? 'Turn camera off' : 'Turn camera on';
  }
  const scr = document.getElementById('voice-screen-btn');
  if (scr) {
    scr.classList.toggle('active', _voiceScreenOn);
    scr.title = _voiceScreenOn ? 'Stop sharing screen' : 'Share your screen';
  }
}

/** Cosmetic broadcast so peers can badge cam/screen before the first frame and
 *  distinguish camera from screen-share (SDP alone can't tell them apart). */
function _broadcastVoiceVideoState() {
  try { wsSend({ type: 'voice_video', video: !!_voiceCamOn, screen: !!_voiceScreenOn }); } catch {}
}

/** WS: a participant toggled camera / screen-share (cosmetic hint). */
function handleVoiceVideo(data) {
  if (!data) return;
  const key = _voicePeerKey(data) || (data.user_id ? `u:${data.user_id}` : '');
  if (!key) return;
  const peer = _voicePeers.get(key);
  if (peer) {
    peer.screenOn = !!data.screen;
    if (!data.video && !data.screen) {
      // Authoritative "video off" — the inbound track may just mute, not end.
      peer.videoOn = false;
      if (_popoutPeerKey === key) closeVideoPopout();
    }
  }
  _updateVoiceBarParticipants();
}

/** Add (or hot-swap) our local video track across every mesh peer. Only peers
 *  that gain a NEW sender (first time) need renegotiation; replaceTrack does not. */
async function _voiceAddOrReplaceVideoTrack(track) {
  try {
    _voiceStream.getVideoTracks().forEach(t => {
      if (t !== track) { try { t.stop(); } catch {} try { _voiceStream.removeTrack(t); } catch {} }
    });
  } catch {}
  try { _voiceStream.addTrack(track); } catch {}
  const toReneg = [];
  for (const [peerKey, peer] of _voicePeers) {
    try {
      if (peer.videoSender) {
        await peer.videoSender.replaceTrack(track);
      } else {
        peer.videoSender = peer.pc.addTrack(track, _voiceStream);
        toReneg.push(peerKey);
      }
    } catch (e) { console.warn('voice add video failed', e); }
  }
  for (const peerKey of toReneg) { await _renegotiateVoicePeer(peerKey); }
}

/** Stop our local camera/screen video and drop it from every peer (m-line kept). */
function _voiceStopLocalVideo() {
  try {
    _voiceStream?.getVideoTracks().forEach(t => { try { t.stop(); } catch {} try { _voiceStream.removeTrack(t); } catch {} });
  } catch {}
  for (const [, peer] of _voicePeers) {
    try { if (peer.videoSender) peer.videoSender.replaceTrack(null); } catch {}
  }
  _voiceCamOn = false;
  _voiceScreenOn = false;
  if (_popoutPeerKey === 'self') closeVideoPopout();
  _updateVoiceCamButton();
  _broadcastVoiceVideoState();
  _updateVoiceBarParticipants();
  _syncVoiceTrayNotification();
}

/** Re-offer to a single mesh peer after adding a new (video) sender. */
async function _renegotiateVoicePeer(peerKey) {
  const peer = _voicePeers.get(peerKey);
  if (!peer || !peer.pc) return;
  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    _sendVoiceSignal({
      type: 'voice_offer',
      to_id: peer.userId || undefined,
      to_global_user_id: peer.globalUserId || undefined,
      sdp: offer.sdp,
    });
  } catch (e) { console.warn('voice renegotiate failed', e); }
}

/** Toggle the local camera in the group voice channel (works on Android WebView). */
async function toggleVoiceCamera() {
  if (!_voiceRoom || !_voiceStream) { toast('Join voice first', 'error'); return; }
  if (_voiceCamOn) { _voiceStopLocalVideo(); return; }
  if (_voiceScreenOn) { toast('Stop screen share first', 'error'); return; }
  let camStream;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: 'user' },
      audio: false,
    });
  } catch (e) { toast('Camera permission denied', 'error'); return; }
  const track = camStream.getVideoTracks()[0];
  if (!track) { toast('No camera found', 'error'); return; }
  _voiceCamOn = true;
  track.onended = () => { if (_voiceCamOn) _voiceStopLocalVideo(); };
  await _voiceAddOrReplaceVideoTrack(track);
  _updateVoiceCamButton();
  _broadcastVoiceVideoState();
  _updateVoiceBarParticipants();
  _syncVoiceTrayNotification();
}

/** Toggle screen-share in the group voice channel (desktop getDisplayMedia;
 *  Android uses a native path delivered in a later app build). */
async function toggleVoiceScreenShare() {
  if (!_voiceRoom || !_voiceStream) { toast('Join voice first', 'error'); return; }
  if (_voiceScreenOn) { _voiceStopLocalVideo(); return; }
  if (_voiceCamOn) { toast('Turn off your camera first', 'error'); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast(window.Android
      ? 'Sharing your screen in group calls is coming to Android soon — use a desktop browser to share for now'
      : 'Screen share is not supported on this device', 'info');
    return;
  }
  let scrStream;
  try {
    scrStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) { return; /* user cancelled the picker */ }
  const track = scrStream.getVideoTracks()[0];
  if (!track) return;
  _voiceScreenOn = true;
  track.onended = () => { if (_voiceScreenOn) _voiceStopLocalVideo(); };
  await _voiceAddOrReplaceVideoTrack(track);
  _updateVoiceCamButton();
  _broadcastVoiceVideoState();
  _updateVoiceBarParticipants();
  _syncVoiceTrayNotification();
}

/* ── Draggable always-on-top video popout ──────────────────────────────────── */

function openVideoPopout(peerKey) {
  const pop = document.getElementById('call-popout');
  const vid = document.getElementById('call-popout-video');
  const nameEl = document.getElementById('call-popout-name');
  if (!pop || !vid) return;
  let stream, name, mirror = false;
  if (peerKey === 'self') {
    stream = _voiceStream;
    name = (State.user?.nickname || 'You') + (_voiceScreenOn ? ' · screen' : '');
    mirror = _voiceCamOn && !_voiceScreenOn;
  } else {
    const peer = _voicePeers.get(peerKey);
    if (!peer) return;
    stream = peer.stream;
    name = (peer.nickname || 'Peer') + (peer.screenOn ? ' · screen' : '');
  }
  if (!_voiceHasLiveVideo(stream)) { toast('No video to show', 'info'); return; }
  _popoutPeerKey = peerKey;
  vid.muted = true; // audio routes through the hidden per-peer <audio> sink
  vid.srcObject = stream;
  vid.classList.toggle('mirror', mirror);
  if (nameEl) nameEl.textContent = name;
  pop.classList.remove('hidden');
  try { vid.play?.().catch(() => {}); } catch {}
  if (!_popoutDragBound) { _bindPopoutDrag(pop); _popoutDragBound = true; }
}

function closeVideoPopout() {
  const pop = document.getElementById('call-popout');
  const vid = document.getElementById('call-popout-video');
  if (vid) { try { vid.srcObject = null; } catch {} }
  if (pop) pop.classList.add('hidden');
  _popoutPeerKey = null;
}

/** Pointer-drag the popout by its header (ported from rooms.js _bindChannelDrag). */
function _bindPopoutDrag(pop) {
  const header = document.getElementById('call-popout-header');
  if (!header) return;
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, lastX = 0, lastY = 0, dragging = false, rafId = 0;
  const apply = () => {
    rafId = 0;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let nl = Math.max(4, Math.min(window.innerWidth - w - 4, baseLeft + (lastX - startX)));
    let nt = Math.max(4, Math.min(window.innerHeight - h - 4, baseTop + (lastY - startY)));
    pop.style.left = nl + 'px';
    pop.style.top = nt + 'px';
    pop.style.right = 'auto';
    pop.style.bottom = 'auto';
  };
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('#call-popout-close')) return;
    if (e.button && e.button !== 0) return;
    const r = pop.getBoundingClientRect();
    baseLeft = r.left; baseTop = r.top;
    startX = lastX = e.clientX; startY = lastY = e.clientY;
    dragging = true;
    pop.style.left = r.left + 'px'; pop.style.top = r.top + 'px';
    pop.style.right = 'auto'; pop.style.bottom = 'auto';
    try { header.setPointerCapture(e.pointerId); } catch {}
    if (e.cancelable) e.preventDefault();
  });
  header.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    lastX = e.clientX; lastY = e.clientY;
    if (!rafId) rafId = requestAnimationFrame(apply);
    if (e.cancelable) e.preventDefault();
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    try { header.releasePointerCapture(e.pointerId); } catch {}
  };
  header.addEventListener('pointerup', end);
  header.addEventListener('pointercancel', end);
}

function _bindVoicePeerRemoteTrack(peerKey, e) {
  const peer = _voicePeers.get(peerKey);
  if (!peer) return;
  const stream = _mediaStreamFromTrackEvent(e, peer.stream);
  if (!stream) return;
  peer.stream = stream;

  const aid = `voice-audio-${peerKey}`;
  let audio = document.getElementById(aid);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = aid;
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    document.body.appendChild(audio);
  }
  audio.srcObject = stream;
  audio.muted = !!peer.muted;
  try { audio.dataset.userMuted = peer.muted ? '1' : '0'; } catch {}
  _ensureMediaPlayback(audio, `voice-${peerKey}`);
  _updateVoiceBarParticipants();
}

/**
 * Create a peer connection for a specific user in the voice channel.
 */
async function _createVoicePeer(userId, nickname, avatar, isOfferer, globalUserId, homeServerId) {
  const ice = await buildIceServers(homeServerId || '');
  const pc = new RTCPeerConnection({ iceServers: ice });
  const peerKey = globalUserId ? `g:${globalUserId}` : (userId ? `u:${userId}` : `n:${nickname}`);

  _voicePeers.set(peerKey, {
    pc, nickname, avatar, stream: null, pendingIce: [], remoteDescApplied: false,
    userId, globalUserId: globalUserId || '', muted: !!_voicePeerMuted.get(peerKey),
  });
  _enrichPeerFromRoster(peerKey);

  pc.ontrack = (e) => {
    // Audio routes to the hidden <audio> sink; video is consumed by the tray
    // tile + popout (read from peer.stream). Both kinds bind into peer.stream.
    _bindVoicePeerRemoteTrack(peerKey, e);
    if (e.track && e.track.kind === 'video') {
      const p = _voicePeers.get(peerKey);
      if (p) p.videoOn = true;
      e.track.onended = () => {
        const pp = _voicePeers.get(peerKey);
        if (pp) pp.videoOn = false;
        if (_popoutPeerKey === peerKey) closeVideoPopout();
        _updateVoiceBarParticipants();
      };
      e.track.onmute = () => {
        const pp = _voicePeers.get(peerKey);
        if (pp) pp.videoOn = false;
        _updateVoiceBarParticipants();
      };
      e.track.onunmute = () => {
        const pp = _voicePeers.get(peerKey);
        if (pp) pp.videoOn = true;
        _updateVoiceBarParticipants();
      };
    }
    _updateVoiceBarParticipants();
  };

  if (_voiceStream) {
    _voiceStream.getTracks().forEach(t => {
      const sender = pc.addTrack(t, _voiceStream);
      // Remember the video sender so a later cam toggle hot-swaps via
      // replaceTrack (no renegotiation) instead of adding a second m-line.
      if (t.kind === 'video') {
        const p = _voicePeers.get(peerKey);
        if (p) p.videoSender = sender;
      }
    });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      _sendVoiceSignal({
        type: 'voice_ice',
        to_id: userId || undefined,
        to_global_user_id: globalUserId || undefined,
        candidate: JSON.stringify(e.candidate),
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      _updateVoiceBarParticipants();
      const peer = _voicePeers.get(peerKey);
      const audio = document.getElementById(`voice-audio-${peerKey}`);
      if (peer?.stream && audio) _ensureMediaPlayback(audio, `voice-${peerKey}-connected`);
    }
  };

  return pc;
}

/**
 * Update the voice bar participant avatars (roster-driven, includes self + connecting).
 */
function _updateVoiceBarParticipants() {
  const container = document.getElementById('voice-bar-participants');
  const statusEl = document.getElementById('voice-bar-status');
  if (!container || !statusEl || !_voiceRoom) return;

  for (const key of _voicePeers.keys()) _enrichPeerFromRoster(key);

  const roster = _voiceBarRoster();
  container.innerHTML = '';
  let connected = 0;

  for (const p of roster) {
    const isSelf = _isSelfVoiceParticipant(p);
    const peerKey = isSelf ? 'self' : _peerKeyFromParticipant(p);
    const peer = isSelf ? null : _voicePeers.get(peerKey);
    const avatar = isSelf ? (State.user?.avatar || p.avatar) : (peer?.avatar || p.avatar);
    const nickname = isSelf ? (State.user?.nickname || p.nickname) : (peer?.nickname || p.nickname);
    const locallyMuted = isSelf ? _voiceMuted : !!(_voicePeerMuted.get(peerKey) || peer?.muted);
    const pcState = peer?.pc?.connectionState;
    const isConnected = isSelf || pcState === 'connected' || !!peer?.stream;
    if (isConnected) connected += 1;

    const tile = document.createElement('div');
    tile.className = 'voice-bar-tile' + (isSelf ? ' self' : '') + (locallyMuted ? ' muted-peer' : '');
    if (!isConnected && !isSelf) tile.classList.add('connecting');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'voice-bar-avatar';
    btn.dataset.peerKey = peerKey;
    btn.title = isSelf
      ? (locallyMuted ? 'Unmute yourself' : 'Mute yourself')
      : `${nickname} — tap to ${locallyMuted ? 'unmute' : 'mute'} locally`;
    btn.setAttribute('aria-label', btn.title);
    // Live video circle when this participant has camera/screen on; else avatar.
    const selfHasVideo = isSelf && (_voiceCamOn || _voiceScreenOn) && _voiceHasLiveVideo(_voiceStream);
    const peerHasVideo = !isSelf && !!peer?.videoOn && _voiceHasLiveVideo(peer?.stream);
    const hasVideo = selfHasVideo || peerHasVideo;
    if (hasVideo) {
      const v = document.createElement('video');
      v.className = 'voice-bar-video';
      v.autoplay = true; v.muted = true;
      v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      if (isSelf && _voiceCamOn && !_voiceScreenOn) v.classList.add('mirror');
      v.srcObject = isSelf ? _voiceStream : peer.stream;
      btn.appendChild(v);
      try { v.play?.().catch(() => {}); } catch {}
      const camBadge = document.createElement('span');
      camBadge.className = 'voice-bar-cam-badge';
      camBadge.setAttribute('aria-hidden', 'true');
      camBadge.textContent = (isSelf ? _voiceScreenOn : peer?.screenOn) ? '🖥️' : '📷';
      btn.appendChild(camBadge);
    } else {
      _appendVoiceBarAvatar(btn, avatar, nickname);
    }
    if (locallyMuted) {
      const badge = document.createElement('span');
      badge.className = 'voice-bar-mute-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = '🔇';
      btn.appendChild(badge);
    }
    if (hasVideo) {
      // A video tile pops out the large draggable view; mute stays available
      // on the non-video tiles (tap) and via the per-participant menu.
      btn.onclick = () => openVideoPopout(peerKey);
      btn.title = isSelf ? 'Your video — tap to expand' : `${nickname} — tap to expand`;
      btn.setAttribute('aria-label', btn.title);
    } else {
      btn.onclick = () => toggleMutePeer(peerKey);
    }
    tile.appendChild(btn);

    const label = document.createElement('span');
    label.className = 'voice-bar-name';
    label.textContent = isSelf ? 'You' : nickname;
    tile.appendChild(label);

    container.appendChild(tile);
  }

  const total = roster.length;
  if (total === 0) {
    statusEl.textContent = 'Connecting…';
  } else if (connected >= total) {
    statusEl.textContent = `${total} in voice`;
  } else {
    statusEl.textContent = `${connected}/${total} connected`;
  }

  if (typeof Users !== 'undefined' && State.onlineUsers) Users.updateList(State.onlineUsers);
  _startVADLoop();
  _syncVoiceTrayNotification();
}

/* ── Voice channel WebSocket message handlers ──────────────────────────────── */

/**
 * Handle confirmation that we joined the voice channel.
 * Contains list of existing participants to connect to.
 */
async function handleVoiceJoined(data) {
  document.getElementById('voice-bar-status').textContent = 'Connected';
  _syncVoiceTrayNotification('Connected');

  if (data.already) {
    if (_voiceRoom) {
      const roster = _dedupeVoiceRoster(data.participants || []);
      _presenceRoster.set(_voiceRoom, roster);
      if (_voiceRoom === _presenceRoom) _renderVoicePresenceBar(_voiceRoom);
    }
    _updateVoiceBarParticipants();
    return;
  }

  // Seed the presence roster for our current room with the existing peers.
  if (_voiceRoom) {
    const roster = _dedupeVoiceRoster(data.participants || []);
    const myGid = State.user?.global_user_id || '';
    if (State.user?.id && !roster.some(p =>
      (myGid && p.global_user_id === myGid) || p.user_id === State.user.id)) {
      roster.push(_normalizeVoiceParticipant({
        user_id: State.user.id,
        global_user_id: myGid,
        nickname: State.user.nickname,
        avatar: State.user.avatar || '',
      }));
    }
    _presenceRoster.set(_voiceRoom, roster);
    if (_voiceRoom === _presenceRoom) _renderVoicePresenceBar(_voiceRoom);
    _updateVoiceBarParticipants();
  }

  const myGid = State.user?.global_user_id || '';
  const myUid = State.user?.id || 0;

  for (const p of data.participants || []) {
    if (!p.user_id && !p.global_user_id) continue;
    const gid = String(p.global_user_id || '').trim();
    const uid = Number(p.user_id) || 0;
    if ((myGid && gid === myGid) || (myUid && uid === myUid)) continue;
    const pc = await _createVoicePeer(
      p.user_id, p.nickname, p.avatar, true, p.global_user_id, p.home_server_id,
    );

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    _sendVoiceSignal({
      type: 'voice_offer',
      to_id: p.user_id || undefined,
      to_global_user_id: p.global_user_id || undefined,
      sdp: offer.sdp,
    });
  }

  _updateVoiceBarParticipants();
}

/**
 * Handle when another user joins the voice channel.
 * They will send us an offer, so we just wait.
 */
function handleVoiceUserJoined(data) {
  const room = data.room || _voiceRoom || _presenceRoom;
  const myGid = State.user?.global_user_id || '';
  const myUid = State.user?.id || 0;
  const joinedGid = String(data.global_user_id || '').trim();
  const joinedUid = Number(data.user_id) || 0;
  if (_voiceRoom === room && ((myGid && joinedGid === myGid) || (myUid && joinedUid === myUid))) {
    if (Array.isArray(data.participants) && data.participants.length) {
      _presenceRoster.set(room, _dedupeVoiceRoster(data.participants));
      if (room === _presenceRoom) _renderVoicePresenceBar(room);
    }
    try { if (typeof renderUsers === 'function') renderUsers(); } catch {}
    return;
  }
  if (room) {
    if (Array.isArray(data.participants) && data.participants.length) {
      _presenceRoster.set(room, _dedupeVoiceRoster(data.participants));
      if (room === _presenceRoom) _renderVoicePresenceBar(room);
    } else {
      const p = _normalizeVoiceParticipant({
        user_id: data.user_id,
        global_user_id: data.global_user_id,
        nickname: data.nickname,
        avatar: data.avatar,
        federated: data.federated,
      });
      if (p) _presenceAdd(room, p);
    }
  }
  if (_voiceRoom === room) _updateVoiceBarParticipants();
  try { if (typeof renderUsers === 'function') renderUsers(); } catch {}
}

/**
 * Handle when another user leaves the voice channel.
 */
function handleVoiceUserLeft(data) {
  const peerKey = _voicePeerKey(data);
  const peer = peerKey ? _voicePeers.get(peerKey) : null;
  if (peer) {
    try { peer.pc.close(); } catch {}
    const audio = document.getElementById(`voice-audio-${peerKey}`);
    if (audio) audio.remove();
  }
  // Close the popout if it was showing the departing peer.
  if (peerKey && _popoutPeerKey === peerKey) closeVideoPopout();
  if (peerKey) {
    _voicePeers.delete(peerKey);
    _voicePeerMuted.delete(peerKey);
  }

  const room = data.room || _voiceRoom || _presenceRoom;
  if (room) {
    if (Array.isArray(data.participants)) {
      _presenceRoster.set(room, _dedupeVoiceRoster(data.participants));
      if (room === _presenceRoom) _renderVoicePresenceBar(room);
    } else {
      _presenceRemove(room, {
        user_id: data.user_id,
        global_user_id: data.global_user_id,
      });
    }
  }

  _updateVoiceBarParticipants();
  try { if (typeof renderUsers === 'function') renderUsers(); } catch {}
}

/**
 * Handle incoming WebRTC offer from a peer.
 */
async function handleVoiceOffer(data) {
  if (!_voiceRoom || data.room !== _voiceRoom) return;

  const peerKey = _voicePeerKey(data);
  let peer = _voicePeers.get(peerKey);
  let pc;

  if (!peer) {
    pc = await _createVoicePeer(
      data.from_id, data.from_nickname, null, false, data.from_global_user_id,
      data.peer_home_server_id || data.origin_server_id || '',
    );
  } else {
    pc = peer.pc;
    // Renegotiation glare (both sides added video at once): only the "polite"
    // side — lower stable identity key — rolls back and accepts the remote
    // offer; the impolite side ignores it so its own offer wins.
    if (pc.signalingState !== 'stable') {
      const amPolite = _voiceMyKey() < peerKey;
      if (!amPolite) return;
      try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
    }
  }

  await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
  const refreshed = _voicePeers.get(peerKey);
  if (refreshed) {
    refreshed.remoteDescApplied = true;
    if (Array.isArray(refreshed.pendingIce) && refreshed.pendingIce.length) {
      const queued = refreshed.pendingIce.slice();
      refreshed.pendingIce.length = 0;
      for (const cand of queued) {
        try { await pc.addIceCandidate(cand); } catch {}
      }
    }
  }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  
  _sendVoiceSignal({
    type: 'voice_answer',
    to_id: data.from_id || undefined,
    to_global_user_id: data.from_global_user_id || undefined,
    sdp: answer.sdp,
  });
  
  _updateVoiceBarParticipants();
}

/**
 * Handle incoming WebRTC answer from a peer.
 */
async function handleVoiceAnswer(data) {
  if (!_voiceRoom || data.room !== _voiceRoom) return;

  const peerKey = _voicePeerKey(data);
  const peer = _voicePeers.get(peerKey);
  if (!peer) return;
  
  await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
  peer.remoteDescApplied = true;
  if (Array.isArray(peer.pendingIce) && peer.pendingIce.length) {
    const queued = peer.pendingIce.slice();
    peer.pendingIce.length = 0;
    for (const cand of queued) {
      try { await peer.pc.addIceCandidate(cand); } catch {}
    }
  }
}

/**
 * Handle incoming ICE candidate from a peer.
 */
async function handleVoiceIce(data) {
  if (!_voiceRoom || data.room !== _voiceRoom) return;

  const peerKey = _voicePeerKey(data);
  const peer = _voicePeers.get(peerKey);
  if (!peer) return;
  
  let parsed;
  try { parsed = JSON.parse(data.candidate); } catch { return; }
  if (!peer.remoteDescApplied) {
    if (!Array.isArray(peer.pendingIce)) peer.pendingIce = [];
    peer.pendingIce.push(parsed);
    if (peer.pendingIce.length > 64) peer.pendingIce.splice(0, peer.pendingIce.length - 64);
    return;
  }
  try {
    await peer.pc.addIceCandidate(parsed);
  } catch {}
}

/**
 * Handle voice channel error (e.g., room full).
 */
function handleVoiceError(data) {
  toast(data.error || 'Voice channel error', 'error');
  leaveVoiceChannel();
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/* ────────────────── VOICE ACTIVITY DETECTION (VAD) ───────────────────────── */
/* ═══════════════════════════════════════════════════════════════════════════ */

let _localAudioCtx = null;
let _localAnalyser = null;
let _remoteAudioCtx = null;
let _remoteAnalyser = null;
let _vadInterval = null;

function _startLocalVAD() {
  if (!_localStream) return;
  try {
    _localAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = _localAudioCtx.createMediaStreamSource(_localStream);
    _localAnalyser = _localAudioCtx.createAnalyser();
    _localAnalyser.fftSize = 512;
    source.connect(_localAnalyser);
  } catch { return; }
  _startVADLoop();
}

function _startRemoteVAD(stream) {
  try {
    _remoteAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = _remoteAudioCtx.createMediaStreamSource(stream);
    _remoteAnalyser = _remoteAudioCtx.createAnalyser();
    _remoteAnalyser.fftSize = 512;
    source.connect(_remoteAnalyser);
  } catch {}
}

function _startVADLoop() {
  if (_vadInterval) return;
  const threshold = 25; // audio level threshold
  _vadInterval = setInterval(() => {
    // Local
    if (_localAnalyser) {
      const data = new Uint8Array(_localAnalyser.frequencyBinCount);
      _localAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const tile = document.getElementById('call-tile-local');
      if (tile) tile.classList.toggle('speaking', avg > threshold && !_mutedAudio);
    }
    // Remote
    if (_remoteAnalyser) {
      const data = new Uint8Array(_remoteAnalyser.frequencyBinCount);
      _remoteAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const tile = document.getElementById('call-tile-remote');
      if (tile) tile.classList.toggle('speaking', avg > threshold);
    }
    // Group voice channel VAD
    for (const [uid, peer] of _voicePeers) {
      if (peer.stream) {
        try {
          if (!peer._analyser) {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const src = ctx.createMediaStreamSource(peer.stream);
            peer._analyser = ctx.createAnalyser();
            peer._analyser.fftSize = 512;
            src.connect(peer._analyser);
            peer._audioCtx = ctx;
          }
          const d = new Uint8Array(peer._analyser.frequencyBinCount);
          peer._analyser.getByteFrequencyData(d);
          const avg = d.reduce((a, b) => a + b, 0) / d.length;
          const sel = `.voice-bar-avatar[data-peer-key="${CSS.escape(uid)}"]`;
          const el = document.querySelector(sel);
          if (el) el.classList.toggle('speaking', avg > threshold);
        } catch {}
      }
    }
  }, 100);
}

function _stopVAD() {
  clearInterval(_vadInterval);
  _vadInterval = null;
  try { _localAudioCtx?.close(); } catch {}
  try { _remoteAudioCtx?.close(); } catch {}
  _localAudioCtx = null; _localAnalyser = null;
  _remoteAudioCtx = null; _remoteAnalyser = null;
  // Clean up group voice analysers
  for (const [uid, peer] of _voicePeers) {
    try { peer._audioCtx?.close(); } catch {}
    peer._analyser = null; peer._audioCtx = null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/* ────────────────── CALL DEVICE SETTINGS ─────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════════════ */

async function openCallSettings() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const micSelect = document.getElementById('call-mic-select');
    const spkSelect = document.getElementById('call-speaker-select');
    const camSelect = document.getElementById('call-camera-select');
    
    micSelect.innerHTML = '';
    spkSelect.innerHTML = '';
    camSelect.innerHTML = '';
    
    let micCount = 0, spkCount = 0, camCount = 0;
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      if (d.kind === 'audioinput') {
        opt.textContent = d.label || `Microphone ${++micCount}`;
        if (_localStream) {
          const cur = _localStream.getAudioTracks()[0]?.getSettings()?.deviceId;
          if (cur === d.deviceId) opt.selected = true;
        }
        micSelect.appendChild(opt);
      } else if (d.kind === 'audiooutput') {
        opt.textContent = d.label || `Speaker ${++spkCount}`;
        spkSelect.appendChild(opt);
      } else if (d.kind === 'videoinput') {
        opt.textContent = d.label || `Camera ${++camCount}`;
        if (_localStream) {
          const cur = _localStream.getVideoTracks()[0]?.getSettings()?.deviceId;
          if (cur === d.deviceId) opt.selected = true;
        }
        camSelect.appendChild(opt);
      }
    });
    
    if (!micSelect.children.length) micSelect.innerHTML = '<option>No microphones found</option>';
    if (!spkSelect.children.length) spkSelect.innerHTML = '<option>Default speaker</option>';
    if (!camSelect.children.length) camSelect.innerHTML = '<option>No cameras found</option>';
    
    openModal('modal-call-settings');
  } catch {
    toast('Could not enumerate devices', 'error');
  }
}

async function applyCallSettings() {
  const micId = document.getElementById('call-mic-select').value;
  const camId = document.getElementById('call-camera-select').value;
  const spkId = document.getElementById('call-speaker-select').value;
  
  // Switch audio output if supported
  const rv = document.getElementById('remote-video');
  if (rv && typeof rv.setSinkId === 'function' && spkId) {
    try { await rv.setSinkId(spkId); } catch {}
  }
  
  // Switch mic/camera if in a call
  if (_localStream && _pc) {
    try {
      const constraints = { audio: { deviceId: { exact: micId } } };
      if (_callType === 'video') constraints.video = { deviceId: { exact: camId } };
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // Replace audio track
      const newAudio = newStream.getAudioTracks()[0];
      if (newAudio) {
        const sender = _pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) await sender.replaceTrack(newAudio);
        _localStream.getAudioTracks().forEach(t => t.stop());
        _localStream.addTrack(newAudio);
      }
      // Replace video track
      const newVideo = newStream.getVideoTracks()[0];
      if (newVideo) {
        const sender = _pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newVideo);
        _localStream.getVideoTracks().forEach(t => t.stop());
        _localStream.addTrack(newVideo);
        document.getElementById('local-video').srcObject = _localStream;
      }
    } catch (e) {
      toast('Could not switch device', 'error');
    }
  }
  
  closeModal('modal-call-settings');
  toast('Audio settings applied', 'success');
}

try {
  window.handleCallOffer = handleCallOffer;
  window.acceptCall = acceptCall;
  window.rejectCall = rejectCall;
  window.showIncomingCall = showIncomingCall;
  window.hideIncomingCall = hideIncomingCall;
  window.ensureCallSignalingReady = ensureCallSignalingReady;
  window.isCallSignalingReady = () => _wsLooksOpen();
  window.isCallSessionBusy = isCallSessionBusy;
  // Native screen-share receive handlers (dispatched from ws.js) + the
  // bridge callbacks the Android shell invokes via evaluateJavascript.
  window.handleScreenOffer = handleScreenOffer;
  window.handleScreenAnswer = handleScreenAnswer;
  window.handleScreenIce = handleScreenIce;
  window.handleScreenEnd = handleScreenEnd;
  window.onNativeScreenShareStarted = onNativeScreenShareStarted;
  window.onNativeScreenShareStopped = onNativeScreenShareStopped;
  window.onNativeScreenShareError = onNativeScreenShareError;
} catch {}

function _maybeRecoverPendingIncomingCall () {
  try {
    if (typeof ensureIncomingCallSurfaceVisible === 'function' && ensureIncomingCallSurfaceVisible()) return;
    if (typeof _callState !== 'undefined' && (_callState === 'calling' || _callState === 'active')) return;
    if (typeof isIncomingCallActive === 'function' && isIncomingCallActive()) return;
    if (!window.App?.recoverLatestIncomingCall) return;
    void window.App.recoverLatestIncomingCall({ silent: true });
  } catch {}
}

try {
  resetStaleCallUiOnBoot();
  window.addEventListener('ws:open', _maybeRecoverPendingIncomingCall);
  window.addEventListener('ws:open', () => {
    setTimeout(() => _refreshIncomingAcceptAvailability(), 0);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _maybeRecoverPendingIncomingCall();
  });
  window.addEventListener('pagehide', _abandonCallOnPageHide, { capture: true });
  window.addEventListener('beforeunload', _abandonCallOnPageHide);
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) resetStaleCallUiOnBoot();
  });
} catch {}
