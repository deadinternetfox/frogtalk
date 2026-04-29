package xyz.frogtalk.app

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat

class CallService : Service() {

    companion object {
        const val TAG = "FrogTalkCall"
        const val CHANNEL_ID = "frogtalk_call"
        const val CHANNEL_RING_ID = "frogtalk_call_ring"
        const val NOTIFICATION_ID = 1001
        const val RING_NOTIFICATION_ID = 1002
        const val ACTION_END_CALL = "xyz.frogtalk.app.ACTION_END_CALL"
        const val ACTION_MUTE = "xyz.frogtalk.app.ACTION_MUTE"
        const val ACTION_RING = "xyz.frogtalk.app.ACTION_RING"
        const val ACTION_DISMISS_RING = "xyz.frogtalk.app.ACTION_DISMISS_RING"
        const val ACTION_STOP_ALL = "xyz.frogtalk.app.ACTION_STOP_ALL"
        const val EXTRA_PEER_NICK = "peer_nick"
        const val EXTRA_CALL_ID = "call_id"
    }

    override fun onCreate() {
        super.onCreate()
        try { createNotificationChannel() } catch (e: Throwable) {
            Log.w(TAG, "createNotificationChannel failed", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            when (intent?.action) {
                ACTION_END_CALL -> {
                    sendBroadcast(Intent("xyz.frogtalk.app.CALL_ACTION").putExtra("action", "end"))
                    stopSelf()
                    return START_NOT_STICKY
                }
                ACTION_MUTE -> {
                    sendBroadcast(Intent("xyz.frogtalk.app.CALL_ACTION").putExtra("action", "mute"))
                    return START_STICKY
                }
                ACTION_DISMISS_RING -> {
                    try {
                        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                        nm.cancel(RING_NOTIFICATION_ID)
                    } catch (_: Throwable) {}
                    return START_NOT_STICKY
                }
                ACTION_STOP_ALL -> {
                    try {
                        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                        nm.cancel(NOTIFICATION_ID)
                        nm.cancel(RING_NOTIFICATION_ID)
                    } catch (_: Throwable) {}
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                            stopForeground(STOP_FOREGROUND_REMOVE)
                        } else {
                            @Suppress("DEPRECATION")
                            stopForeground(true)
                        }
                    } catch (_: Throwable) {}
                    stopSelf()
                    return START_NOT_STICKY
                }
                ACTION_RING -> {
                    // Best-effort incoming-call ring while app process is alive.
                    // NOTE: this only wakes if the process exists; full force-closed
                    // ringing requires FCM with a google-services.json.
                    try { createRingChannel() } catch (_: Throwable) {}
                    val peer = intent?.getStringExtra(EXTRA_PEER_NICK) ?: "Someone"
                    val callId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""

                    val fullScreen = Intent(this, MainActivity::class.java).apply {
                        this.flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP
                        putExtra("incoming_call", true)
                        putExtra(EXTRA_PEER_NICK, peer)
                        putExtra(EXTRA_CALL_ID, callId)
                        if (peer.isNotBlank() && peer != "Someone") putExtra("dm_nick", peer)
                    }
                    val fullScreenPending = PendingIntent.getActivity(
                        this, 10, fullScreen,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )

                    val declineIntent = Intent(this, CallDeclineReceiver::class.java).apply {
                        putExtra(EXTRA_CALL_ID, callId)
                        putExtra(EXTRA_PEER_NICK, peer)
                    }
                    val declinePending = PendingIntent.getBroadcast(
                        this, 11, declineIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )

                    val ringBuilder = NotificationCompat.Builder(this, CHANNEL_RING_ID)
                        .setSmallIcon(R.drawable.ic_notification)
                        .setContentTitle("Incoming FrogTalk call")
                        .setContentText("$peer is calling\u2026")
                        .setPriority(NotificationCompat.PRIORITY_MAX)
                        .setCategory(NotificationCompat.CATEGORY_CALL)
                        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                        // Channel supplies sound + vibration. Adding setDefaults
                        // here causes some OEMs to play the default notification
                        // ding alongside the ringtone. OnlyAlertOnce suppresses
                        // re-alert when the same id 1002 is updated.
                        .setOnlyAlertOnce(true)
                        .setOngoing(true)
                        .setAutoCancel(true)
                        .setFullScreenIntent(fullScreenPending, true)
                        .setContentIntent(fullScreenPending)
                        .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", declinePending)
                        .addAction(android.R.drawable.ic_menu_call, "Answer", fullScreenPending)
                    val ringNotif = ringBuilder.build()

                    try {
                        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                        nm.notify(RING_NOTIFICATION_ID, ringNotif)
                    } catch (e: Throwable) {
                        Log.e(TAG, "ring notify failed", e)
                    }
                    return START_NOT_STICKY
                }
            }

            val peerNick = intent?.getStringExtra(EXTRA_PEER_NICK) ?: "Someone"

            val openIntent = Intent(this, MainActivity::class.java).apply {
                this.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val openPending = PendingIntent.getActivity(
                this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val endIntent = Intent(this, CallService::class.java).apply { action = ACTION_END_CALL }
            val endPending = PendingIntent.getService(
                this, 1, endIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val muteIntent = Intent(this, CallService::class.java).apply { action = ACTION_MUTE }
            val mutePending = PendingIntent.getService(
                this, 2, muteIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val accentOngoing = try { ContextCompat.getColor(this, R.color.frog_green) } catch (_: Throwable) { 0xFF4CAF50.toInt() }
            val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(accentOngoing)
                .setColorized(true)
                .setSubText("FrogTalk")
                .setContentTitle("In call with $peerNick")
                .setContentText("FrogTalk call in progress")
                .setContentIntent(openPending)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .addAction(android.R.drawable.ic_media_pause, "Mute", mutePending)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "End Call", endPending)
                .build()

            // On API 29+ Android requires the fgs type to be declared here too.
            // Wrap in try/catch: a denied type must NOT crash the whole app.
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                    startForeground(NOTIFICATION_ID, notification, type)
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
            } catch (e: Throwable) {
                Log.e(TAG, "startForeground failed — falling back to plain notification", e)
                // Post a regular (non-foreground) notification so the user still sees something,
                // then quietly stop the service so no crash leaks to the WebView.
                try {
                    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(NOTIFICATION_ID, notification)
                } catch (_: Throwable) {}
                stopSelf()
                return START_NOT_STICKY
            }
            return START_STICKY
        } catch (e: Throwable) {
            Log.e(TAG, "onStartCommand fatal error — swallowing to protect the app", e)
            try { stopSelf() } catch (_: Throwable) {}
            return START_NOT_STICKY
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Throwable) {}
        try {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID)
            nm.cancel(RING_NOTIFICATION_ID)
        } catch (_: Throwable) {}
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Call Notifications",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows notification during active calls"
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    private fun createRingChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java) ?: return
            // Don't delete-and-recreate the channel on every ring — doing so
            // makes the next notify() count as a fresh alert and the system
            // restarts the ringtone, which compounded with duplicate posts
            // produced the looping-ringtone bug.
            if (nm.getNotificationChannel(CHANNEL_RING_ID) != null) return
            val ringUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            val channel = NotificationChannel(
                CHANNEL_RING_ID,
                "Incoming Calls",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Full-screen alert for incoming FrogTalk calls"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 800, 600, 800)
                setBypassDnd(true)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                setSound(ringUri, attrs)
            }
            nm.createNotificationChannel(channel)
        }
    }
}
