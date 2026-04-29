package xyz.frogtalk.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.util.LruCache
import androidx.core.app.NotificationCompat
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MusicService : Service() {

    companion object {
        const val TAG = "FrogTalkMusic"
        const val CHANNEL_ID = "frogtalk_music"
        const val NOTIFICATION_ID = 43001
        const val MEDIA_SESSION_TAG = "FrogTalkMusicSession"
        // Brand green for the colorized notification card on Android 12+.
        const val BRAND_COLOR = 0xFF4CAF50.toInt()

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
        const val EXTRA_ARTWORK_URL = "artwork_url"
        const val EXTRA_PROVIDER = "provider"

        // Mirror static/js/music.js _ARTWORK_HOSTS — defense in depth.
        private val ARTWORK_HOSTS = setOf(
            "i.ytimg.com", "img.youtube.com", "i1.sndcdn.com", "i.scdn.co"
        )
        private const val MAX_TEXT = 200
    }

    private var currentTitle: String = "FrogTalk Music"
    private var currentSubtitle: String = "Playing in background"
    private var currentPlaying: Boolean = true
    private var currentMuted: Boolean = false
    private var currentActive: Boolean = false
    private var currentArtworkUrl: String = ""
    private var currentProvider: String = ""
    private var currentArtBitmap: Bitmap? = null

    private var mediaSession: MediaSessionCompat? = null
    private val artExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    // 8 MB bitmap cache, sized in bytes via byteCount.
    private val artCache = object : LruCache<String, Bitmap>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    override fun onCreate() {
        super.onCreate()
        try { createNotificationChannel() } catch (e: Throwable) {
            Log.w(TAG, "createNotificationChannel failed", e)
        }
        try { initMediaSession() } catch (e: Throwable) {
            Log.w(TAG, "initMediaSession failed", e)
        }
    }

    private fun initMediaSession() {
        val session = MediaSessionCompat(this, MEDIA_SESSION_TAG).apply {
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            )
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() { dispatchSelf(ACTION_TOGGLE_PLAY) }
                override fun onPause() { dispatchSelf(ACTION_TOGGLE_PLAY) }
                override fun onSkipToNext() {
                    sendBroadcast(Intent(ACTION_BROADCAST).putExtra("action", "skip_next"))
                }
                override fun onStop() { dispatchSelf(ACTION_STOP) }
            })
            isActive = true
        }
        mediaSession = session
    }

    private fun dispatchSelf(action: String) {
        try {
            startService(Intent(this, MusicService::class.java).apply { this.action = action })
        } catch (e: Throwable) {
            Log.w(TAG, "dispatchSelf($action) failed", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            when (intent?.action) {
                ACTION_TOGGLE_PLAY -> {
                    // Compute the user's target state (what they want
                    // after the tap) and ship it on the broadcast so
                    // MainActivity can branch without re-reading any
                    // service state. For YouTube going paused→playing
                    // we DO NOT optimistically flip currentPlaying or
                    // refresh the notification: the activity has to
                    // come to the foreground for YT's iframe to honor
                    // playVideo, and during that bring-up the icon
                    // should stay on ▶ so the user sees no lie. JS
                    // pushes the truth (ACTION_UPDATE) once playback
                    // actually starts, which then refreshes the icon.
                    // SoundCloud + Spotify play from background fine —
                    // they keep the optimistic flip for snappy UI.
                    val target = !currentPlaying
                    val ytResume = currentProvider == "youtube" && target
                    sendBroadcast(
                        Intent(ACTION_BROADCAST)
                            .setPackage(packageName)
                            .putExtra("action", "toggle_play")
                            .putExtra(EXTRA_PROVIDER, currentProvider)
                            .putExtra(EXTRA_PLAYING, target)
                    )
                    if (!ytResume) {
                        currentPlaying = target
                        refreshNotification()
                    }
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
                    refreshNotification()
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
                    currentTitle = intent?.getStringExtra(EXTRA_TITLE)
                        ?.let { sanitizeText(it) }
                        ?.takeIf { it.isNotBlank() } ?: currentTitle
                    currentSubtitle = intent?.getStringExtra(EXTRA_SUBTITLE)
                        ?.let { sanitizeText(it) }
                        ?.takeIf { it.isNotBlank() } ?: currentSubtitle
                    currentPlaying = intent?.getBooleanExtra(EXTRA_PLAYING, currentPlaying) ?: currentPlaying
                    currentMuted = intent?.getBooleanExtra(EXTRA_MUTED, currentMuted) ?: currentMuted
                    currentProvider = intent?.getStringExtra(EXTRA_PROVIDER)?.take(64) ?: currentProvider
                    val newArt = intent?.getStringExtra(EXTRA_ARTWORK_URL) ?: ""
                    if (newArt != currentArtworkUrl) {
                        currentArtworkUrl = newArt
                        currentArtBitmap = artCache.get(newArt)
                        if (currentArtBitmap == null && newArt.isNotBlank() && isAllowedArtHost(newArt)) {
                            loadArtworkAsync(newArt)
                        }
                    }
                    if (!currentActive) {
                        if (currentMuted) {
                            currentMuted = false
                            applyMute(false)
                        }
                        stopForegroundCompat()
                        stopSelf()
                        return START_NOT_STICKY
                    }
                    refreshNotification()
                    return START_STICKY
                }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "onStartCommand failed", e)
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * Called when the user swipes our task away from the recents list. The
     * media notification should not survive that — kill the foreground
     * notification, broadcast a stop so the WebView side clears its UI on
     * next launch, and stop the service.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        try {
            currentActive = false
            currentPlaying = false
            if (currentMuted) {
                try { applyMute(false) } catch (_: Throwable) {}
                currentMuted = false
            }
            try {
                sendBroadcast(Intent(ACTION_BROADCAST).putExtra("action", "stop"))
            } catch (_: Throwable) {}
            stopForegroundCompat()
        } catch (e: Throwable) {
            Log.w(TAG, "onTaskRemoved cleanup failed", e)
        }
        try { stopSelf() } catch (_: Throwable) {}
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        try {
            if (currentMuted) applyMute(false)
        } catch (_: Throwable) {}
        try {
            mediaSession?.isActive = false
            mediaSession?.release()
            mediaSession = null
        } catch (_: Throwable) {}
        try { artExecutor.shutdownNow() } catch (_: Throwable) {}
        stopForegroundCompat()
        super.onDestroy()
    }

    private fun refreshNotification() {
        try {
            updateMediaSessionState()
            startForegroundCompat(buildNotification())
        } catch (e: Throwable) {
            Log.w(TAG, "refreshNotification failed", e)
        }
    }

    private fun updateMediaSessionState() {
        val session = mediaSession ?: return
        try {
            session.setMetadata(
                MediaMetadataCompat.Builder()
                    .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
                    .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentSubtitle)
                    .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "FrogTalk")
                    .also { b ->
                        currentArtBitmap?.let {
                            b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
                            b.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
                        }
                    }
                    .build()
            )
            val state = if (currentPlaying)
                PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
            session.setPlaybackState(
                PlaybackStateCompat.Builder()
                    .setActions(
                        PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_STOP or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                    )
                    .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                    .build()
            )
        } catch (e: Throwable) {
            Log.w(TAG, "updateMediaSessionState failed", e)
        }
    }

    private fun sanitizeText(s: String): String {
        // Strip C0 + DEL, collapse whitespace, cap length.
        val cleaned = s.replace(Regex("[\\x00-\\x1f\\x7f]+"), " ").trim()
        return if (cleaned.length > MAX_TEXT) cleaned.substring(0, MAX_TEXT) else cleaned
    }

    private fun isAllowedArtHost(url: String): Boolean {
        return try {
            val u = URL(url)
            (u.protocol == "https" || u.protocol == "http") && ARTWORK_HOSTS.contains(u.host)
        } catch (_: Throwable) { false }
    }

    private fun loadArtworkAsync(url: String) {
        artExecutor.execute {
            val bmp = downloadAndDecode(url) ?: return@execute
            artCache.put(url, bmp)
            mainHandler.post {
                // Only apply if the user hasn't moved on to a different track.
                if (currentArtworkUrl == url && currentActive) {
                    currentArtBitmap = bmp
                    refreshNotification()
                }
            }
        }
    }

    private fun downloadAndDecode(url: String): Bitmap? {
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 5000
                readTimeout = 8000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "FrogTalk/Android")
            }
            conn.inputStream.use { input ->
                val raw = input.readBytes()
                if (raw.size > 4 * 1024 * 1024) return null  // hard cap 4MB
                // Decode bounds first to compute sample size.
                val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(raw, 0, raw.size, opts)
                var sample = 1
                val target = 512
                val short = minOf(opts.outWidth, opts.outHeight).coerceAtLeast(1)
                while (short / sample > target) sample *= 2
                val opts2 = BitmapFactory.Options().apply { inSampleSize = sample }
                BitmapFactory.decodeByteArray(raw, 0, raw.size, opts2)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "downloadAndDecode($url) failed", e)
            null
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("open_music", true)
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

        val style = androidx.media.app.NotificationCompat.MediaStyle()
            .setShowActionsInCompactView(0, 2)  // Play/Pause + Stop
            .setShowCancelButton(true)
            .setCancelButtonIntent(stopPending)
        mediaSession?.sessionToken?.let { style.setMediaSession(it) }

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTitle)
            .setContentText(currentSubtitle)
            .setContentIntent(openPending)
            .setDeleteIntent(stopPending)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(currentPlaying)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setColor(BRAND_COLOR)
            .setColorized(true)
            .setStyle(style)
            .addAction(playIcon, playLabel, playPending)
            .addAction(muteIcon, muteLabel, mutePending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPending)

        currentArtBitmap?.let { builder.setLargeIcon(it) }

        return builder.build()
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
