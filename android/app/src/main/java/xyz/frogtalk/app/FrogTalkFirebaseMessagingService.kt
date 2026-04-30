package xyz.frogtalk.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
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
            val peer = data["from_nickname"].orEmpty()
            val callId = data["call_id"].orEmpty()
            // Single source of truth for the incoming-call UI: the CallStyle
            // heads-up below. We deliberately do NOT also fire CallService's
            // ACTION_RING here — that posts another notification on the same
            // id/channel and the system retriggers the ringtone, producing the
            // "ringtone + notification ding looping" effect users reported.
            try {
                showIncomingCallNotification(peer, callId)
            } catch (e: Throwable) {
                Log.w(TAG, "Incoming-call notification failed", e)
            }
            return
        }

        val title = data["title"] ?: message.notification?.title ?: "FrogTalk"
        val body = data["body"] ?: message.notification?.body ?: "New activity"
        val convId = data["conversation_id"].orEmpty()
        val convName = data["conversation_name"].orEmpty()
        val senderName = data["sender_name"] ?: data["from_nickname"] ?: title
        showMessageNotification(title, body, senderName, convId, convName)
    }

    private fun ensureGeneralChannel(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (nm.getNotificationChannel(CHANNEL_GENERAL) != null) return
        val channel = NotificationChannel(
            CHANNEL_GENERAL,
            "Messages",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "FrogTalk message notifications"
            enableVibration(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
        nm.createNotificationChannel(channel)
    }

    private fun ensureCallChannel(nm: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (nm.getNotificationChannel(CHANNEL_CALL) != null) return
        val ringUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val ring = NotificationChannel(
            CHANNEL_CALL,
            "Incoming Calls",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Full-screen incoming call alerts"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 600, 800)
            setBypassDnd(true)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            setSound(ringUri, attrs)
        }
        nm.createNotificationChannel(ring)
    }

    private fun showMessageNotification(
        title: String,
        body: String,
        senderName: String,
        conversationId: String,
        conversationName: String,
    ) {
        // The server now sends FCM for every DM (it used to short-circuit
        // when the user was online via WS). When the activity is currently
        // visible to the user, suppress the duplicate tray entry — the
        // in-app toast in dms.js handles that case. When the app is
        // backgrounded or the screen is off, MainActivity.isAppVisible is
        // false and we post the heads-up + tray notification as usual.
        if (MainActivity.isAppVisible) {
            return
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureGeneralChannel(nm)

        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (conversationId.isNotBlank()) putExtra("conversation_id", conversationId)
            // Tapping a message heads-up should jump straight to the DM thread
            // with the sender. The web app consumes ?dm=<nick> on launch.
            if (senderName.isNotBlank()) putExtra("dm_nick", senderName)
        }
        val requestCode = if (conversationId.isNotBlank()) {
            conversationId.hashCode() and 0x7fffffff
        } else {
            (System.currentTimeMillis() % 100000).toInt()
        }
        val pending = PendingIntent.getActivity(
            this,
            requestCode,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val person = Person.Builder().setName(senderName).setKey(senderName).build()
        val style = NotificationCompat.MessagingStyle(person)
            .addMessage(body, System.currentTimeMillis(), person)
        if (conversationName.isNotBlank() && conversationName != senderName) {
            style.conversationTitle = conversationName
            style.isGroupConversation = true
        }

        val tag = if (conversationId.isNotBlank()) "ft-conv-$conversationId" else "ft-msg"

        val largeIcon = try {
            BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher)
        } catch (_: Throwable) { null }
        val accent = try { ContextCompat.getColor(this, R.color.frog_green) } catch (_: Throwable) { 0x4CAF50.or(0xFF000000.toInt()) }

        val n = NotificationCompat.Builder(this, CHANNEL_GENERAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(accent)
            .setLargeIcon(largeIcon)
            .setSubText("FrogTalk")
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(style)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pending)
            // No setDefaults(DEFAULT_ALL): the channel (CHANNEL_GENERAL) is
            // already IMPORTANCE_HIGH with vibration and the system default
            // ringtone. On several OEM ROMs (Xiaomi MIUI, Samsung One UI when
            // app is backgrounded), pairing channel-driven sound with
            // setDefaults caused the alert tone to play while the heads-up /
            // tray entry was silently suppressed — the foreground
            // "beep but no notification" symptom.
            .setOnlyAlertOnce(false)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .build()

        // Stable per-conversation id so successive messages from the same chat
        // update one heads-up instead of stacking.
        val notifId = if (conversationId.isNotBlank()) {
            (conversationId.hashCode() and 0x7fffffff).coerceAtLeast(2000)
        } else {
            (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
        }
        nm.notify(tag, notifId, n)
    }

    private fun showIncomingCallNotification(peerNick: String, callId: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureCallChannel(nm)

        val displayName = if (peerNick.isBlank()) "Someone" else peerNick

        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("incoming_call", true)
            putExtra(CallService.EXTRA_PEER_NICK, peerNick)
            putExtra(CallService.EXTRA_CALL_ID, callId)
            // After the call overlay resolves, land in the DM with this peer
            // so the user can keep typing without an extra tap.
            if (peerNick.isNotBlank()) putExtra("dm_nick", peerNick)
        }
        val baseRequest = (callId.hashCode() and 0x7fffffff)
        val openPending = PendingIntent.getActivity(
            this,
            baseRequest,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // We deliberately do NOT expose an "Answer" action that auto-accepts
        // from the notification. Cold-start auto-accept races the WebSocket
        // and RTCPeerConnection bring-up and wedges the call. The body tap
        // and "Open" action just bring the app to the in-app ringing UI,
        // where acceptCall() runs against fully-initialised JS state.

        val declineIntent = Intent(this, CallDeclineReceiver::class.java).apply {
            putExtra(CallService.EXTRA_CALL_ID, callId)
            putExtra(CallService.EXTRA_PEER_NICK, peerNick)
        }
        val declinePending = PendingIntent.getBroadcast(
            this,
            baseRequest xor 0x55,
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val person = Person.Builder()
            .setName(displayName)
            .setKey(displayName)
            .setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher))
            .setImportant(true)
            .build()

        val accent = try { ContextCompat.getColor(this, R.color.frog_green) } catch (_: Throwable) { 0x4CAF50.or(0xFF000000.toInt()) }

        val builder = NotificationCompat.Builder(this, CHANNEL_CALL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(accent)
            .setColorized(true)
            .setSubText("FrogTalk")
            .setContentTitle("Incoming FrogTalk call")
            .setContentText("$displayName is calling…")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(openPending, true)
            .setContentIntent(openPending)
            .setOngoing(true)
            .setAutoCancel(true)
            // Channel already supplies ringtone + vibration. setDefaults()
            // would stack the system notification ding on top of the ringtone
            // on some OEM ROMs (Samsung/Xiaomi/OnePlus). OnlyAlertOnce makes
            // any duplicate notify(1002,…) a silent update instead of
            // restarting the ringtone.
            .setOnlyAlertOnce(true)

        // Plain action buttons (no CallStyle): CallStyle's green button is
        // hard-labelled "Answer" by the system, but tapping it must NOT
        // auto-accept (see comment above). "Open" makes the behaviour
        // honest — the user accepts/declines from the in-app ringing UI.
        builder
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", declinePending)
            .addAction(android.R.drawable.ic_menu_view, "Open", openPending)

        nm.notify(RING_NOTIFICATION_ID, builder.build())
    }
}
