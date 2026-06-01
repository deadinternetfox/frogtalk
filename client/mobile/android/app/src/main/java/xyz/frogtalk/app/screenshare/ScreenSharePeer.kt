package xyz.frogtalk.app.screenshare

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * One-way (sendonly) screen-share. Captures the device screen via MediaProjection
 * ONCE and fans the single encoded video track out to every recipient over its
 * own [PeerConnection], signalled through a shared multiplexed
 * [ScreenShareSignaling]. The call's own audio/video stay in the WebView's
 * RTCPeerConnection — this carries ONLY the screen.
 *
 * For a 1-on-1 call there is exactly one recipient, so this behaves identically
 * to the original single-peer implementation. For a group voice channel there is
 * one peer connection per participant, all sharing the same capturer/track.
 *
 * Each receiving web/desktop client answers on a dedicated screen PC and renders
 * the track (see calls.js handleScreenOffer / group screen tile).
 */
class ScreenSharePeer(
    private val context: Context,
    private val cfg: ScreenShareConfig,
    private val mediaProjectionPermissionResult: Intent,
    private val callback: Callback,
) : ScreenShareSignaling.Listener {

    interface Callback {
        /** First successful offer sent (we're live). */
        fun onSharingStarted()
        /** Permanent failure or full teardown. */
        fun onSharingStopped(reason: String)
    }

    private class PerPeer(val recipient: Recipient) {
        var pc: PeerConnection? = null
        @Volatile var remoteDescApplied = false
        val pendingIce = ArrayList<IceCandidate>()
    }

    private val eglBase: EglBase = EglBase.create()
    private var factory: PeerConnectionFactory? = null
    private var capturer: VideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var signaling: ScreenShareSignaling? = null
    private val peers = LinkedHashMap<String, PerPeer>()   // recipient key -> PerPeer
    @Volatile private var stopped = false
    @Volatile private var startedNotified = false
    // Surface a silent failure: if no viewer's PC connects within the window, stop
    // with a reason that toasts the sharer instead of a green button sharing to no one.
    @Volatile private var anyConnected = false
    private val watchdog = Handler(Looper.getMainLooper())
    private val watchdogTask = Runnable {
        if (!stopped && !anyConnected) {
            Log.w(TAG, "no viewer connected within timeout — stopping share")
            stop("no_viewer_connection")
        }
    }

    fun start() {
        try {
            initFactory()
            signaling = ScreenShareSignaling(cfg, this).also { it.connect() }
        } catch (e: Throwable) {
            Log.e(TAG, "start failed", e)
            stop("init_failed")
        }
    }

    private fun initFactory() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions()
        )
        val encoder = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        val decoder = DefaultVideoDecoderFactory(eglBase.eglBaseContext)
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoder)
            .setVideoDecoderFactory(decoder)
            .createPeerConnectionFactory()
    }

    // ── Signaling callbacks ────────────────────────────────────────────────
    override fun onOpen() {
        try {
            ensureCapture()
            for (r in cfg.recipients) {
                if (stopped) break
                try { createPeerAndOffer(r) } catch (e: Throwable) { Log.w(TAG, "offer to ${r.key()} failed", e) }
            }
            if (!stopped) watchdog.postDelayed(watchdogTask, WATCHDOG_MS)
        } catch (e: Throwable) {
            Log.e(TAG, "onOpen capture/offer failed", e)
            stop("peer_failed")
        }
    }

    override fun onScreenAnswer(fromKey: String, sdp: String) {
        if (sdp.isBlank()) return
        val pp = resolvePeer(fromKey) ?: return
        val p = pp.pc ?: return
        p.setRemoteDescription(object : SdpObserverAdapter() {
            override fun onSetSuccess() {
                pp.remoteDescApplied = true
                drainPendingIce(pp)
            }
            override fun onSetFailure(error: String?) {
                Log.w(TAG, "setRemoteDescription(answer) failed: $error")
            }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    override fun onScreenIce(fromKey: String, candidate: String) {
        if (candidate.isBlank()) return
        val pp = resolvePeer(fromKey) ?: return
        val ice = parseIce(candidate) ?: return
        val p = pp.pc
        if (p == null || !pp.remoteDescApplied) {
            pp.pendingIce.add(ice)
        } else {
            try { p.addIceCandidate(ice) } catch (_: Throwable) {}
        }
    }

    override fun onScreenEnd(fromKey: String) {
        // One receiver ended. Drop just that peer; stop entirely once none remain.
        dropPeer(fromKey, "peer_ended")
    }

    override fun onClosed(reason: String) {
        stop("signaling_$reason")
    }

    // ── Capture + per-peer offer ───────────────────────────────────────────
    private fun ensureCapture() {
        if (videoTrack != null) return
        val f = factory ?: return
        val capturer = ScreenCapturerAndroid(
            mediaProjectionPermissionResult,
            object : MediaProjection.Callback() {
                override fun onStop() { stop("projection_revoked") }
            }
        )
        this.capturer = capturer
        val helper = SurfaceTextureHelper.create("FTScreenCapture", eglBase.eglBaseContext)
        this.surfaceHelper = helper
        val source = f.createVideoSource(capturer.isScreencast)
        this.videoSource = source
        capturer.initialize(helper, context, source.capturerObserver)
        capturer.startCapture(CAPTURE_WIDTH, CAPTURE_HEIGHT, CAPTURE_FPS)
        this.videoTrack = f.createVideoTrack("ft_screen", source)
    }

    private fun createPeerAndOffer(recipient: Recipient) {
        val f = factory ?: return
        val track = videoTrack ?: return
        val key = recipient.key()
        if (key.isBlank()) return
        val pp = PerPeer(recipient)
        synchronized(peers) { peers[key] = pp }
        val iceServers = parseIceServers(cfg.iceServers)
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val pc = f.createPeerConnection(rtcConfig, object : PcObserverAdapter() {
            override fun onIceCandidate(c: IceCandidate?) {
                c ?: return
                val obj = JSONObject().apply {
                    put("candidate", c.sdp)
                    put("sdpMid", c.sdpMid)
                    put("sdpMLineIndex", c.sdpMLineIndex)
                }
                signaling?.sendIce(recipient, obj.toString())
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                if (newState == PeerConnection.PeerConnectionState.CONNECTED) {
                    anyConnected = true
                    watchdog.removeCallbacks(watchdogTask)
                } else if (newState == PeerConnection.PeerConnectionState.FAILED ||
                    newState == PeerConnection.PeerConnectionState.CLOSED
                ) {
                    dropPeer(key, "ice_${newState.name.lowercase()}")
                }
            }
        }) ?: run { synchronized(peers) { peers.remove(key) }; return }
        pp.pc = pc

        val transceiver = pc.addTransceiver(
            track,
            RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY)
        )
        if (transceiver == null) {
            pc.addTrack(track, listOf("ft_screen_stream"))
        }

        val constraints = MediaConstraints()
        pc.createOffer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(desc: SessionDescription?) {
                desc ?: return
                pc.setLocalDescription(object : SdpObserverAdapter() {
                    override fun onSetSuccess() {
                        signaling?.sendOffer(recipient, desc.description, /*forceRelay=*/false)
                        if (!startedNotified) { startedNotified = true; callback.onSharingStarted() }
                    }
                    override fun onSetFailure(error: String?) {
                        Log.w(TAG, "setLocalDescription failed: $error")
                        dropPeer(key, "sld_failed")
                    }
                }, desc)
            }
            override fun onCreateFailure(error: String?) {
                Log.w(TAG, "createOffer failed: $error")
                dropPeer(key, "offer_failed")
            }
        }, constraints)
    }

    /** Match an inbound sender key to a peer; for a single recipient fall back to
     *  the sole peer so a missing/garbled from-id still resolves (1-on-1 parity). */
    private fun resolvePeer(fromKey: String): PerPeer? {
        synchronized(peers) {
            peers[fromKey]?.let { return it }
            if (peers.size == 1) return peers.values.firstOrNull()
        }
        return null
    }

    private fun drainPendingIce(pp: PerPeer) {
        val p = pp.pc ?: return
        val q = ArrayList(pp.pendingIce)
        pp.pendingIce.clear()
        for (ice in q) { try { p.addIceCandidate(ice) } catch (_: Throwable) {} }
    }

    private fun dropPeer(key: String, reason: String) {
        val pp = synchronized(peers) { peers.remove(key) } ?: return
        try { signaling?.sendEnd(pp.recipient) } catch (_: Throwable) {}
        try { pp.pc?.close(); pp.pc?.dispose() } catch (_: Throwable) {}
        val remaining = synchronized(peers) { peers.size }
        if (remaining == 0) stop("all_peers_gone:$reason")
    }

    fun stop(reason: String) {
        if (stopped) return
        stopped = true
        try { watchdog.removeCallbacks(watchdogTask) } catch (_: Throwable) {}
        val snapshot = synchronized(peers) { ArrayList(peers.values).also { peers.clear() } }
        for (pp in snapshot) {
            try { signaling?.sendEnd(pp.recipient) } catch (_: Throwable) {}
            try { pp.pc?.close(); pp.pc?.dispose() } catch (_: Throwable) {}
        }
        try { capturer?.stopCapture() } catch (_: Throwable) {}
        try { capturer?.dispose() } catch (_: Throwable) {}
        try { videoTrack?.dispose() } catch (_: Throwable) {}
        try { videoSource?.dispose() } catch (_: Throwable) {}
        try { surfaceHelper?.dispose() } catch (_: Throwable) {}
        try { factory?.dispose() } catch (_: Throwable) {}
        try { signaling?.close() } catch (_: Throwable) {}
        try { eglBase.release() } catch (_: Throwable) {}
        capturer = null; videoTrack = null; videoSource = null
        surfaceHelper = null; factory = null; signaling = null
        callback.onSharingStopped(reason)
    }

    companion object {
        private const val TAG = "FTScreenPeer"
        // If no viewer PeerConnection reaches CONNECTED in this window, treat the
        // share as failed and tell the sharer (covers a dead media path / TURN gap).
        private const val WATCHDOG_MS = 18000L
        // 720p-ish @ 15fps: a sane ceiling for screen content on mobile uplink.
        private const val CAPTURE_WIDTH = 1280
        private const val CAPTURE_HEIGHT = 720
        private const val CAPTURE_FPS = 15

        private fun parseIce(candidate: String): IceCandidate? {
            return try {
                val o = JSONObject(candidate)
                IceCandidate(
                    o.optString("sdpMid"),
                    o.optInt("sdpMLineIndex"),
                    o.optString("candidate")
                )
            } catch (_: Throwable) { null }
        }

        private fun parseIceServers(arr: org.json.JSONArray): List<PeerConnection.IceServer> {
            val out = ArrayList<PeerConnection.IceServer>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val urls = ArrayList<String>()
                when (val u = o.opt("urls")) {
                    is String -> urls.add(u)
                    is org.json.JSONArray -> for (j in 0 until u.length()) urls.add(u.optString(j))
                }
                if (urls.isEmpty()) continue
                val builder = PeerConnection.IceServer.builder(urls)
                o.optString("username").takeIf { it.isNotBlank() }?.let { builder.setUsername(it) }
                o.optString("credential").takeIf { it.isNotBlank() }?.let { builder.setPassword(it) }
                out.add(builder.createIceServer())
            }
            if (out.isEmpty()) {
                out.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
            }
            return out
        }
    }
}

/** No-op base so subclasses only override what they need. */
open class SdpObserverAdapter : SdpObserver {
    override fun onCreateSuccess(p0: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(p0: String?) {}
    override fun onSetFailure(p0: String?) {}
}

open class PcObserverAdapter : PeerConnection.Observer {
    override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
    override fun onIceConnectionReceivingChange(p0: Boolean) {}
    override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
    override fun onIceCandidate(p0: IceCandidate?) {}
    override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
    override fun onAddStream(p0: org.webrtc.MediaStream?) {}
    override fun onRemoveStream(p0: org.webrtc.MediaStream?) {}
    override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(p0: org.webrtc.RtpReceiver?, p1: Array<out org.webrtc.MediaStream>?) {}
    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {}
}
