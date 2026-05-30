package xyz.frogtalk.app.screenshare

import org.json.JSONArray
import org.json.JSONObject

/**
 * One screen-share recipient (a single call/voice peer to offer the screen to).
 * For a 1-on-1 call there is exactly one; for a group voice channel there is one
 * per participant. Inbound answer/ICE are matched back to a recipient by [key].
 */
data class Recipient(
    val toId: Long,
    val toGlobalUserId: String,
    val toNickname: String,
    val callId: Long,
    val globalCallId: String,
) {
    /** Stable key, aligned with the web client's voice peer keys (g:… / u:…). */
    fun key(): String = when {
        toGlobalUserId.isNotBlank() -> "g:$toGlobalUserId"
        toId > 0L -> "u:$toId"
        else -> "n:$toNickname"
    }
}

/**
 * Everything the native screen-share peer needs to join an in-progress call or
 * group voice channel, parsed from the JSON the web client passes via
 * `window.Android.startScreenShare(argsJson)` (see calls.js _nativeScreenArgs /
 * _nativeGroupScreenArgs).
 *
 * Backward compatible: a 1-on-1 payload with only the top-level to_* fields
 * yields a single-element [recipients] list, so the original behaviour is
 * unchanged. A group payload supplies a `recipients` array.
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
    /** One per peer to share to (>=1). */
    val recipients: List<Recipient>,
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
            val callId = o.optLong("call_id", 0L)
            val globalCallId = o.optString("global_call_id", "")
            val recipients = ArrayList<Recipient>()
            val arr = o.optJSONArray("recipients")
            if (arr != null && arr.length() > 0) {
                for (i in 0 until arr.length()) {
                    val r = arr.optJSONObject(i) ?: continue
                    val rec = Recipient(
                        toId = r.optLong("to_id", 0L),
                        toGlobalUserId = r.optString("to_global_user_id", ""),
                        toNickname = r.optString("to_nickname", ""),
                        callId = r.optLong("call_id", callId),
                        globalCallId = r.optString("global_call_id", globalCallId),
                    )
                    if (rec.toId > 0L || rec.toGlobalUserId.isNotBlank() || rec.toNickname.isNotBlank()) {
                        recipients.add(rec)
                    }
                }
            }
            if (recipients.isEmpty()) {
                // 1-on-1 fallback from the flat to_* fields.
                recipients.add(
                    Recipient(
                        toId = o.optLong("to_id", 0L),
                        toGlobalUserId = o.optString("to_global_user_id", ""),
                        toNickname = o.optString("to_nickname", ""),
                        callId = callId,
                        globalCallId = globalCallId,
                    )
                )
            }
            return ScreenShareConfig(
                callId = callId,
                toId = o.optLong("to_id", 0L),
                toGlobalUserId = o.optString("to_global_user_id", ""),
                toNickname = o.optString("to_nickname", ""),
                peerHomeServerId = o.optString("peer_home_server_id", ""),
                globalCallId = globalCallId,
                iceServers = o.optJSONArray("ice_servers") ?: JSONArray(),
                token = o.optString("token", ""),
                room = o.optString("room", ""),
                recipients = recipients,
                serverBaseUrl = serverBaseUrl,
            )
        }
    }
}
