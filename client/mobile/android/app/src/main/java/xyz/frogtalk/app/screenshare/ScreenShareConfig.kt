package xyz.frogtalk.app.screenshare

import org.json.JSONArray
import org.json.JSONObject

/**
 * Everything the native screen-share peer needs to join an in-progress call,
 * parsed from the JSON the web client passes via
 * `window.Android.startScreenShare(argsJson)` (see calls.js _nativeScreenArgs).
 */
data class ScreenShareConfig(
    val callId: Long,
    val toId: Long,
    val toGlobalUserId: String,
    val toNickname: String,
    val peerHomeServerId: String,
    val globalCallId: String,
    val iceServers: JSONArray,
    val token: String,
    val room: String,
    /** Origin to build the WS URL, e.g. https://frogtalk.xyz */
    val serverBaseUrl: String,
) {
    /** wss://host/ws/{room}?token=… — matches ws.js connect(). */
    fun webSocketUrl(): String {
        val base = serverBaseUrl.trimEnd('/')
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> "wss://$base"
        }
        val r = if (room.isNotBlank()) room else "lobby"
        val enc = android.net.Uri.encode(r)
        val tok = android.net.Uri.encode(token)
        return "$wsBase/ws/$enc?token=$tok"
    }

    companion object {
        fun fromJson(json: String, serverBaseUrl: String): ScreenShareConfig {
            val o = JSONObject(json)
            return ScreenShareConfig(
                callId = o.optLong("call_id", 0L),
                toId = o.optLong("to_id", 0L),
                toGlobalUserId = o.optString("to_global_user_id", ""),
                toNickname = o.optString("to_nickname", ""),
                peerHomeServerId = o.optString("peer_home_server_id", ""),
                globalCallId = o.optString("global_call_id", ""),
                iceServers = o.optJSONArray("ice_servers") ?: JSONArray(),
                token = o.optString("token", ""),
                room = o.optString("room", ""),
                serverBaseUrl = serverBaseUrl,
            )
        }
    }
}
