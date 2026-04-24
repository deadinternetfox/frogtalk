package xyz.frogtalk.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FrogTalkFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "FrogTalkFCMService"
        private const val CHANNEL_GENERAL = "frogtalk_general"
        private const val CHANNEL_CALL = "frogtalk_call_ring"
        private const val RING_NOTIFICATION_ID = 1002
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        try {
            FcmBridge.postToken(this, token)
        } catch (e: Throwable) {
            Log.w(TAG, "onNewToken post failed", e)
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        try { FcmBridge.syncCurrentToken(this) } catch (_: Throwable) {}
        val data = message.data ?: emptyMap()
        val kind = (data["kind"] ?: "message").lowercase()

        if (kind == "call") {
            try {
                val peer = data["from_nickname"].orEmpty()
                val callId = data["call_id"].orEmpty()
                val intent = Intent(this, CallService::class.java).apply {
                    action = CallService.ACTION_RING
                    putExtra(CallService.EXTRA_PEER_NICK, peer)
                    putExtra(CallService.EXTRA_CALL_ID, callId)
                }
                startService(intent)
                return
            } catch (e: Throwable) {
                Log.w(TAG, "Failed to trigger CallService ring", e)
                try {
                    val peer = data["from_nickname"].orEmpty()
                    val callId = data["call_id"].orEmpty()
                    showIncomingCallFallback(peer, callId)
                    return
                } catch (inner: Throwable) {
                    Log.w(TAG, "Fallback incoming-call notification failed", inner)
                }
            }
        }

        val title = data["title"] ?: message.notification?.title ?: "FrogTalk"
        val body = data["body"] ?: message.notification?.body ?: "New activity"
        showGeneralNotification(title, body)
    }

    private fun showGeneralNotification(title: String, body: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (nm.getNotificationChannel(CHANNEL_GENERAL) == null) {
                val channel = NotificationChannel(
                    CHANNEL_GENERAL,
                    "FrogTalk",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "FrogTalk message and call notifications"
                    enableVibration(true)
                }
                nm.createNotificationChannel(channel)
            }
        }

        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(
            this,
            (System.currentTimeMillis() % 100000).toInt(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val n = NotificationCompat.Builder(this, CHANNEL_GENERAL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(pending)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()

        nm.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), n)
    }

    private fun showIncomingCallFallback(peerNick: String, callId: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (nm.getNotificationChannel(CHANNEL_CALL) == null) {
                val ring = NotificationChannel(
                    CHANNEL_CALL,
                    "Incoming Calls",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Full-screen incoming call alerts"
                    enableVibration(true)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
                nm.createNotificationChannel(ring)
            }
        }

        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("incoming_call", true)
            putExtra(CallService.EXTRA_PEER_NICK, peerNick)
            putExtra(CallService.EXTRA_CALL_ID, callId)
        }
        val openPending = PendingIntent.getActivity(
            this,
            (callId.hashCode() and 0x7fffffff),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val n = NotificationCompat.Builder(this, CHANNEL_CALL)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle("Incoming FrogTalk call")
            .setContentText("${if (peerNick.isBlank()) "Someone" else peerNick} is calling…")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(openPending, true)
            .setContentIntent(openPending)
            .setOngoing(true)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()

        nm.notify(RING_NOTIFICATION_ID, n)
    }
}
