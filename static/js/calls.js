/* ─── calls.js ─────────────────────────────────────────────────────────────── */
'use strict';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:161.97.182.73:3478' },
  {
    urls: 'turn:161.97.182.73:3478',
    username: 'frogtalk',
    credential: 'FrogTurn2024!'
  },
  {
    urls: 'turn:161.97.182.73:3478?transport=tcp',
    username: 'frogtalk',
    credential: 'FrogTurn2024!'
  },
  // TLS-on-5349 / TLS-on-443: punches through carrier networks and corporate
  // firewalls that block 3478 udp/tcp. If coturn isn't TLS-configured these
  // entries simply fail to gather — the plain TURN entries above still work.
  {
    urls: 'turns:161.97.182.73:5349?transport=tcp',
    username: 'frogtalk',
    credential: 'FrogTurn2024!'
  },
  {
    urls: 'turns:161.97.182.73:443?transport=tcp',
    username: 'frogtalk',
    credential: 'FrogTurn2024!'
  }
];

let _pc           = null;   // RTCPeerConnection
let _localStream  = null;
let _screenStream = null;
let _callState    = 'idle'; // idle | calling | ringing | active
let _callType     = 'voice';
let _callPeerNick = null;
let _callPeerUID  = null;
let _callId       = null;
let _callTimer    = null;
let _callSeconds  = 0;
let _mutedAudio   = false;
let _mutedVideo   = false;
let _speakerMuted = false;
let _callRingTimeout = null;
let _reconnectTimer = null;
let _callPeerAvatar = null;
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

// Outbound buffer for call signaling that fires before the WS reaches OPEN
// (cold-start callees gather ICE while the socket is still in CONNECTING).
// wsSend()/WS.send() silently no-op in that window, so without this buffer
// the callee's local ICE candidates are lost forever — producing the
// "connected but stuck on Connecting…" deadlock.
const _outboundCallQueue = [];
function _wsLooksOpen() {
  try { return (typeof WS !== 'undefined' && typeof WS.isOpen === 'function') ? WS.isOpen() : true; }
  catch { return true; }
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
try {
  window.addEventListener('ws:open', () => {
    // Tiny delay so wsSend() sees readyState=OPEN.
    setTimeout(_flushOutboundCallQueue, 0);
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

async function _signCallFp(callId, peerUserId, sdp) {
  try {
    if (!window.Signal || !Signal.isReady?.()) return '';
    if (!callId || !peerUserId) return '';
    const fp = _extractDtlsFp(sdp);
    if (!fp) return '';
    return await Signal.signCallFingerprint({
      call_id: callId,
      peer_user_id: peerUserId,
      fingerprint_sha256: fp,
    });
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
  let expectedIdentityPub = null;
  try { expectedIdentityPub = await Signal.getPeerIdentityKey(fromId); } catch {}
  if (!expectedIdentityPub) {
    return { ok: 'unverified', reason: 'no_peer_identity' };
  }
  try {
    const vopts = {
      expectedPeerUserId: Number(myId),
      expectedFingerprint: fp,
      expectedIdentityPub,
    };
    // bindCallId=false on the initial inbound offer because the caller
    // doesn't know the server-assigned call_id at sign time.
    if (!(opts && opts.bindCallId === false)) {
      vopts.expectedCallId = Number(callId);
    }
    const res = await Signal.verifyCallFingerprint(envelope, vopts);
    if (res && res.ok) return { ok: true };
    return { ok: false, reason: (res && res.reason) || 'unknown' };
  } catch (e) {
    return { ok: false, reason: 'verify_threw' };
  }
}

function _isVerifyFatal(reason) {
  // Hard-fail reasons mean a real signalling tamper, not an absence of
  // signing material. Anything else is downgraded to "unverified".
  return reason === 'bad_signature'
      || reason === 'identity_mismatch'
      || reason === 'call_id_mismatch'
      || reason === 'peer_mismatch'
      || reason === 'fingerprint_mismatch'
      || reason === 'stale';
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
    // Fallback: render simple avatar with initial
    const s = String(avatarData || '');
    if (s && (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/'))) {
      ra.innerHTML = `<img src="${s}" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover;display:inline-block">`;
    } else if (s) {
      ra.innerHTML = `<span style="display:inline-flex;width:96px;height:96px;border-radius:50%;background:#1a2a1a;align-items:center;justify-content:center;font-size:52px;vertical-align:middle">${s}</span>`;
    } else {
      ra.innerHTML = `<div style="font-size:3rem">${safeNick.charAt(0).toUpperCase()}</div>`;
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

/* ── Initiate call ─────────────────────────────────────────────────────────── */
async function startCall (type, nick, uid) {
  if (_callState !== 'idle') { toast('Already in a call', 'error'); return; }
  // If WS is mid-reconnect, give it a brief window to come back so the
  // call_offer rides a live socket. Don't abort if it's still not open —
  // _sendCallSignal() buffers into _outboundCallQueue and ws:open flushes,
  // so the dial still works once the socket finishes its handshake.
  if (!_wsLooksOpen()) {
    try { await _waitForWsOpen(8_000); } catch {}
  }
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

  await _ensureCallPeerAvatar();

  _callState = 'calling';
  showCallOverlay(type, _callPeerNick, 'Calling…', _callPeerAvatar);

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

  try {
    if (type === 'video') {
      const lv = document.getElementById('local-video');
      const la = document.getElementById('call-local-avatar');
      if (lv) { lv.srcObject = _localStream; lv.style.display = ''; }
      if (la) la.style.display = 'none';
    }

    _pc = createPC();
    _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

    const offer = await _pc.createOffer();
    await _pc.setLocalDescription(offer);

    // Track E: sign DTLS fingerprint with our Signal identity. Caller
    // doesn't know call_id yet (server assigns) so we sign with call_id=0
    // as a sentinel — the server-side `pending_call_offers.fp_sig`
    // passthrough preserves the envelope verbatim and the callee's
    // verifier downgrades to "unverified" if it can't bind a call_id.
    // (A future tweak: re-sign on call_created with the real id.)
    const fp_sig = await _signCallFp(0, _callPeerUID || 0, offer.sdp);

    _maybeWarnIdentityRotation(_callPeerUID);

    _sendCallSignal({
      type         : 'call_offer',
      to_id        : _callPeerUID || undefined,
      to_nickname  : _callPeerNick,
      call_type    : type,
      sdp          : offer.sdp,
      fp_sig       : fp_sig || undefined,
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
    toast('Call setup failed: ' + (e?.message || 'unknown error'), 'error');
    endCall();
  }
}

/* ── Called from friends panel shortcut ────────────────────────────────────── */
async function callNick (nick, type) {
  await openDMWithNick(nick);
  setTimeout(() => startCall(type, nick), 800);
}

/* ── Receive offer (incoming) ──────────────────────────────────────────────── */
async function handleCallOffer (data) {
  // Mid-call renegotiation from the same peer (camera turned on, screen-share, etc.)
  if (data.renegotiate && _callState === 'active' && _pc &&
      data.from_nickname === _callPeerNick) {
    try {
      // If the caller is forcing relay (TURN-only ICE restart), mirror that
      // on this side too — otherwise the answerer keeps offering host/srflx
      // candidates that can't pair with the caller's relay-only set, and
      // the restart never converges.
      if (data.force_relay) {
        try { _pc.setConfiguration({ iceServers: ICE_SERVERS, iceTransportPolicy: 'relay' }); } catch {}
      }
      await _pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      const ans = await _pc.createAnswer();
      await _pc.setLocalDescription(ans);
      const renegFp = await _signCallFp(data.call_id || _callId || 0, _callPeerUID || data.from_id || 0, ans.sdp);
      _sendCallSignal({
        type: 'call_answer',
        to_nickname: _callPeerNick,
        call_id: data.call_id,
        sdp: ans.sdp,
        renegotiate: true,
        fp_sig: renegFp || undefined,
      });
    } catch (e) { console.warn('renegotiate answer failed', e); }
    return;
  }
  if (_callState !== 'idle') {
    // Same call we're already on: drop silently. The caller's live WS push
    // and our REST recovery both deliver the same offer to a cold-started
    // client — without this, the second arrival triggers call_reject(busy)
    // and the caller hangs up while we're still ringing/active.
    if (data.call_id && _callId && String(data.call_id) === String(_callId)) {
      return;
    }
    _sendCallSignal({ type: 'call_reject', to_nickname: data.from_nickname, reason: 'busy' });
    return;
  }
  _callState    = 'ringing';
  _callType     = data.call_type || 'voice';
  _callPeerNick = data.from_nickname;
  _callPeerUID  = data.from_id || _callPeerUID;
  _callPeerAvatar = data.from_avatar || null;
  _callId       = data.call_id || null;
  _pendingOffer = { sdp: data.sdp, call_id: data.call_id || null, from_id: data.from_id, fp_sig: data.fp_sig };
  // Track E: verify caller's signed DTLS fingerprint envelope. The caller
  // signs at offer time before the server has assigned a call_id, so we
  // skip the call_id binding for the initial offer. acceptCall's outbound
  // call_answer carries the real call_id and is verified strictly by the
  // peer on their handleCallAnswer path.
  try {
    _callUnverified = false;
    const v = await _verifyCallFp(data.fp_sig, data.call_id, data.from_id, data.sdp, { bindCallId: false });
    if (v.ok === false && _isVerifyFatal(v.reason)) {
      toast('Signalling tampering detected (' + v.reason + ') — call refused', 'error');
      console.error('[calls][track-E] inbound offer rejected:', v.reason);
      _sendCallSignal({ type: 'call_reject', to_nickname: data.from_nickname, call_id: data.call_id || undefined, reason: 'tampering' });
      _pendingOffer = null;
      _callState = 'idle'; _callPeerNick = null; _callPeerUID = null; _callId = null;
      return;
    }
    if (v.ok !== true) {
      _callUnverified = true;
      console.warn('[calls][track-E] inbound offer UNVERIFIED:', v.reason);
    }
  } catch (e) { console.warn('[calls][track-E] verify offer threw', e); _callUnverified = true; }
  _maybeWarnIdentityRotation(_callPeerUID);
  _persistIncomingCall(data);
  showIncomingCall(data.from_nickname, data.call_type, data.from_avatar || null);
  try { Notifications.startRinging(data.from_nickname); } catch {}
  try {
    if (window.desktopApp?.showNotification) {
      const label = (data.call_type === 'video') ? 'video' : 'voice';
      window.desktopApp.showNotification('📞 Incoming call', `${data.from_nickname || 'Someone'} is calling (${label})`);
    }
  } catch {}
  // Best-effort: fire native ring on Android so the user can hear/see the call
  // even when the browser tab isn't focused. Full force-closed wake requires FCM.
  try {
    if (window.Android && typeof window.Android.ringForCall === 'function') {
      window.Android.ringForCall(String(data.from_nickname || ''), String(data.call_id || ''));
    }
  } catch {}
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
  _acceptInFlight = true;
  // Snapshot so a concurrent reset/finally can't null it out from under
  // the awaits below.
  const offer = _pendingOffer;
  // If user answered from outside the DM view (Android tray / Electron),
  // bring the DM thread into view in the background.
  try {
    if (_callPeerNick && typeof openDMWithNick === 'function') {
      if (!_activeDM || _activeDM.nickname !== _callPeerNick) {
        await openDMWithNick(_callPeerNick);
      }
    }
  } catch {}
  await _ensureCallPeerAvatar();
  showCallOverlay(_callType, _callPeerNick, 'Connecting…', _callPeerAvatar);
  _callState = 'active';

  try {
    _localStream = await navigator.mediaDevices.getUserMedia(
      _callType === 'video' ? { audio: true, video: true } : { audio: true }
    );
  } catch (e) {
    console.error('getUserMedia (accept) failed', e);
    toast('Microphone/camera permission denied', 'error');
    endCall();
    return;
  }

  // Permission granted — safe to start the native call notification now.
  _startAndroidCallNotification(_callPeerNick);

  try {
    _pc = createPC();
    _localStream.getTracks().forEach(t => _pc.addTrack(t, _localStream));

    await _pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    _remoteDescApplied = true;
    _flushPendingIce();
    const answer = await _pc.createAnswer();
    await _pc.setLocalDescription(answer);

    const answerCallId = offer.call_id || _callId || 0;
    const fp_sig = await _signCallFp(answerCallId, _callPeerUID || (_pendingOffer && _pendingOffer.from_id) || 0, answer.sdp);

    _sendCallAnswerReliable({
      type        : 'call_answer',
      to_nickname : _callPeerNick,
      call_id     : offer.call_id || _callId || undefined,
      sdp         : answer.sdp,
      fp_sig      : fp_sig || undefined,
    });
    _armConnectingHardCap();

    if (_callType === 'video') {
      const lv = document.getElementById('local-video');
      const la = document.getElementById('call-local-avatar');
      if (lv) { lv.srcObject = _localStream; lv.style.display = ''; }
      if (la) la.style.display = 'none';
    }
  } catch (e) {
    console.error('acceptCall setup failed', e);
    toast('Call setup failed: ' + (e?.message || 'unknown error'), 'error');
    endCall();
    return;
  } finally {
    _pendingOffer = null;
    _acceptInFlight = false;
  }
}

function rejectCall () {
  _clearPersistedIncomingCall();
  _sendCallSignal({ type: 'call_reject', to_nickname: _callPeerNick, call_id: _callId || undefined, reason: 'declined' });
  hideIncomingCall();
  try { Notifications.stopRinging(); } catch {}
  try { window.Android?.dismissRing?.(); } catch {}
  resetCall();
}

/* ── Call created confirmation (server sends call_id back to caller) ────────── */
function handleCallCreated (data) {
  if (data.call_id && _callState === 'calling') {
    _callId = data.call_id;
  }
}

/* ── Receive answer ────────────────────────────────────────────────────────── */
async function handleCallAnswer (data) {
  if (!_pc) return;
  clearTimeout(_callRingTimeout); _callRingTimeout = null;
  // Track E: verify callee's signed DTLS fingerprint envelope against the
  // SDP we're about to apply. Callee signs with the real call_id, so we
  // bind it here. Fatal verify reasons → tear down before the DTLS
  // handshake can start with a tampered fingerprint.
  try {
    const callIdForVerify = data.call_id || _callId || 0;
    const fromIdForVerify = data.from_id || _callPeerUID || 0;
    const v = await _verifyCallFp(data.fp_sig, callIdForVerify, fromIdForVerify, data.sdp);
    if (v.ok === false && _isVerifyFatal(v.reason)) {
      toast('Signalling tampering detected (' + v.reason + ') — call ended', 'error');
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
    // Don't silently swallow — the call is dead. End cleanly with
    // was_connected:true so the server doesn't mark it as a missed call
    // (we *did* reach the answer step; the failure is local SDP).
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
        try { _pc.setConfiguration({ iceServers: ICE_SERVERS, iceTransportPolicy: 'relay' }); } catch {}
        _pc.restartIce();
        const offer = await _pc.createOffer({ iceRestart: true });
        await _pc.setLocalDescription(offer);
        const restartFp = await _signCallFp(_callId || 0, _callPeerUID || 0, offer.sdp);
        _sendCallSignal({
          type: 'call_offer',
          to_nickname: _callPeerNick,
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

/* ── Remote rejected ───────────────────────────────────────────────────────── */
function handleCallReject (data) {
  _clearPersistedIncomingCall();
  _callId = data?.call_id || _callId;
  toast(_callPeerNick + ' declined the call');
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
  _clearPersistedIncomingCall();
  _callId = data?.call_id || _callId;
  const wasRinging = _callState === 'ringing';
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
  } else {
    toast('Call ended');
  }
  endCall(false);
}

/* ── End call ──────────────────────────────────────────────────────────────── */
function endCall (notifyPeer = true) {
  if (notifyPeer) {
    const wasConnected = (_callState === 'active') || ((_callSeconds | 0) > 0);
    const durationSecs = (_callSeconds | 0) > 0 ? (_callSeconds | 0) : undefined;
    try {
      _sendCallSignal({
        type: 'call_end',
        to_nickname: _callPeerNick,
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
  const deadline = Date.now() + 10_000;
  const attempt = () => {
    if (!_pendingAnswerSend) return;
    const open = (typeof WS !== 'undefined' && typeof WS.isOpen === 'function')
      ? WS.isOpen() : true;
    if (open) {
      try { wsSend(_pendingAnswerSend); _pendingAnswerSend = null; return; } catch {}
    }
    if (Date.now() >= deadline) {
      _pendingAnswerSend = null;
      console.warn('[calls] could not deliver call_answer within 10 s — giving up');
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
    if (_localStream) { try { _localStream.getTracks().forEach(t => t.stop()); } catch {} _localStream = null; }
    if (_screenStream) { try { _screenStream.getTracks().forEach(t => t.stop()); } catch {} _screenStream = null; }
    clearInterval(_callTimer); _callTimer = null; _callSeconds = 0;
    clearTimeout(_callRingTimeout); _callRingTimeout = null;
    clearTimeout(_reconnectTimer); _reconnectTimer = null;
    clearTimeout(_connectingHardCap); _connectingHardCap = null;
    clearTimeout(_pendingAnswerRetryTimer); _pendingAnswerRetryTimer = null;
    _pendingAnswerSend = null;
    _pendingIceQueue.length = 0;
    _outboundCallQueue.length = 0;
    _remoteDescApplied = false;
    _callUnverified = false;
    _didRelayRetry = false;
    _autoAcceptPending = false;
    _callState = 'idle'; _callPeerNick = null; _callPeerUID = null; _callId = null;
    _callPeerAvatar = null;
    _mutedAudio = false; _mutedVideo = false; _speakerMuted = false;
    try { _stopVAD(); } catch {}
    const rv = document.getElementById('remote-video');
    const lv = document.getElementById('local-video');
    if (rv) { rv.srcObject = null; rv.style.display = 'none'; }
    if (lv) { lv.srcObject = null; lv.style.display = 'none'; }
    // Show avatars again
    const ra = document.getElementById('call-remote-avatar');
    const la = document.getElementById('call-local-avatar');
    if (ra) ra.style.display = '';
    if (la) la.style.display = '';
    const tm = document.getElementById('call-timer'); if (tm) tm.textContent = '';
    document.getElementById('call-tile-remote')?.classList.remove('speaking');
    document.getElementById('call-tile-local')?.classList.remove('speaking');
    const bMute = document.getElementById('btn-call-mute');
    if (bMute) { bMute.textContent = '🎤'; bMute.classList.remove('muted'); }
    try { window.Android?.dismissRing?.(); } catch {}
    try { window.Android?.endCallNotification?.(); } catch {}
  } catch (e) {
    console.warn('resetCall error (non-fatal)', e);
  }
}

/* ── RTCPeerConnection factory ─────────────────────────────────────────────── */
function createPC () {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = e => {
    if (e.candidate && _callPeerNick) {
      _sendCallSignal({ type: 'ice_candidate', to_nickname: _callPeerNick, call_id: _callId || undefined, candidate: JSON.stringify(e.candidate) });
    }
  };

  pc.ontrack = e => {
    try {
      const rv = document.getElementById('remote-video');
      if (!rv) return;
      if (!rv.srcObject) rv.srcObject = new MediaStream();
      rv.srcObject.addTrack(e.track);
      // Reveal remote video element whenever ANY video track arrives —
      // covers voice calls that get upgraded mid-stream via screen share
      // or camera-on renegotiation (peer must see it regardless of initial type).
      if (e.track.kind === 'video') {
        rv.style.display = '';
        const ra = document.getElementById('call-remote-avatar');
        if (ra) ra.style.display = 'none';
      }
      // Force a play() — Android Chrome / iOS Safari sometimes don't start
      // playback automatically when srcObject mutates after element is in
      // the DOM, leaving a "connected" call with no audio output.
      try {
        const p = rv.play();
        if (p && typeof p.catch === 'function') {
          p.catch(err => {
            // Autoplay rejected (rare since accept-tap is a user gesture).
            // Try once more on next user interaction as a safety net.
            console.warn('remote rv.play() rejected, will retry on interaction', err?.name || err);
            const retry = () => {
              rv.play().catch(() => {});
              document.removeEventListener('click', retry);
              document.removeEventListener('touchend', retry);
            };
            document.addEventListener('click', retry, { once: true });
            document.addEventListener('touchend', retry, { once: true });
          });
        }
      } catch {}
      // Start remote voice activity detection
      if (e.track.kind === 'audio' && rv.srcObject) {
        _startRemoteVAD(rv.srcObject);
      }
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
        // Clear any pending reconnect timer — we're back.
        clearTimeout(_reconnectTimer); _reconnectTimer = null;
        // Always show cam/screen buttons — user can enable mid-call
        const bCam = document.getElementById('btn-call-cam');
        const bSc  = document.getElementById('btn-call-screen');
        if (bCam) bCam.style.display = '';
        if (bSc)  bSc.style.display  = '';
        _startLocalVAD();
      } else if (s === 'disconnected') {
        // Transient network hiccup — give ICE 15s to recover before tearing down.
        if (st) st.textContent = 'Reconnecting…';
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
}

/* Renegotiate with peer after adding/replacing a track mid-call (voice→video, screen-share, etc.). */
async function _renegotiate () {
  if (!_pc || !_callPeerNick) return;
  try {
    const offer = await _pc.createOffer();
    await _pc.setLocalDescription(offer);
    wsSend({
      type: 'call_offer',
      to_nickname: _callPeerNick,
      call_type: _callType,
      sdp: offer.sdp,
      renegotiate: true,
    });
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
    if (btn) btn.textContent = _mutedVideo ? '🚫' : '📷';
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
    if (btn) btn.textContent = '📷';
    toast('Camera on', 'info');
  } catch (e) {
    console.error('camera enable failed', e);
    toast('Camera access denied', 'error');
  }
}

async function toggleScreenShare () {
  const btn = document.getElementById('btn-call-screen');
  if (!_pc) { toast('No active call', 'error'); return; }
  const isAndroidWebView = /Android/i.test(navigator.userAgent || '') && !!window.Android;
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
  // Start sharing.
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      if (isAndroidWebView) {
        toast('Screen share is not supported by this Android WebView build', 'error');
      } else {
        toast('Screen share is not supported on this device/browser', 'error');
      }
      return;
    }
    _screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = _screenStream.getVideoTracks()[0];
    if (!screenTrack) return;
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
    // User cancelled the picker — silent.
    if (e && e.name !== 'NotAllowedError') {
      console.warn('screen share failed', e);
      if (isAndroidWebView) {
        toast('Screen share failed in Android WebView. Update Android System WebView/Chrome.', 'error');
      } else {
        toast('Screen share failed', 'error');
      }
    }
  }
}

function toggleCallSpeaker () {
  const rv = document.getElementById('remote-video');
  _speakerMuted = !_speakerMuted;
  rv.muted = _speakerMuted;
  document.getElementById('btn-call-speaker').textContent = _speakerMuted ? '🔈' : '🔊';
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
    document.getElementById('call-timer').textContent = m + ':' + s;
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
  if (selfAv) selfAv.innerHTML = State.user?.avatar
    ? `<img src="${State.user.avatar}" style="width:96px;height:96px;border-radius:50%;object-fit:cover">`
    : `<div style="font-size:3rem">${(State.user?.nickname||'?')[0].toUpperCase()}</div>`;
  _renderPeerAvatar(peerNick, avatar);
  _ensureCallPeerAvatar(true).catch(() => {});
  document.getElementById('call-overlay')?.classList.remove('hidden');
  // Show all control buttons immediately
  const bCam = document.getElementById('btn-call-cam');
  const bSc  = document.getElementById('btn-call-screen');
  if (bCam) bCam.style.display = '';
  if (bSc)  bSc.style.display  = '';
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
  _stopVAD();
  // Android: dismiss call notification
  try { if (window.Android?.endCallNotification) window.Android.endCallNotification(); } catch {}
}

function showIncomingCall (nick, type, avatar) {
  const safeNick = String(nick || '').trim() || 'Unknown';
  const card = document.getElementById('incoming-call');
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

function isIncomingCallActive () {
  try {
    const card = document.getElementById('incoming-call');
    const visible = !!(card && !card.classList.contains('hidden'));
    return _callState === 'ringing' || visible || !!_pendingOffer;
  } catch {
    return false;
  }
}

try { window.isIncomingCallActive = isIncomingCallActive; } catch {}

function hideIncomingCall () {
  document.getElementById('incoming-call').classList.add('hidden');
  try { Notifications.stopRinging(); } catch {}
  try { window._ringtoneCtx?.stop?.(); } catch {}
  window._ringtoneCtx = null;
}

/* ── Called from user-info modal ────────────────────────────────────────────── */
function callUserInfo (type) {
  const nick = document.getElementById('userinfo-name').dataset.nick;
  if (!nick) return;
  closeModal('modal-user-info');
  openDMWithNick(nick).then(() => setTimeout(() => startCall(type, nick), 300));
}


/* ═══════════════════════════════════════════════════════════════════════════ */
/* ────────────────── GROUP VOICE CHANNEL (MESH TOPOLOGY) ──────────────────── */
/* ═══════════════════════════════════════════════════════════════════════════ */

// Map of user_id -> { pc: RTCPeerConnection, stream: MediaStream }
const _voicePeers = new Map();
let _voiceStream = null;
let _voiceRoom = null;

/* ── Discord-style voice presence bar for current channel ──────────────────
   Tracks everyone currently in voice for the channel the user is VIEWING,
   even before they've joined the call themselves. */
let _presenceRoom = null;                 // room name currently displayed
const _presenceRoster = new Map();        // room name -> array of {user_id, nickname, avatar}

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
    _presenceRoster.set(roomName, Array.isArray(data.participants) ? data.participants : []);
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
  if (_voiceRoom === roomName && myId && !roster.some(p => p.user_id === myId)) {
    roster.unshift({ user_id: myId, nickname: State.user?.nickname || 'You', avatar: State.user?.avatar || '' });
  }
  if (!roster.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }

  const iAmHere = _voiceRoom === roomName;
  const avatars = roster.slice(0, 12).map(p => {
    const self = p.user_id === myId;
    const safeNick = (p.nickname || '?').replace(/"/g, '&quot;');
    const initials = (p.nickname || '?').slice(0, 2).toUpperCase();
    const img = (p.avatar && String(p.avatar).startsWith('data:'))
      ? `<img src="${p.avatar}" alt="">`
      : (p.avatar ? `<span style="font-size:14px">${p.avatar}</span>` : initials);
    return `<div class="vp-avatar${self ? ' self' : ''}" title="${safeNick}" data-uid="${p.user_id}">${img}</div>`;
  }).join('');
  const extra = roster.length > 12 ? `<div class="vp-avatar" title="+${roster.length - 12} more">+${roster.length - 12}</div>` : '';

  bar.innerHTML = `
    <div class="vp-label">🔊 In voice · ${roster.length}</div>
    <div class="vp-list">${avatars}${extra}</div>
    ${iAmHere
      ? `<button class="vp-join leave" onclick="leaveVoiceChannel()">Leave</button>`
      : `<button class="vp-join" onclick="joinVoiceChannel()">Join</button>`}
  `;
  bar.style.display = 'flex';
}

function _presenceAdd(roomName, p) {
  const list = _presenceRoster.get(roomName) || [];
  if (!list.some(x => x.user_id === p.user_id)) list.push(p);
  _presenceRoster.set(roomName, list);
  if (roomName === _presenceRoom) _renderVoicePresenceBar(roomName);
}

function _presenceRemove(roomName, userId) {
  const list = _presenceRoster.get(roomName) || [];
  _presenceRoster.set(roomName, list.filter(x => x.user_id !== userId));
  if (roomName === _presenceRoom) _renderVoicePresenceBar(roomName);
}

/** Returns nicknames of all users currently in voice call */
function getVoiceParticipantNicks() {
  const nicks = new Set();
  // Include self if in a voice channel
  if (_voiceRoom && State.user?.nickname) nicks.add(State.user.nickname);
  for (const [, peer] of _voicePeers) nicks.add(peer.nickname);
  return nicks;
}
let _voiceMuted = false;

/**
 * Join the voice channel for the current room (public rooms only).
 */
async function joinVoiceChannel() {
  if (_voiceRoom) {
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

  try {
    _voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  wsSend({ type: 'voice_join' });
  // Refresh member list to show voice badge
  if (typeof Users !== 'undefined' && State.onlineUsers) Users.updateList(State.onlineUsers);
}

/**
 * Leave the voice channel and clean up all peer connections.
 */
function leaveVoiceChannel() {
  if (!_voiceRoom) return;

  // Tell server we're leaving
  wsSend({ type: 'voice_leave' });

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
}

/**
 * Mute/unmute a specific peer's audio locally.
 */
function toggleMutePeer(userId) {
  const peer = _voicePeers.get(userId);
  if (!peer) return;
  peer.muted = !peer.muted;
  const audioEl = document.getElementById(`voice-audio-${userId}`);
  if (audioEl) audioEl.muted = peer.muted;
  toast(peer.muted ? `Muted ${peer.nickname}` : `Unmuted ${peer.nickname}`);
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
  if (!data || !data.user_id) return;
  _voicePeerMuted.set(data.user_id, !!data.muted);
  try { if (typeof renderUsers === 'function') renderUsers(); } catch {}
  try { _renderVoicePresenceBar?.(_voiceRoom); } catch {}
}

/**
 * Create a peer connection for a specific user in the voice channel.
 */
function _createVoicePeer(userId, nickname, avatar, isOfferer) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  
  // Add local audio track
  if (_voiceStream) {
    _voiceStream.getTracks().forEach(t => pc.addTrack(t, _voiceStream));
  }

  // Handle incoming remote audio
  pc.ontrack = (e) => {
    const existing = _voicePeers.get(userId);
    if (existing) {
      existing.stream = e.streams[0];
      // Create audio element to play remote audio
      let audio = document.getElementById(`voice-audio-${userId}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `voice-audio-${userId}`;
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = e.streams[0];
    }
  };

  // Send ICE candidates to peer
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      wsSend({
        type: 'voice_ice',
        to_id: userId,
        candidate: JSON.stringify(e.candidate)
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      _updateVoiceBarParticipants();
    }
  };

  _voicePeers.set(userId, { pc, nickname, avatar, stream: null });
  
  return pc;
}

/**
 * Update the voice bar participant avatars.
 */
function _updateVoiceBarParticipants() {
  const container = document.getElementById('voice-bar-participants');
  container.innerHTML = '';
  
  for (const [uid, peer] of _voicePeers) {
    const div = document.createElement('div');
    div.className = 'voice-bar-avatar';
    div.title = peer.nickname + ' (click to mute/unmute)';
    div.setAttribute('data-uid', uid);
    div.style.cursor = 'pointer';
    div.style.position = 'relative';
    if (peer.avatar) {
      div.innerHTML = `<img src="${esc(peer.avatar)}" alt="">`;
    } else {
      div.textContent = peer.nickname.slice(0, 2).toUpperCase();
    }
    // Click to mute/unmute this participant
    div.onclick = () => toggleMutePeer(uid);
    if (peer.muted) {
      div.style.opacity = '0.4';
      div.innerHTML += '<span style="position:absolute;bottom:-2px;right:-2px;font-size:10px">🔇</span>';
    }
    container.appendChild(div);
  }
  
  document.getElementById('voice-bar-status').textContent = 
    `${_voicePeers.size + 1} connected`;
  
  // Refresh sidebar user list to show/clear in-call badges
  if (typeof Users !== 'undefined' && State.onlineUsers) Users.updateList(State.onlineUsers);

  // Start VAD loop for group voice
  _startVADLoop();
}

/* ── Voice channel WebSocket message handlers ──────────────────────────────── */

/**
 * Handle confirmation that we joined the voice channel.
 * Contains list of existing participants to connect to.
 */
async function handleVoiceJoined(data) {
  document.getElementById('voice-bar-status').textContent = 'Connected';

  // Seed the presence roster for our current room with the existing peers.
  if (_voiceRoom) {
    const roster = (data.participants || []).map(p => ({
      user_id: p.user_id, nickname: p.nickname, avatar: p.avatar || ''
    }));
    // Include self (server excludes us from "existing")
    if (State.user?.id && !roster.some(p => p.user_id === State.user.id)) {
      roster.push({ user_id: State.user.id, nickname: State.user.nickname, avatar: State.user.avatar || '' });
    }
    _presenceRoster.set(_voiceRoom, roster);
    if (_voiceRoom === _presenceRoom) _renderVoicePresenceBar(_voiceRoom);
  }

  // Connect to each existing participant (we are the offerer)
  for (const p of data.participants || []) {
    const pc = _createVoicePeer(p.user_id, p.nickname, p.avatar, true);

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    wsSend({
      type: 'voice_offer',
      to_id: p.user_id,
      sdp: offer.sdp
    });
  }

  _updateVoiceBarParticipants();
}

/**
 * Handle when another user joins the voice channel.
 * They will send us an offer, so we just wait.
 */
function handleVoiceUserJoined(data) {
  // No toast — voice presence bar already reflects the new participant.
  // Server-broadcast includes the room implicitly (we're in it). Use whichever
  // room the broadcast matches: for the voice-presence bar we only need the
  // channel the user is currently VIEWING.
  const room = data.room || _voiceRoom || _presenceRoom;
  if (room) _presenceAdd(room, {
    user_id: data.user_id, nickname: data.nickname, avatar: data.avatar || ''
  });
  try { if (typeof renderUsers === 'function') renderUsers(); } catch {}
  // They will send us an offer, we'll handle it in handleVoiceOffer
}

/**
 * Handle when another user leaves the voice channel.
 */
function handleVoiceUserLeft(data) {
  // No toast — voice bar updates silently.

  const peer = _voicePeers.get(data.user_id);
  if (peer) {
    try { peer.pc.close(); } catch {}
    // Remove audio element
    const audio = document.getElementById(`voice-audio-${data.user_id}`);
    if (audio) audio.remove();
  }
  _voicePeers.delete(data.user_id);
  _voicePeerMuted.delete(data.user_id);

  const room = data.room || _voiceRoom || _presenceRoom;
  if (room) _presenceRemove(room, data.user_id);

  _updateVoiceBarParticipants();
  try { if (typeof renderUsers === 'function') renderUsers(); } catch {}
}

/**
 * Handle incoming WebRTC offer from a peer.
 */
async function handleVoiceOffer(data) {
  if (!_voiceRoom || data.room !== _voiceRoom) return;
  
  // Create peer connection (we are answering)
  let peer = _voicePeers.get(data.from_id);
  let pc;
  
  if (!peer) {
    pc = _createVoicePeer(data.from_id, data.from_nickname, null, false);
  } else {
    pc = peer.pc;
  }
  
  await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  
  wsSend({
    type: 'voice_answer',
    to_id: data.from_id,
    sdp: answer.sdp
  });
  
  _updateVoiceBarParticipants();
}

/**
 * Handle incoming WebRTC answer from a peer.
 */
async function handleVoiceAnswer(data) {
  if (!_voiceRoom || data.room !== _voiceRoom) return;
  
  const peer = _voicePeers.get(data.from_id);
  if (!peer) return;
  
  await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
}

/**
 * Handle incoming ICE candidate from a peer.
 */
async function handleVoiceIce(data) {
  if (!_voiceRoom || data.room !== _voiceRoom) return;
  
  const peer = _voicePeers.get(data.from_id);
  if (!peer) return;
  
  try {
    await peer.pc.addIceCandidate(JSON.parse(data.candidate));
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
          const el = document.querySelector(`.voice-bar-avatar[data-uid="${uid}"]`);
          if (el) el.style.borderColor = avg > threshold ? '#4caf50' : '#1a3a1a';
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
