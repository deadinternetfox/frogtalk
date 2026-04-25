package xyz.frogtalk.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsetsController
import android.webkit.*
import android.widget.FrameLayout
import android.widget.TextView
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "FrogTalk"
        private const val APP_URL = "https://frogtalk.xyz/app"
        private const val WEB_CACHE_REV = "20260424-music-background-v1"
        private const val PREFS = "frogtalk_prefs"
        private const val PREF_BATTERY_PROMPTED = "battery_prompted"
        private const val STORY_UPLOAD_NOTIFICATION_ID = 42002
        private const val STORY_UPLOAD_CHANNEL_ID = "frogtalk_upload"
    }

    private fun buildAppUrl(baseUrl: String? = null, intentOverride: Intent? = null): String {
        val rawUrl = baseUrl ?: APP_URL
        val parsed = Uri.parse(rawUrl)
        val sourceIntent = intentOverride ?: intent
        val builder = parsed.buildUpon()
            .appendQueryParameter("mobile", "android")
            .appendQueryParameter("rev", WEB_CACHE_REV)
        try {
            if (sourceIntent?.getBooleanExtra("incoming_call", false) == true) {
                builder.appendQueryParameter("incoming_call", "1")
                sourceIntent.getStringExtra(CallService.EXTRA_CALL_ID)
                    ?.takeIf { it.isNotBlank() }
                    ?.let { builder.appendQueryParameter("call_id", it) }
                sourceIntent.getStringExtra(CallService.EXTRA_PEER_NICK)
                    ?.takeIf { it.isNotBlank() }
                    ?.let { builder.appendQueryParameter("peer_nick", it) }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Could not build incoming-call URL params", e)
        }
        return builder.build().toString()
    }

    private var webView: WebView? = null
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermissionRequest: PermissionRequest? = null
    private var musicPlaybackActive: Boolean = false

    private fun shouldOpenExternally(uri: Uri): Boolean {
        val scheme = (uri.scheme ?: "").lowercase()
        if (scheme.isBlank()) return false
        if (scheme != "http" && scheme != "https") return true

        val host = (uri.host ?: "").lowercase()
        if (host.isBlank()) return false

        val appHost = (Uri.parse(APP_URL).host ?: "").lowercase()
        if (appHost.isBlank()) return false

        return !(host == appHost || host.endsWith(".$appHost"))
    }

    private fun openExternalUri(uri: Uri): Boolean {
        return try {
            val i = Intent(Intent.ACTION_VIEW, uri).apply {
                addCategory(Intent.CATEGORY_BROWSABLE)
            }
            startActivity(i)
            true
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "No activity found to open external URL: $uri", e)
            false
        } catch (e: Throwable) {
            Log.w(TAG, "Could not open external URL: $uri", e)
            false
        }
    }

    // These must be registered before onStart, which property-init guarantees
    private val fileChooserLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            try {
                val uris = if (result.resultCode == Activity.RESULT_OK) {
                    result.data?.let { intent ->
                        intent.clipData?.let { clip ->
                            Array(clip.itemCount) { clip.getItemAt(it).uri }
                        } ?: intent.data?.let { arrayOf(it) }
                    }
                } else null
                fileUploadCallback?.onReceiveValue(uris ?: emptyArray())
            } catch (e: Throwable) {
                Log.e(TAG, "File chooser result error", e)
                fileUploadCallback?.onReceiveValue(emptyArray())
            }
            fileUploadCallback = null
        }

    private val permissionLauncher: ActivityResultLauncher<Array<String>> =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            try {
                val req = pendingPermissionRequest
                if (req != null) {
                    // Grant every originally-requested resource whose backing Android
                    // permission is now held — including ones that were ALREADY granted
                    // before this prompt. Previously we only mapped back permissions
                    // freshly granted in `results`, which broke video notes whenever
                    // mic was already granted and only camera needed prompting (the
                    // audio grant would be silently dropped).
                    val grantedResources = req.resources.filter { res ->
                        when (res) {
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE ->
                                ContextCompat.checkSelfPermission(
                                    this, Manifest.permission.CAMERA
                                ) == PackageManager.PERMISSION_GRANTED
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE ->
                                ContextCompat.checkSelfPermission(
                                    this, Manifest.permission.RECORD_AUDIO
                                ) == PackageManager.PERMISSION_GRANTED
                            else -> false
                        }
                    }.toTypedArray()
                    if (grantedResources.isNotEmpty()) req.grant(grantedResources) else req.deny()
                }
            } catch (e: Throwable) {
                Log.e(TAG, "Permission result error", e)
                pendingPermissionRequest?.deny()
            }
            pendingPermissionRequest = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Set system bar colours before anything else
        try {
            WindowCompat.setDecorFitsSystemWindows(window, true)
            window.statusBarColor = 0xFF0D0D0D.toInt()
            window.navigationBarColor = 0xFF0D0D0D.toInt()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                window.insetsController?.setSystemBarsAppearance(
                    0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                )
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Could not set system bar colours", e)
        }

        // Always set the layout — even if WebView fails, the user sees something
        setContentView(R.layout.activity_main)

        // Try to initialise the WebView
        try {
            initWebView(savedInstanceState)
            registerCallReceiver()
        } catch (t: Throwable) {
            Log.e(TAG, "WebView init failed", t)
            showErrorScreen("WebView could not start:\n${t.message}")
        }

        // Back navigation
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView?.canGoBack() == true) {
                    webView?.goBack()
                } else if (musicPlaybackActive) {
                    moveTaskToBack(true)
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        // Notification permission (Android 13+)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED
                ) {
                    ActivityCompat.requestPermissions(
                        this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001
                    )
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Notification permission request failed", e)
        }

        maybePromptDisableBatteryOptimizations()
    }

    private fun maybePromptDisableBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        try {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getBoolean(PREF_BATTERY_PROMPTED, false)) return
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (pm.isIgnoringBatteryOptimizations(packageName)) {
                prefs.edit().putBoolean(PREF_BATTERY_PROMPTED, true).apply()
                return
            }
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
            prefs.edit().putBoolean(PREF_BATTERY_PROMPTED, true).apply()
        } catch (e: Throwable) {
            Log.w(TAG, "Battery optimization prompt failed", e)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun initWebView(savedInstanceState: Bundle?) {
        val container = findViewById<FrameLayout>(R.id.webview_container)

        val wv = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(0xFF0D0D0D.toInt())
        }
        container.addView(wv)
        webView = wv

        // Add JavaScript bridge for native call notifications
        wv.addJavascriptInterface(CallBridge(this), "Android")

        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            setSupportZoom(false)
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            useWideViewPort = true
            loadWithOverviewMode = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            userAgentString = "$userAgentString FrogTalkAndroid/1.0"
        }

        // Keep Service Worker fetches network-biased in WebView to avoid stale app shell/JS.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val sw = ServiceWorkerController.getInstance().serviceWorkerWebSettings
                sw.cacheMode = WebSettings.LOAD_NO_CACHE
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Could not configure ServiceWorker cache mode", e)
        }

        // Drop stale HTTP cache so latest UI/JS is fetched.
        // Do NOT clear WebStorage (localStorage/IndexedDB) — that holds the
        // user's session token and auto-login data.
        try {
            wv.clearCache(true)
            wv.clearHistory()
            CookieManager.getInstance().flush()
        } catch (e: Throwable) {
            Log.w(TAG, "Could not clear WebView cache", e)
        }

        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                view?.let { injectStoryShareTapFix(it) }
                // Hide loading screen once page loads
                hideLoadingScreen()
            }

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val uri = request.url
                return if (shouldOpenExternally(uri)) {
                    openExternalUri(uri)
                } else {
                    false
                }
            }

            override fun onRenderProcessGone(
                view: WebView, detail: RenderProcessGoneDetail
            ): Boolean {
                Log.e(TAG, "Render process gone; didCrash=${detail.didCrash()}")
                webView = null
                try { container.removeView(view); view.destroy() } catch (_: Throwable) {}
                showErrorScreen("WebView crashed. Tap Retry to reload.")
                return true
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    showErrorScreen("Connection error.\nCheck your internet connection.")
                }
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?
            ): Boolean {
                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                val popupWebView = WebView(this@MainActivity)
                popupWebView.settings.javaScriptEnabled = true
                popupWebView.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: WebResourceRequest
                    ): Boolean {
                        val uri = request.url
                        if (shouldOpenExternally(uri)) {
                            val handled = openExternalUri(uri)
                            try { view.destroy() } catch (_: Throwable) {}
                            return handled
                        }
                        // Internal URLs open in the main app WebView.
                        webView?.loadUrl(uri.toString())
                        try { view.destroy() } catch (_: Throwable) {}
                        return true
                    }
                }
                transport.webView = popupWebView
                resultMsg.sendToTarget()
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                val resources = request.resources
                val permsNeeded = mutableListOf<String>()

                if (resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity, Manifest.permission.CAMERA
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        permsNeeded.add(Manifest.permission.CAMERA)
                    }
                }
                if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity, Manifest.permission.RECORD_AUDIO
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        permsNeeded.add(Manifest.permission.RECORD_AUDIO)
                    }
                }

                if (permsNeeded.isEmpty()) {
                    request.grant(resources)
                } else {
                    pendingPermissionRequest = request
                    permissionLauncher.launch(permsNeeded.toTypedArray())
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback
                return try {
                    val intent = fileChooserParams.createIntent()
                    if (fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    fileChooserLauncher.launch(intent)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileUploadCallback?.onReceiveValue(emptyArray())
                    fileUploadCallback = null
                    false
                }
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "${message.message()} [${message.sourceId()}:${message.lineNumber()}]")
                return true
            }
        }

        // Load URL with a lightweight cache-revision query for predictable refresh.
        val rawUrl = savedInstanceState?.getString("url") ?: APP_URL
        val withRev = buildAppUrl(rawUrl)
        wv.loadUrl(withRev)

        // Deep-link handling
        intent?.data?.let { uri ->
            if (uri.host == "frogtalk.xyz") {
                wv.loadUrl(uri.toString())
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        try {
            if (intent.getBooleanExtra("incoming_call", false) == true) {
                webView?.loadUrl(buildAppUrl(APP_URL, intent))
            }
        } catch (e: Throwable) {
            Log.w(TAG, "onNewIntent incoming-call reload failed", e)
        }
    }

        private fun injectStoryShareTapFix(view: WebView) {
                try {
                        val js = """
                                (function(){
                                    if (window.__ftStoryShareNativeFix) return;
                                    window.__ftStoryShareNativeFix = true;
                                    function hook(){
                                        var modal = document.getElementById('add-story-modal');
                                        if (!modal || modal.dataset.nativeShareHooked === '1') return;
                                        var fire = function(e){
                                            var t = e && e.target;
                                            var btn = t && t.closest ? t.closest('#add-story-share-btn') : null;
                                            if (!btn) return;
                                            try { e.preventDefault(); e.stopPropagation(); } catch(_){ }
                                            try { modal.style.display = 'none'; } catch(_){ }
                                            try {
                                                if (window.Social && typeof window.Social.submitStoryFromTap === 'function') {
                                                    window.Social.submitStoryFromTap();
                                                } else if (window.Social && typeof window.Social.submitStory === 'function') {
                                                    window.Social.submitStory();
                                                }
                                            } catch(_){ }
                                        };
                                        modal.addEventListener('touchstart', fire, {capture:true, passive:false});
                                        modal.addEventListener('pointerdown', fire, {capture:true, passive:false});
                                        modal.addEventListener('click', fire, true);
                                        modal.dataset.nativeShareHooked = '1';
                                    }
                                    hook();
                                    try { new MutationObserver(hook).observe(document.body, {childList:true, subtree:true}); } catch(_){ }
                                })();
                        """.trimIndent()
                        view.evaluateJavascript(js, null)
                } catch (e: Throwable) {
                        Log.w(TAG, "Story share native fix injection failed", e)
                }
        }

    // ── UI helpers ───────────────────────────────────────────────────

    private fun hideLoadingScreen() {
        findViewById<View>(R.id.loading_screen)?.visibility = View.GONE
    }

    private fun showErrorScreen(message: String) {
        runOnUiThread {
            findViewById<View>(R.id.loading_screen)?.visibility = View.GONE
            val errorScreen = findViewById<View>(R.id.error_screen)
            errorScreen?.visibility = View.VISIBLE
            findViewById<TextView>(R.id.error_detail)?.text = message

            findViewById<View>(R.id.btn_retry)?.setOnClickListener {
                errorScreen?.visibility = View.GONE
                findViewById<View>(R.id.loading_screen)?.visibility = View.VISIBLE
                try {
                    if (webView != null) {
                        webView?.reload()
                    } else {
                        initWebView(null)
                    }
                } catch (t: Throwable) {
                    Log.e(TAG, "Retry failed", t)
                    showErrorScreen("Retry failed:\n${t.message}")
                }
            }

            findViewById<View>(R.id.btn_open_browser)?.setOnClickListener {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(APP_URL)))
                } catch (_: Throwable) {
                    // No browser available
                }
            }
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        try {
            webView?.let {
                outState.putString("url", it.url)
                it.saveState(outState)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "saveState failed", e)
        }
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        try { webView?.restoreState(savedInstanceState) } catch (_: Throwable) {}
    }

    override fun onResume() {
        super.onResume()
        try { webView?.onResume() } catch (_: Throwable) {}
    }

    override fun onPause() {
        if (!musicPlaybackActive) {
            try { webView?.onPause() } catch (_: Throwable) {}
        }
        super.onPause()
    }

    override fun onDestroy() {
        try { unregisterReceiver(callActionReceiver) } catch (_: Throwable) {}
        try { webView?.destroy() } catch (_: Throwable) {}
        webView = null
        super.onDestroy()
    }

    // ── JS Bridge for call notifications ─────────────────────────────

    class CallBridge(private val activity: MainActivity) {
        @android.webkit.JavascriptInterface
        fun startCallNotification(peerNick: String) {
            try {
                val intent = Intent(activity, CallService::class.java).apply {
                    putExtra(CallService.EXTRA_PEER_NICK, peerNick)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
            } catch (e: Throwable) {
                Log.e(TAG, "startCallNotification failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun endCallNotification() {
            try {
                val stopIntent = Intent(activity, CallService::class.java).apply {
                    action = CallService.ACTION_STOP_ALL
                }
                activity.startService(stopIntent)
                activity.stopService(Intent(activity, CallService::class.java))
            } catch (e: Throwable) {
                Log.e(TAG, "endCallNotification failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun ringForCall(peerNick: String, callId: String) {
            try {
                val intent = Intent(activity, CallService::class.java).apply {
                    action = CallService.ACTION_RING
                    putExtra(CallService.EXTRA_PEER_NICK, peerNick)
                    putExtra(CallService.EXTRA_CALL_ID, callId)
                }
                activity.startService(intent)
            } catch (e: Throwable) {
                Log.e(TAG, "ringForCall failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun dismissRing() {
            try {
                val intent = Intent(activity, CallService::class.java).apply {
                    action = CallService.ACTION_DISMISS_RING
                }
                activity.startService(intent)
            } catch (e: Throwable) {
                Log.e(TAG, "dismissRing failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun showNotification(title: String, body: String) {
            try {
                activity.showNativeNotification(title, body)
            } catch (e: Throwable) {
                Log.e(TAG, "showNotification failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun updateStoryUploadNotification(percent: Int, status: String?) {
            try {
                activity.showStoryUploadNotification(percent, status)
            } catch (e: Throwable) {
                Log.e(TAG, "updateStoryUploadNotification failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun finishStoryUploadNotification(success: Boolean, message: String?) {
            try {
                activity.finishStoryUploadNotification(success, message)
            } catch (e: Throwable) {
                Log.e(TAG, "finishStoryUploadNotification failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun updateMusicPlayback(title: String?, subtitle: String?, active: Boolean,
                                playing: Boolean, muted: Boolean) {
            try {
                activity.updateMusicPlayback(title, subtitle, active, playing, muted)
            } catch (e: Throwable) {
                Log.e(TAG, "updateMusicPlayback failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun stopMusicPlayback() {
            try {
                activity.updateMusicPlayback(null, null, false, false, false)
            } catch (e: Throwable) {
                Log.e(TAG, "stopMusicPlayback failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun registerFcmToken(sessionToken: String?) {
            try {
                FcmBridge.syncCurrentToken(activity, sessionToken)
            } catch (e: Throwable) {
                Log.e(TAG, "registerFcmToken failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun vibrate(ms: Long) {
            try {
                val clamped = ms.coerceIn(10L, 4000L)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val vm = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
                        as android.os.VibratorManager
                    vm.defaultVibrator.vibrate(
                        android.os.VibrationEffect.createOneShot(
                            clamped, android.os.VibrationEffect.DEFAULT_AMPLITUDE
                        )
                    )
                } else {
                    @Suppress("DEPRECATION")
                    val v = activity.getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        v.vibrate(
                            android.os.VibrationEffect.createOneShot(
                                clamped, android.os.VibrationEffect.DEFAULT_AMPLITUDE
                            )
                        )
                    } else {
                        @Suppress("DEPRECATION")
                        v.vibrate(clamped)
                    }
                }
            } catch (e: Throwable) {
                Log.w(TAG, "vibrate failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun playNotificationTone() {
            try {
                val uri = android.media.RingtoneManager.getDefaultUri(
                    android.media.RingtoneManager.TYPE_NOTIFICATION
                )
                val r = android.media.RingtoneManager.getRingtone(activity, uri)
                r?.play()
            } catch (e: Throwable) {
                Log.w(TAG, "playNotificationTone failed", e)
            }
        }

        // ── Camera torch (LED flashlight) ───────────────────────────
        // WebRTC's applyConstraints({torch}) is unreliable inside WebView, so
        // we expose the native CameraManager.setTorchMode API to the web UI.

        private fun rearCameraId(): String? {
            return try {
                val cm = activity.getSystemService(Context.CAMERA_SERVICE)
                    as android.hardware.camera2.CameraManager
                cm.cameraIdList.firstOrNull { id ->
                    val chars = cm.getCameraCharacteristics(id)
                    val facing = chars.get(android.hardware.camera2.CameraCharacteristics.LENS_FACING)
                    val hasFlash = chars.get(
                        android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE
                    ) == true
                    facing == android.hardware.camera2.CameraCharacteristics.LENS_FACING_BACK && hasFlash
                }
            } catch (e: Throwable) {
                Log.w(TAG, "rearCameraId failed", e)
                null
            }
        }

        @android.webkit.JavascriptInterface
        fun hasTorch(): Boolean = rearCameraId() != null

        @android.webkit.JavascriptInterface
        fun torchOn(): Boolean = setTorch(true)

        @android.webkit.JavascriptInterface
        fun torchOff(): Boolean = setTorch(false)

        private fun setTorch(enable: Boolean): Boolean {
            return try {
                val id = rearCameraId() ?: return false
                val cm = activity.getSystemService(Context.CAMERA_SERVICE)
                    as android.hardware.camera2.CameraManager
                cm.setTorchMode(id, enable)
                true
            } catch (e: Throwable) {
                Log.w(TAG, "setTorch($enable) failed", e)
                false
            }
        }
    }

    private fun showNativeNotification(title: String, body: String) {
        val channelId = "frogtalk_general"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (nm.getNotificationChannel(channelId) == null) {
                val channel = android.app.NotificationChannel(
                    channelId, "FrogTalk",
                    android.app.NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "FrogTalk notifications"
                    enableVibration(true)
                }
                nm.createNotificationChannel(channel)
            }
        }

        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = android.app.PendingIntent.getActivity(
            this, 100, openIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )

        val notification = androidx.core.app.NotificationCompat.Builder(this, channelId)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
            .setCategory(androidx.core.app.NotificationCompat.CATEGORY_SOCIAL)
            .setDefaults(androidx.core.app.NotificationCompat.DEFAULT_ALL)
            .build()

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(System.currentTimeMillis().toInt(), notification)
    }

    private fun ensureStoryUploadChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        if (nm.getNotificationChannel(STORY_UPLOAD_CHANNEL_ID) != null) return
        val channel = android.app.NotificationChannel(
            STORY_UPLOAD_CHANNEL_ID,
            "FrogTalk Uploads",
            android.app.NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Story upload progress"
            enableVibration(false)
            setSound(null, null)
        }
        nm.createNotificationChannel(channel)
    }

    private fun showStoryUploadNotification(percent: Int, status: String?) {
        ensureStoryUploadChannel()
        val clamped = percent.coerceIn(0, 100)
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = android.app.PendingIntent.getActivity(
            this, 101, openIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        val text = status?.takeIf { it.isNotBlank() } ?: "Uploading $clamped%"
        val notification = androidx.core.app.NotificationCompat.Builder(this, STORY_UPLOAD_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Posting your story")
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(clamped in 0..99)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(false)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_LOW)
            .setCategory(androidx.core.app.NotificationCompat.CATEGORY_PROGRESS)
            .setProgress(100, clamped, false)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(STORY_UPLOAD_NOTIFICATION_ID, notification)
    }

    private fun finishStoryUploadNotification(success: Boolean, message: String?) {
        ensureStoryUploadChannel()
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = android.app.PendingIntent.getActivity(
            this, 101, openIntent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        val title = if (success) "Story posted" else "Story upload failed"
        val text = message?.takeIf { it.isNotBlank() }
            ?: if (success) "Your story is now live" else "Tap back into FrogTalk to retry"
        val icon = if (success) android.R.drawable.stat_sys_upload_done else android.R.drawable.stat_notify_error
        val notification = androidx.core.app.NotificationCompat.Builder(this, STORY_UPLOAD_CHANNEL_ID)
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(false)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_LOW)
            .setProgress(0, 0, false)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(STORY_UPLOAD_NOTIFICATION_ID, notification)
    }

    private fun updateMusicPlayback(
        title: String?,
        subtitle: String?,
        active: Boolean,
        playing: Boolean,
        muted: Boolean,
    ) {
        musicPlaybackActive = active
        try {
            val intent = Intent(this, MusicService::class.java).apply {
                action = if (active) MusicService.ACTION_UPDATE else MusicService.ACTION_STOP
                putExtra(MusicService.EXTRA_ACTIVE, active)
                putExtra(MusicService.EXTRA_PLAYING, playing)
                putExtra(MusicService.EXTRA_MUTED, muted)
                putExtra(MusicService.EXTRA_TITLE, title ?: "FrogTalk Music")
                putExtra(MusicService.EXTRA_SUBTITLE, subtitle ?: "Playing in background")
            }
            if (active && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        } catch (e: Throwable) {
            Log.e(TAG, "updateMusicPlayback dispatch failed", e)
        }
    }

    // ── Broadcast receiver for notification actions ──────────────────

    private val callActionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val command = intent.getStringExtra("action") ?: return
            when (intent.action ?: "") {
                "xyz.frogtalk.app.CALL_ACTION" -> when (command) {
                    "end" -> webView?.post { webView?.evaluateJavascript("if(typeof hangUp==='function')hangUp()", null) }
                    "mute" -> webView?.post { webView?.evaluateJavascript("if(typeof toggleMuteAudio==='function')toggleMuteAudio()", null) }
                }
                MusicService.ACTION_BROADCAST -> when (command) {
                    "toggle_play" -> webView?.post {
                        webView?.evaluateJavascript(
                            "try{window.Music&&window.Music.togglePauseGlobal&&window.Music.togglePauseGlobal();}catch(e){}",
                            null
                        )
                    }
                    "set_muted" -> {
                        val muted = intent.getBooleanExtra(MusicService.EXTRA_MUTED, false)
                        webView?.post {
                            webView?.evaluateJavascript(
                                "try{window.Music&&window.Music.setNativeMuted&&window.Music.setNativeMuted(${if (muted) "true" else "false"});}catch(e){}",
                                null
                            )
                        }
                    }
                    "stop" -> {
                        musicPlaybackActive = false
                        webView?.post {
                            webView?.evaluateJavascript(
                                "try{window.Music&&window.Music.close&&window.Music.close();}catch(e){}",
                                null
                            )
                        }
                    }
                }
            }
        }
    }

    @Suppress("UnspecifiedRegisterReceiverFlag")
    private fun registerCallReceiver() {
        try {
            val filter = IntentFilter("xyz.frogtalk.app.CALL_ACTION").apply {
                addAction(MusicService.ACTION_BROADCAST)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(callActionReceiver, filter, RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(callActionReceiver, filter)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "registerCallReceiver failed", e)
        }
    }
}
