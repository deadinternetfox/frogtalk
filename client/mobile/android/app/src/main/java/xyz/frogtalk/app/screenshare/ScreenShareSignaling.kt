package xyz.frogtalk.app.screenshare

import android.util.Base64
import android.util.Log
import org.json.JSONObject
import xyz.frogtalk.app.MainActivity

/**
 * Screen-share signaling that rides the SAME WebSocket the WebView app + call use,
 * via the JS bridge — NOT a separate native socket.
 *
 * Why: a standalone OkHttp WebSocket to the public domain proved unreliable through
 * the production Cloudflare front. The upgrade succeeded (so the share button went
 * green) but the screen_offer frame never reached the origin, while the call's own
 * audio/video — which ride the WebView's browser WebSocket — kept working. Routing
 * screen_* over the proven transport fixes "button green, nothing on the other end".
 *
 * Outbound: serialize the frame, base64 it (sidesteps JS string-escaping of SDP
 * newlines/quotes) and runJsOnWebView(window.ftScreenSignalOut('<b64>')) — calls.js
 * sends it over the live WS via _sendCallSignal. Inbound: calls.js forwards
 * screen_answer/screen_ice/screen_end to Android.ftScreenSignalIn(json) →
 * [deliver] → this listener. Routing/recipient handling is unchanged from the old
 * socket version (multiplexed across recipients for group voice screen-share).
 */
class ScreenShareSignaling(
    private val cfg: ScreenShareConfig,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onScreenAnswer(fromKey: String, sdp: String)
        fun onScreenIce(fromKey: String, candidate: String)
        fun onScreenEnd(fromKey: String)
        fun onClosed(reason: String)
    }

    @Volatile private var closed = false

    fun connect() {
        // The WebView WS is already connected (we're in an active call). Register
        // for inbound frames and signal "open" so the peer starts capture + offers.
        active = this
        if (closed) return
        Thread {
            try { if (!closed) listener.onOpen() }
            catch (e: Throwable) { Log.e(TAG, "onOpen failed", e) }
        }.start()
    }

    fun sendOffer(recipient: Recipient, sdp: String, forceRelay: Boolean) {
        val o = routing(recipient)
        o.put("type", "screen_offer")
        o.put("sdp", sdp)
        o.put("force_relay", forceRelay)
        emit(o)
    }

    fun sendIce(recipient: Recipient, candidateJson: String) {
        val o = routing(recipient)
        o.put("type", "screen_ice")
        o.put("candidate", candidateJson)
        emit(o)
    }

    fun sendEnd(recipient: Recipient) {
        val o = routing(recipient)
        o.put("type", "screen_end")
        emit(o)
    }

    /** Key matching the web client's voice peer keys (g:… / u:…). */
    private fun senderKey(o: JSONObject): String {
        val gid = o.optString("from_global_user_id", "")
        if (gid.isNotBlank()) return "g:$gid"
        val uid = o.optLong("from_id", 0L)
        if (uid > 0L) return "u:$uid"
        return o.optString("from_nickname", "").let { if (it.isNotBlank()) "n:$it" else "" }
    }

    /** Per-recipient routing template (to_* + call_id + global_call_id). */
    private fun routing(r: Recipient): JSONObject {
        val o = JSONObject()
        if (r.toId > 0L) o.put("to_id", r.toId)
        if (r.toGlobalUserId.isNotBlank()) o.put("to_global_user_id", r.toGlobalUserId)
        if (r.toNickname.isNotBlank()) o.put("to_nickname", r.toNickname)
        if (r.globalCallId.isNotBlank()) o.put("global_call_id", r.globalCallId)
        o.put("call_id", if (r.callId > 0L) r.callId else cfg.callId)
        return o
    }

    private fun emit(o: JSONObject) {
        if (closed) return
        try {
            val b64 = Base64.encodeToString(
                o.toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP
            )
            MainActivity.runJsOnWebView("if(window.ftScreenSignalOut)window.ftScreenSignalOut('$b64');")
        } catch (e: Throwable) {
            Log.w(TAG, "emit failed", e)
        }
    }

    /** An inbound screen_answer / screen_ice / screen_end frame from calls.js. */
    private fun handleInbound(text: String) {
        if (closed) return
        try {
            val o = JSONObject(text)
            val type = o.optString("type")
            if (type != "screen_answer" && type != "screen_ice" && type != "screen_end") return
            val fromKey = senderKey(o)
            when (type) {
                "screen_answer" -> listener.onScreenAnswer(fromKey, o.optString("sdp"))
                "screen_ice" -> listener.onScreenIce(fromKey, o.optString("candidate"))
                "screen_end" -> listener.onScreenEnd(fromKey)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "bad inbound frame", e)
        }
    }

    fun close() {
        closed = true
        if (active === this) active = null
    }

    companion object {
        private const val TAG = "FTScreenSignal"

        // The single in-flight signaling instance (one native share at a time).
        @Volatile private var active: ScreenShareSignaling? = null

        /** Called from MainActivity's JS bridge with an inbound screen_* frame. */
        @JvmStatic
        fun deliver(json: String) {
            try { active?.handleInbound(json) } catch (_: Throwable) {}
        }
    }
}
