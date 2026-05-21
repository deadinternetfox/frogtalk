package xyz.frogtalk.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Ongoing tray notification while the user is connected to a room voice channel.
 * Keeps mic capture legitimate under Android 14+ foreground-service rules and
 * shows which channel they are in when the app is backgrounded.
 */
class VoiceService : Service() {

    companion object {
        const val TAG = "FrogTalkVoice"
        const val CHANNEL_ID = "frogtalk_voice"
        const val NOTIFICATION_ID = 43002

        const val ACTION_UPDATE = "xyz.frogtalk.app.ACTION_UPDATE_VOICE"
        const val ACTION_TOGGLE_MUTE = "xyz.frogtalk.app.ACTION_TOGGLE_VOICE_MUTE"
        const val ACTION_LEAVE = "xyz.frogtalk.app.ACTION_LEAVE_VOICE"
        const val ACTION_STOP = "xyz.frogtalk.app.ACTION_STOP_VOICE"
        const val ACTION_BROADCAST = "xyz.frogtalk.app.VOICE_ACTION"

        const val EXTRA_ROOM = "room"
        const val EXTRA_PARTICIPANTS = "participants"
        const val EXTRA_MUTED = "muted"
        const val EXTRA_ACTIVE = "active"
        const val EXTRA_STATUS = "status"
    }

    private var roomName: String = ""
    private var participantCount: Int = 1
    private var muted: Boolean = false
    private var active: Boolean = false
    private var statusText: String = "Connected"

    override fun onCreate() {
        super.onCreate()
        try { createNotificationChannel() } catch (e: Throwable) {
            Log.w(TAG, "createNotificationChannel failed", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            when (intent?.action) {
                ACTION_TOGGLE_MUTE -> {
                    muted = !muted
                    sendBroadcast(
                        Intent(ACTION_BROADCAST).putExtra("action", "toggle_mute")
                    )
                    if (active) {
                        try {
                            val notification = buildNotification()
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                startForeground(
                                    NOTIFICATION_ID,
                                    notification,
                                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                                )
                            } else {
                                startForeground(NOTIFICATION_ID, notification)
                            }
                        } catch (e: Throwable) {
                            Log.w(TAG, "mute notification refresh failed", e)
                        }
                    }
                    return START_STICKY
                }
                ACTION_LEAVE, ACTION_STOP -> {
                    sendBroadcast(
                        Intent(ACTION_BROADCAST).putExtra("action", "leave")
                    )
                    stopSelf()
                    return START_NOT_STICKY
                }
            }

            active = intent?.getBooleanExtra(EXTRA_ACTIVE, false) ?: false
            if (!active) {
                stopSelf()
                return START_NOT_STICKY
            }

            roomName = sanitize(intent?.getStringExtra(EXTRA_ROOM))
            participantCount = (intent?.getIntExtra(EXTRA_PARTICIPANTS, 1) ?: 1).coerceIn(1, 999)
            muted = intent?.getBooleanExtra(EXTRA_MUTED, false) ?: false
            statusText = sanitize(intent?.getStringExtra(EXTRA_STATUS), 80)
                .ifBlank { "Connected" }

            val notification = buildNotification()
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                    )
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
            } catch (e: Throwable) {
                Log.e(TAG, "startForeground failed — posting plain notification", e)
                try {
                    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(NOTIFICATION_ID, notification)
                } catch (_: Throwable) {}
                stopSelf()
                return START_NOT_STICKY
            }
            return START_STICKY
        } catch (e: Throwable) {
            Log.e(TAG, "onStartCommand failed", e)
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
        } catch (_: Throwable) {}
        super.onDestroy()
    }

    private fun sanitize(raw: String?, maxLen: Int = 64): String {
        val cleaned = (raw ?: "").replace(Regex("[\\x00-\\x1f\\x7f]+"), " ").trim()
        return if (cleaned.length > maxLen) cleaned.substring(0, maxLen) else cleaned
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Voice Channels",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shows which FrogTalk voice channel you are in"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val displayRoom = roomName.ifBlank { "channel" }
        val title = "In voice · #$displayRoom"
        val micLabel = if (muted) "Mic muted" else "Mic on"
        val body = when {
            statusText.equals("Connecting…", ignoreCase = true) -> "Connecting to #$displayRoom…"
            participantCount <= 1 -> "$micLabel · just you"
            else -> "$participantCount in voice · $micLabel"
        }

        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("open_voice", true)
            if (roomName.isNotBlank()) putExtra("voice_room", roomName)
        }
        val openPending = PendingIntent.getActivity(
            this, 40, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val muteIntent = Intent(this, VoiceService::class.java).apply {
            action = ACTION_TOGGLE_MUTE
        }
        val mutePending = PendingIntent.getService(
            this, 41, muteIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val leaveIntent = Intent(this, VoiceService::class.java).apply {
            action = ACTION_LEAVE
        }
        val leavePending = PendingIntent.getService(
            this, 42, leaveIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val accent = try {
            ContextCompat.getColor(this, R.color.frog_green)
        } catch (_: Throwable) {
            0xFF4CAF50.toInt()
        }

        val muteIcon = if (muted) {
            android.R.drawable.ic_lock_silent_mode
        } else {
            android.R.drawable.ic_btn_speak_now
        }
        val muteActionLabel = if (muted) "Unmute" else "Mute"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(accent)
            .setColorized(true)
            .setSubText("FrogTalk Voice")
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(openPending)
            .setDeleteIntent(leavePending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .addAction(muteIcon, muteActionLabel, mutePending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Disconnect", leavePending)
            .build()
    }
}
