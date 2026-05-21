package xyz.frogtalk.app

import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object FcmBridge {
    private const val TAG = "FrogTalkFCM"
    private const val PREFS = "frogtalk_prefs"
    private const val PREF_SESSION_TOKEN = "session_token"
    private const val PREF_SERVER_BASE_URL = "server_base_url"
    private const val PREF_LAST_TOKEN_SYNC = "last_fcm_token_sync_at"
    private const val DEFAULT_API = "https://frogtalk.xyz"

    private fun apiBase(context: Context): String {
        val custom = try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_SERVER_BASE_URL, "")
                .orEmpty()
                .trim()
        } catch (_: Throwable) {
            ""
        }
        val raw = (custom.ifBlank { DEFAULT_API }).trimEnd('/')
        return try {
            val uri = java.net.URI(raw)
            when (uri.scheme?.lowercase()) {
                "https", "http" -> raw
                else -> DEFAULT_API
            }
        } catch (_: Throwable) {
            DEFAULT_API
        }
    }

    fun rememberSessionToken(context: Context, sessionToken: String?) {
        val token = (sessionToken ?: "").trim()
        if (token.isEmpty()) return
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(PREF_SESSION_TOKEN, token)
                .apply()
        } catch (e: Throwable) {
            Log.w(TAG, "rememberSessionToken failed", e)
        }
    }

    fun syncCurrentToken(context: Context, sessionToken: String? = null) {
        rememberSessionToken(context, sessionToken)
        try {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { fcmToken ->
                    if (!fcmToken.isNullOrBlank()) {
                        postToken(context, fcmToken)
                    }
                }
                .addOnFailureListener { e ->
                    Log.w(TAG, "Fetching FCM token failed", e)
                }
        } catch (e: Throwable) {
            Log.w(TAG, "syncCurrentToken failed", e)
        }
    }

    /**
     * Re-sync the FCM token only if [maxAgeMs] has elapsed since the last
     * successful sync. Cheap to call from onResume; avoids a network roundtrip
     * on every foreground transition.
     */
    fun syncCurrentTokenIfStale(
        context: Context,
        sessionToken: String? = null,
        maxAgeMs: Long = 6L * 60 * 60 * 1000, // 6 hours
    ) {
        if (!sessionToken.isNullOrBlank()) {
            rememberSessionToken(context, sessionToken)
        }
        val prefs = try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        } catch (_: Throwable) {
            return
        }
        val now = System.currentTimeMillis()
        val last = prefs.getLong(PREF_LAST_TOKEN_SYNC, 0L)
        if (last != 0L && now - last < maxAgeMs) return

        try {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { fcmToken ->
                    if (!fcmToken.isNullOrBlank()) {
                        postToken(context, fcmToken)
                        try {
                            prefs.edit().putLong(PREF_LAST_TOKEN_SYNC, System.currentTimeMillis()).apply()
                        } catch (_: Throwable) { /* ignore */ }
                    }
                }
                .addOnFailureListener { e ->
                    Log.w(TAG, "Stale-refresh FCM token fetch failed", e)
                }
        } catch (e: Throwable) {
            Log.w(TAG, "syncCurrentTokenIfStale failed", e)
        }
    }

    fun postToken(context: Context, fcmToken: String) {
        val sessionToken = try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_SESSION_TOKEN, "")
                .orEmpty()
                .trim()
        } catch (_: Throwable) {
            ""
        }
        if (sessionToken.isEmpty() || fcmToken.isBlank()) return

        Thread {
            try {
                val conn = (URL("${apiBase(context)}/api/push/fcm-subscribe").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 12000
                    readTimeout = 12000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("X-Session-Token", sessionToken)
                }
                val body = JSONObject().apply {
                    put("token", fcmToken)
                    put("platform", "android")
                }.toString()
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                if (code !in 200..299) {
                    Log.w(TAG, "FCM subscribe failed: HTTP $code")
                }
                conn.disconnect()
            } catch (e: Throwable) {
                Log.w(TAG, "postToken failed", e)
            }
        }.start()
    }

    fun declineCall(context: Context, callId: String?, peerNick: String?) {
        val cid = (callId ?: "").trim()
        val nick = (peerNick ?: "").trim()
        if (cid.isEmpty() && nick.isEmpty()) return

        val sessionToken = try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_SESSION_TOKEN, "")
                .orEmpty()
                .trim()
        } catch (_: Throwable) {
            ""
        }
        if (sessionToken.isEmpty()) return

        Thread {
            try {
                val conn = (URL("${apiBase(context)}/api/calls/decline").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 12000
                    readTimeout = 12000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("X-Session-Token", sessionToken)
                }
                val body = JSONObject().apply {
                    if (cid.isNotEmpty()) put("call_id", cid.toIntOrNull() ?: cid)
                    if (nick.isNotEmpty()) put("peer_nick", nick)
                }.toString()
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                if (code !in 200..299) {
                    Log.w(TAG, "Decline call failed: HTTP $code")
                }
                conn.disconnect()
            } catch (e: Throwable) {
                Log.w(TAG, "declineCall failed", e)
            }
        }.start()
    }
}
