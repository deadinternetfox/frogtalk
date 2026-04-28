package xyz.frogtalk.app

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Handles the "Decline" action on the incoming-call CallStyle notification.
 * Posts to /api/calls/decline via FcmBridge and dismisses the ring notification
 * + foreground service.
 */
class CallDeclineReceiver : BroadcastReceiver() {
    companion object { private const val TAG = "FrogTalkCallDecline" }

    override fun onReceive(context: Context, intent: Intent) {
        try {
            val callId = intent.getStringExtra(CallService.EXTRA_CALL_ID)
            val peerNick = intent.getStringExtra(CallService.EXTRA_PEER_NICK)
            FcmBridge.declineCall(context, callId, peerNick)
        } catch (e: Throwable) {
            Log.w(TAG, "declineCall failed", e)
        }
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(CallService.RING_NOTIFICATION_ID)
        } catch (_: Throwable) {}
        try {
            val stop = Intent(context, CallService::class.java).apply {
                action = CallService.ACTION_STOP_ALL
            }
            context.startService(stop)
        } catch (_: Throwable) {}
    }
}
