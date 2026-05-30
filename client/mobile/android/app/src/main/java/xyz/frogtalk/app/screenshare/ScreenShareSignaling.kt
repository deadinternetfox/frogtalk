package xyz.frogtalk.app.screenshare

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * One WebSocket that speaks FrogTalk's screen-share signaling for the native
 * peer, MULTIPLEXED across every recipient. It connects as the same user as the
 * WebView and exchanges `screen_offer` / `screen_answer` / `screen_ice` /
 * `screen_end`, routing each outbound frame to a specific recipient and
 * dispatching each inbound frame back to the right peer by its sender id.
 *
 * For a 1-on-1 call there is a single recipient, so behaviour matches the
 * original single-peer signaling.
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

    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // keep the socket open
        .build()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var closed = false

    fun connect() {
        val req = Request.Builder().url(cfg.webSocketUrl()).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!closed) listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
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
                    Log.w(TAG, "bad WS frame", e)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!closed) listener.onClosed("closed:$code")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!closed) {
                    Log.w(TAG, "WS failure", t)
                    listener.onClosed("failure:${t.message ?: "io"}")
                }
            }
        })
    }

    fun sendOffer(recipient: Recipient, sdp: String, forceRelay: Boolean) {
        val o = routing(recipient)
        o.put("type", "screen_offer")
        o.put("sdp", sdp)
        o.put("force_relay", forceRelay)
        send(o)
    }

    fun sendIce(recipient: Recipient, candidateJson: String) {
        val o = routing(recipient)
        o.put("type", "screen_ice")
        o.put("candidate", candidateJson)
        send(o)
    }

    fun sendEnd(recipient: Recipient) {
        val o = routing(recipient)
        o.put("type", "screen_end")
        send(o)
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

    private fun send(o: JSONObject) {
        try { ws?.send(o.toString()) } catch (e: Throwable) { Log.w(TAG, "send failed", e) }
    }

    fun close() {
        closed = true
        try { ws?.close(1000, "done") } catch (_: Throwable) {}
        ws = null
        try { client.dispatcher.executorService.shutdown() } catch (_: Throwable) {}
    }

    companion object {
        private const val TAG = "FTScreenSignal"
    }
}
