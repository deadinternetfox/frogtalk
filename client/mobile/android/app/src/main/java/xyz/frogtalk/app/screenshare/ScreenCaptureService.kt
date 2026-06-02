package xyz.frogtalk.app.screenshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import xyz.frogtalk.app.MainActivity
import xyz.frogtalk.app.R

/**
 * Foreground service that hosts the native screen-share capture + WebRTC peer.
 *
 * Android 14+ (targetSdk 35) requires a service with
 * `foregroundServiceType=mediaProjection` to be in the foreground BEFORE the
 * MediaProjection is created, so we startForeground() first and only then build
 * the [ScreenSharePeer] (which creates the projection inside startCapture()).
 *
 * Kept separate from CallService so the projection lifecycle and its mandatory
 * capture notification never entangle the call ring/mute notification logic.
 */
class ScreenCaptureService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSharing("user_stopped")
                return START_NOT_STICKY
            }
            else -> {
                val resultData: Intent? = intent?.getParcelableExtra(EXTRA_RESULT_DATA)
                val argsJson = intent?.getStringExtra(EXTRA_ARGS_JSON) ?: ""
                val baseUrl = intent?.getStringExtra(EXTRA_BASE_URL) ?: ""
                if (resultData == null || argsJson.isBlank() || baseUrl.isBlank()) {
                    Log.w(TAG, "missing projection data/args — aborting")
                    notifyError("bad_request")
                    stopSelf()
                    return START_NOT_STICKY
                }
                startForegroundCapture(resultData, argsJson, baseUrl)
            }
        }
        return START_NOT_STICKY
    }

    private fun startForegroundCapture(resultData: Intent, argsJson: String, baseUrl: String) {
        try {
            // Android 10+ requires the FGS type to be declared at startForeground
            // time for a mediaProjection service; 14+ enforces it strictly.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                )
            } else {
                startForeground(NOTIFICATION_ID, buildNotification())
            }
        } catch (e: Throwable) {
            Log.e(TAG, "startForeground failed", e)
            notifyError("fgs_failed")
            stopSelf()
            return
        }
        val cfg = try {
            ScreenShareConfig.fromJson(argsJson, baseUrl)
        } catch (e: Throwable) {
            Log.e(TAG, "bad config", e)
            notifyError("bad_config")
            stopSelfClean()
            return
        }
        val peer = ScreenSharePeer(
            applicationContext,
            cfg,
            resultData,
            object : ScreenSharePeer.Callback {
                override fun onSharingStarted() {
                    notifyJs("if(typeof onNativeScreenShareStarted==='function')onNativeScreenShareStarted();")
                }
                override fun onSharingStopped(reason: String) {
                    // Surface a toast ONLY for genuine "never got going" failures.
                    // Everything else — user stopped, a viewer left, projection
                    // revoked, service torn down, a peer that DID connect — is a
                    // normal end and must stay silent (a working share that the
                    // other side saw was wrongly reporting "failed" before this).
                    val isFailure = reason == "no_viewer_connection" ||
                        reason == "init_failed" ||
                        reason == "peer_failed" ||
                        reason.startsWith("all_peers_gone:")
                    if (isFailure) {
                        notifyError(reason)
                    } else {
                        notifyJs("if(typeof onNativeScreenShareStopped==='function')onNativeScreenShareStopped();")
                    }
                    stopSelfClean()
                }
            }
        )
        activePeer = peer
        peer.start()
    }

    private fun stopSharing(reason: String) {
        try { activePeer?.stop(reason) } catch (_: Throwable) {}
        activePeer = null
        stopSelfClean()
    }

    private fun stopSelfClean() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION") stopForeground(true)
            }
        } catch (_: Throwable) {}
        stopSelf()
    }

    private fun notifyJs(js: String) {
        try { MainActivity.runJsOnWebView(js) } catch (_: Throwable) {}
    }

    private fun notifyError(reason: String) {
        val safe = reason.replace("'", "")
        notifyJs("if(typeof onNativeScreenShareError==='function')onNativeScreenShareError('$safe');")
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Screen sharing",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Active while you share your screen in a call" }
            mgr.createNotificationChannel(ch)
        }
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentPi = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopPi = PendingIntent.getService(
            this, 1,
            Intent(this, ScreenCaptureService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Sharing your screen")
            .setContentText("FrogTalk is sharing your screen in a call")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setContentIntent(contentPi)
            .addAction(Notification.Action.Builder(null, "Stop sharing", stopPi).build())
        return builder.build()
    }

    override fun onDestroy() {
        try { activePeer?.stop("service_destroyed") } catch (_: Throwable) {}
        activePeer = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "FTScreenService"
        private const val CHANNEL_ID = "frogtalk_screenshare"
        private const val NOTIFICATION_ID = 43003

        const val ACTION_STOP = "xyz.frogtalk.app.SCREEN_STOP"
        const val EXTRA_RESULT_DATA = "result_data"
        const val EXTRA_ARGS_JSON = "args_json"
        const val EXTRA_BASE_URL = "base_url"

        @Volatile private var activePeer: ScreenSharePeer? = null

        fun isActive(): Boolean = activePeer != null

        /** Start the foreground capture service with the projection consent
         *  result + bridge args. Uses the mediaProjection FGS type on 10+. */
        fun start(context: Context, resultData: Intent, argsJson: String, baseUrl: String) {
            val i = Intent(context, ScreenCaptureService::class.java).apply {
                putExtra(EXTRA_RESULT_DATA, resultData)
                putExtra(EXTRA_ARGS_JSON, argsJson)
                putExtra(EXTRA_BASE_URL, baseUrl)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else {
                context.startService(i)
            }
        }

        fun stop(context: Context) {
            try {
                val i = Intent(context, ScreenCaptureService::class.java).apply { action = ACTION_STOP }
                context.startService(i)
            } catch (_: Throwable) {}
        }
    }
}
