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
 * Minimal WebSocket client that speaks FrogTalk's call-signaling protocol for
 * the native screen-share peer. It connects as the SAME user as the WebView
 * (same session token) to `wss://{host}/ws/{room}?token=…`, then exchanges the
 * dedicated `screen_offer` / `screen_answer` / `screen_ice` / `screen_end`
 * frames. The server relays them to the call peer exactly like the call_*
 * signals (see node/routers/ws.py).
 *
 * Independent of the WebView's socket: `manager.send_to_user` fans a peer's
 * reply out to all of that user's connections, and the WebView drops screen
 * frames whose `from_id` is itself, so the two coexist cleanly.
 */
class ScreenShareSignaling(
    private val cfg: ScreenShareConfig,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onScreenAnswer(sdp: String)
        fun onScreenIce(candidate: String)
        fun onScreenEnd()
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
                    when (o.optString("type")) {
                        "screen_answer" -> listener.onScreenAnswer(o.optString("sdp"))
                        "screen_ice" -> listener.onScreenIce(o.optString("candidate"))
                        "screen_end" -> listener.onScreenEnd()
                        // Other frames (presence, etc.) on this socket are ignored.
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

    fun sendOffer(sdp: String, forceRelay: Boolean) {
        val o = routing()
        o.put("type", "screen_offer")
        o.put("sdp", sdp)
        o.put("force_relay", forceRelay)
        send(o)
    }

    fun sendIce(candidateJson: String) {
        val o = routing()
        o.put("type", "screen_ice")
        o.put("candidate", candidateJson)
        send(o)
    }

    fun sendEnd() {
        val o = routing()
        o.put("type", "screen_end")
        send(o)
    }

    /** Fresh routing template (to_* + call_id + global_call_id) per frame so
     *  every outbound message reaches the call peer. */
    private fun routing(): JSONObject {
        val o = JSONObject()
        if (cfg.toId > 0) o.put("to_id", cfg.toId)
        if (cfg.toGlobalUserId.isNotBlank()) o.put("to_global_user_id", cfg.toGlobalUserId)
        if (cfg.toNickname.isNotBlank()) o.put("to_nickname", cfg.toNickname)
        if (cfg.globalCallId.isNotBlank()) o.put("global_call_id", cfg.globalCallId)
        o.put("call_id", cfg.callId)
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
