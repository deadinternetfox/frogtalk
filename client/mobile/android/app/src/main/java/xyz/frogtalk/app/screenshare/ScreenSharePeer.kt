package xyz.frogtalk.app.screenshare

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
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
 * One-way (sendonly) screen-share WebRTC peer. Captures the device screen via
 * MediaProjection, encodes it as a single video track, and offers it to the
 * call peer over [ScreenShareSignaling]. The call's own audio/video stay in the
 * WebView's RTCPeerConnection — this peer carries ONLY the screen.
 *
 * The receiving web/desktop client answers on a dedicated `_screenPc` and
 * renders the track in the screen tile (see calls.js handleScreenOffer).
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
        /** Permanent failure or remote/local teardown. */
        fun onSharingStopped(reason: String)
    }

    private val eglBase: EglBase = EglBase.create()
    private var factory: PeerConnectionFactory? = null
    private var pc: PeerConnection? = null
    private var capturer: VideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var signaling: ScreenShareSignaling? = null
    @Volatile private var remoteDescApplied = false
    @Volatile private var stopped = false
    private val pendingRemoteIce = ArrayList<IceCandidate>()

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
        // WS is up — build the PC and send the offer.
        try {
            createPeerAndOffer()
        } catch (e: Throwable) {
            Log.e(TAG, "createPeerAndOffer failed", e)
            stop("peer_failed")
        }
    }

    override fun onScreenAnswer(sdp: String) {
        val p = pc ?: return
        if (sdp.isBlank()) return
        p.setRemoteDescription(object : SdpObserverAdapter() {
            override fun onSetSuccess() {
                remoteDescApplied = true
                drainPendingIce()
            }
            override fun onSetFailure(error: String?) {
                Log.w(TAG, "setRemoteDescription(answer) failed: $error")
            }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    override fun onScreenIce(candidate: String) {
        if (candidate.isBlank()) return
        val ice = parseIce(candidate) ?: return
        val p = pc
        if (p == null || !remoteDescApplied) {
            pendingRemoteIce.add(ice)
        } else {
            try { p.addIceCandidate(ice) } catch (_: Throwable) {}
        }
    }

    override fun onScreenEnd() {
        stop("peer_ended")
    }

    override fun onClosed(reason: String) {
        stop("signaling_$reason")
    }

    // ── PeerConnection + screen capture ────────────────────────────────────
    private fun createPeerAndOffer() {
        val f = factory ?: return
        val iceServers = parseIceServers(cfg.iceServers)
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // The call may have forced relay; for a fresh screen offer we let
            // ICE try direct first — the receiver mirrors force_relay if set.
        }
        pc = f.createPeerConnection(rtcConfig, object : PcObserverAdapter() {
            override fun onIceCandidate(c: IceCandidate?) {
                c ?: return
                val obj = JSONObject().apply {
                    put("candidate", c.sdp)
                    put("sdpMid", c.sdpMid)
                    put("sdpMLineIndex", c.sdpMLineIndex)
                }
                signaling?.sendIce(obj.toString())
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                if (newState == PeerConnection.PeerConnectionState.FAILED ||
                    newState == PeerConnection.PeerConnectionState.CLOSED
                ) {
                    stop("ice_${newState.name.lowercase()}")
                }
            }
        }) ?: run { stop("pc_null"); return }

        // Build the screen capturer and a sendonly video track.
        val capturer = ScreenCapturerAndroid(
            mediaProjectionPermissionResult,
            object : MediaProjection.Callback() {
                override fun onStop() {
                    // User revoked the projection from the system UI.
                    stop("projection_revoked")
                }
            }
        )
        this.capturer = capturer
        val helper = SurfaceTextureHelper.create("FTScreenCapture", eglBase.eglBaseContext)
        this.surfaceHelper = helper
        val source = f.createVideoSource(capturer.isScreencast)
        this.videoSource = source
        capturer.initialize(helper, context, source.capturerObserver)
        // Cap resolution/fps to keep bitrate + battery sane (plan §2).
        capturer.startCapture(CAPTURE_WIDTH, CAPTURE_HEIGHT, CAPTURE_FPS)
        val track = f.createVideoTrack("ft_screen", source)
        this.videoTrack = track

        val transceiver = pc?.addTransceiver(
            track,
            RtpTransceiver.RtpTransceiverInit(
                RtpTransceiver.RtpTransceiverDirection.SEND_ONLY
            )
        )
        if (transceiver == null) {
            // Fallback for builds where addTransceiver(track,…) isn't available.
            pc?.addTrack(track, listOf("ft_screen_stream"))
        }

        val constraints = MediaConstraints()
        pc?.createOffer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(desc: SessionDescription?) {
                desc ?: return
                pc?.setLocalDescription(object : SdpObserverAdapter() {
                    override fun onSetSuccess() {
                        signaling?.sendOffer(desc.description, /*forceRelay=*/false)
                        callback.onSharingStarted()
                    }
                    override fun onSetFailure(error: String?) {
                        Log.w(TAG, "setLocalDescription failed: $error")
                        stop("sld_failed")
                    }
                }, desc)
            }
            override fun onCreateFailure(error: String?) {
                Log.w(TAG, "createOffer failed: $error")
                stop("offer_failed")
            }
        }, constraints)
    }

    private fun drainPendingIce() {
        val p = pc ?: return
        val q = ArrayList(pendingRemoteIce)
        pendingRemoteIce.clear()
        for (ice in q) { try { p.addIceCandidate(ice) } catch (_: Throwable) {} }
    }

    fun stop(reason: String) {
        if (stopped) return
        stopped = true
        try { signaling?.sendEnd() } catch (_: Throwable) {}
        try { capturer?.stopCapture() } catch (_: Throwable) {}
        try { capturer?.dispose() } catch (_: Throwable) {}
        try { videoTrack?.dispose() } catch (_: Throwable) {}
        try { videoSource?.dispose() } catch (_: Throwable) {}
        try { surfaceHelper?.dispose() } catch (_: Throwable) {}
        try { pc?.close(); pc?.dispose() } catch (_: Throwable) {}
        try { factory?.dispose() } catch (_: Throwable) {}
        try { signaling?.close() } catch (_: Throwable) {}
        try { eglBase.release() } catch (_: Throwable) {}
        capturer = null; videoTrack = null; videoSource = null
        surfaceHelper = null; pc = null; factory = null; signaling = null
        callback.onSharingStopped(reason)
    }

    companion object {
        private const val TAG = "FTScreenPeer"
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
