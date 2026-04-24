package xyz.frogtalk.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

class MusicService : Service() {

    companion object {
        const val TAG = "FrogTalkMusic"
        const val CHANNEL_ID = "frogtalk_music"
        const val NOTIFICATION_ID = 43001

        const val ACTION_UPDATE = "xyz.frogtalk.app.ACTION_UPDATE_MUSIC"
        const val ACTION_TOGGLE_PLAY = "xyz.frogtalk.app.ACTION_TOGGLE_MUSIC_PLAY"
        const val ACTION_TOGGLE_MUTE = "xyz.frogtalk.app.ACTION_TOGGLE_MUSIC_MUTE"
        const val ACTION_STOP = "xyz.frogtalk.app.ACTION_STOP_MUSIC"
        const val ACTION_BROADCAST = "xyz.frogtalk.app.MUSIC_ACTION"

        const val EXTRA_TITLE = "title"
        const val EXTRA_SUBTITLE = "subtitle"
        const val EXTRA_ACTIVE = "active"
        const val EXTRA_PLAYING = "playing"
        const val EXTRA_MUTED = "muted"
    }

    private var currentTitle: String = "FrogTalk Music"
    private var currentSubtitle: String = "Playing in background"
    private var currentPlaying: Boolean = true
    private var currentMuted: Boolean = false
    private var currentActive: Boolean = false

    override fun onCreate() {
        super.onCreate()
        try { createNotificationChannel() } catch (e: Throwable) {
            Log.w(TAG, "createNotificationChannel failed", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            when (intent?.action) {
                ACTION_TOGGLE_PLAY -> {
                    currentPlaying = !currentPlaying
                    sendBroadcast(Intent(ACTION_BROADCAST).putExtra("action", "toggle_play"))
                    startForegroundCompat(buildNotification())
                    return START_STICKY
                }
                ACTION_TOGGLE_MUTE -> {
                    currentMuted = !currentMuted
                    applyMute(currentMuted)
                    sendBroadcast(
                        Intent(ACTION_BROADCAST)
                            .putExtra("action", "set_muted")
                            .putExtra(EXTRA_MUTED, currentMuted)
                    )
                    startForegroundCompat(buildNotification())
                    return START_STICKY
                }
                ACTION_STOP -> {
                    currentActive = false
                    currentPlaying = false
                    if (currentMuted) {
                        currentMuted = false
                        applyMute(false)
                    }
                    sendBroadcast(Intent(ACTION_BROADCAST).putExtra("action", "stop"))
                    stopForegroundCompat()
                    stopSelf()
                    return START_NOT_STICKY
                }
                ACTION_UPDATE, null -> {
                    currentActive = intent?.getBooleanExtra(EXTRA_ACTIVE, currentActive) == true
                    currentTitle = intent?.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() }
                        ?: currentTitle
                    currentSubtitle = intent?.getStringExtra(EXTRA_SUBTITLE)?.takeIf { it.isNotBlank() }
                        ?: currentSubtitle
                    currentPlaying = intent?.getBooleanExtra(EXTRA_PLAYING, currentPlaying) ?: currentPlaying
                    currentMuted = intent?.getBooleanExtra(EXTRA_MUTED, currentMuted) ?: currentMuted
                    if (!currentActive) {
                        if (currentMuted) {
                            currentMuted = false
                            applyMute(false)
                        }
                        stopForegroundCompat()
                        stopSelf()
                        return START_NOT_STICKY
                    }
                    startForegroundCompat(buildNotification())
                    return START_STICKY
                }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "onStartCommand failed", e)
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try {
            if (currentMuted) applyMute(false)
        } catch (_: Throwable) {}
        stopForegroundCompat()
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            this, 30, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playIntent = Intent(this, MusicService::class.java).apply { action = ACTION_TOGGLE_PLAY }
        val playPending = PendingIntent.getService(
            this, 31, playIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val muteIntent = Intent(this, MusicService::class.java).apply { action = ACTION_TOGGLE_MUTE }
        val mutePending = PendingIntent.getService(
            this, 32, muteIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, MusicService::class.java).apply { action = ACTION_STOP }
        val stopPending = PendingIntent.getService(
            this, 33, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playIcon = if (currentPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val playLabel = if (currentPlaying) "Pause" else "Play"
        val muteIcon = if (currentMuted) android.R.drawable.ic_lock_silent_mode_off else android.R.drawable.ic_lock_silent_mode
        val muteLabel = if (currentMuted) "Unmute" else "Mute"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTitle)
            .setContentText(currentSubtitle)
            .setContentIntent(openPending)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .addAction(playIcon, playLabel, playPending)
            .addAction(muteIcon, muteLabel, mutePending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPending)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        if (nm?.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "FrogTalk Music",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Background music playback controls"
            setSound(null, null)
            enableVibration(false)
        }
        nm?.createNotificationChannel(channel)
    }

    private fun startForegroundCompat(notification: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Throwable) {
            Log.e(TAG, "startForeground failed", e)
            try {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(NOTIFICATION_ID, notification)
            } catch (_: Throwable) {}
        }
    }

    private fun stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Throwable) {}
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(NOTIFICATION_ID)
        } catch (_: Throwable) {}
    }

    private fun applyMute(muted: Boolean) {
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.adjustStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    if (muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE,
                    0
                )
            } else {
                @Suppress("DEPRECATION")
                am.setStreamMute(AudioManager.STREAM_MUSIC, muted)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "applyMute($muted) failed", e)
        }
    }
}