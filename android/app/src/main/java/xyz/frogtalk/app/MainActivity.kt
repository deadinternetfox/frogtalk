package xyz.frogtalk.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.*
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "FrogTalk"
        private const val APP_URL = "https://frogtalk.xyz/app"
        /** Pre-filled in the first-run dialog; user can edit or clear before connecting. */
        private const val OFFICIAL_SERVER_INPUT = "frogtalk.xyz"
        private const val WEB_CACHE_REV = "20260424-music-background-v1"
        private const val PREFS = "frogtalk_prefs"
        private const val PREF_SERVER_BASE_URL = "server_base_url"
        private const val PREF_BATTERY_PROMPTED = "battery_prompted"
        private const val PREF_BATTERY_PROMPTED_AT = "battery_prompted_at"
        // 10.5: anti-screenshot. Default true so a fresh install gets
        // the protection; the user can opt out via Settings→Privacy.
        private const val PREF_BLOCK_SCREENSHOTS = "block_screenshots"
        // Re-nag for battery-optimization exemption every 7 days. WhatsApp-grade
        // call delivery on aggressive OEM ROMs (Xiaomi/Oppo/Samsung) collapses
        // without it; one decline shouldn't lock the user out of reliable rings.
        private const val BATTERY_REPROMPT_INTERVAL_MS = 7L * 24 * 60 * 60 * 1000
        private const val STORY_UPLOAD_NOTIFICATION_ID = 42002
        private const val STORY_UPLOAD_CHANNEL_ID = "frogtalk_upload"

        /**
         * Tracks whether the activity is currently visible (between onResume
         * and onPause). FrogTalkFirebaseMessagingService consults this flag
         * so that when the server sends a DM push while the user is actively
         * looking at the app, we suppress the duplicate tray notification —
         * the in-app toast handles that case. When the app is backgrounded
         * or screen-off, the FCM service posts the heads-up as usual.
         */
        @Volatile
        @JvmStatic
        var isAppVisible: Boolean = false
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
                // (Removed auto_accept handling: the notification no longer
                //  has an Answer button — tapping always just opens the app
                //  and the in-app #incoming-call popup handles Accept.)
            }
            // Generic deep-link: open a DM with this nick on launch. Used by
            // both message-notification taps and incoming-call taps so the
            // user always lands in the right thread.
            sourceIntent?.getStringExtra("dm_nick")
                ?.takeIf { it.isNotBlank() }
                ?.let { builder.appendQueryParameter("dm", it) }
        } catch (e: Throwable) {
            Log.w(TAG, "Could not build incoming-call URL params", e)
        }
        return builder.build().toString()
    }

    private var webView: WebView? = null
    private var webViewInitialized = false
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermissionRequest: PermissionRequest? = null
    private var musicPlaybackActive: Boolean = false
    private var pendingBatteryPromptAfterNotifications: Boolean = false

    private fun normalizeServerBaseUrl(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        var u = raw.trim()
        if (!u.startsWith("http://", ignoreCase = true) &&
            !u.startsWith("https://", ignoreCase = true)
        ) {
            u = "https://$u"
        }
        return try {
            val parsed = Uri.parse(u)
            val host = parsed.host?.trim()?.lowercase().orEmpty()
            if (host.isBlank()) return null
            val scheme = (parsed.scheme ?: "https").lowercase()
            if (scheme != "http" && scheme != "https") return null
            val port = parsed.port
            val base = if (port != -1 && port != 80 && port != 443) {
                "$scheme://$host:$port"
            } else {
                "$scheme://$host"
            }
            base.trimEnd('/')
        } catch (_: Throwable) {
            null
        }
    }

    private fun getServerBaseUrl(): String {
        return try {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_SERVER_BASE_URL, "")?.trim().orEmpty()
        } catch (_: Throwable) {
            ""
        }
    }

    private fun getConfiguredAppEntryUrl(): String {
        val base = getServerBaseUrl()
        require(base.isNotBlank()) { "Server URL not configured" }
        return "$base/app"
    }

    private fun isAppHost(host: String): Boolean {
        val configured = normalizeServerBaseUrl(getServerBaseUrl()) ?: return false
        val appHost = (Uri.parse(configured).host ?: "").lowercase()
        val h = host.lowercase()
        if (appHost.isBlank() || h.isBlank()) return false
        return h == appHost || h.endsWith(".$appHost")
    }

    private fun isAppPath(path: String?): Boolean {
        val p = path?.trim().orEmpty()
        if (p.isBlank()) return false
        return p == "/app" || p.startsWith("/app/")
    }

    private fun ensureServerConfigured(onReady: () -> Unit) {
        if (normalizeServerBaseUrl(getServerBaseUrl()) != null) {
            onReady()
            return
        }
        showServerSetupDialog(onReady)
    }

    private fun persistServerFromInput(input: EditText, onReady: () -> Unit): Boolean {
        val normalized = normalizeServerBaseUrl(input.text?.toString())
        if (normalized == null) {
            showErrorScreen("Invalid server URL.\nTap Retry to enter a valid address.")
            return false
        }
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(PREF_SERVER_BASE_URL, normalized).apply()
        onReady()
        return true
    }

    private fun showServerSetupDialog(onReady: () -> Unit) {
        val input = EditText(this).apply {
            setText(OFFICIAL_SERVER_INPUT)
            setSelection(text?.length ?: 0)
            setSingleLine(true)
            setPadding(48, 32, 48, 32)
            hint = OFFICIAL_SERVER_INPUT
        }
        AlertDialog.Builder(this)
            .setTitle("Connect to your FrogTalk node")
            .setMessage(
                "Most people use the official FrogTalk node at frogtalk.xyz — it is pre-filled below. " +
                    "Edit or replace it to use your own self-hosted server or any trusted community node."
            )
            .setView(input)
            .setCancelable(false)
            .setNegativeButton("Use official") { _, _ ->
                input.setText(OFFICIAL_SERVER_INPUT)
                persistServerFromInput(input, onReady)
            }
            .setPositiveButton("Connect") { _, _ ->
                persistServerFromInput(input, onReady)
            }
            .show()
    }

    fun setServerBaseUrlFromJs(url: String) {
        val normalized = normalizeServerBaseUrl(url) ?: return
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(PREF_SERVER_BASE_URL, normalized).apply()
        runOnUiThread {
            try {
                webView?.loadUrl(buildAppUrl(getConfiguredAppEntryUrl()))
            } catch (e: Throwable) {
                Log.e(TAG, "setServerBaseUrlFromJs reload failed", e)
            }
        }
    }

    private fun shouldOpenExternally(uri: Uri): Boolean {
        val scheme = (uri.scheme ?: "").lowercase()
        if (scheme.isBlank()) return false
        if (scheme == "about" || scheme == "data") return false
        if (scheme != "http" && scheme != "https") return true

        val host = (uri.host ?: "").lowercase()
        if (host.isBlank()) return true

        // Keep only /app routes in the in-app WebView.
        if (!isAppHost(host)) return true
        return !isAppPath(uri.path)
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

    private fun handleRequestedUrl(url: String?): Boolean {
        val raw = url?.trim().orEmpty()
        if (raw.isEmpty()) return false
        return try {
            val uri = Uri.parse(raw)
            if (shouldOpenExternally(uri)) {
                openExternalUri(uri)
                true
            } else {
                webView?.loadUrl(uri.toString())
                true
            }
        } catch (e: Throwable) {
            Log.w(TAG, "Could not handle requested URL: $raw", e)
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
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
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

    private val notificationPermissionLauncher: ActivityResultLauncher<String> =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            if (pendingBatteryPromptAfterNotifications) {
                pendingBatteryPromptAfterNotifications = false
                maybePromptDisableBatteryOptimizations()
            }
        }

    private val batteryOptimizationLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            try {
                val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                val granted = pm.isIgnoringBatteryOptimizations(packageName)
                prefs.edit()
                    .putBoolean(PREF_BATTERY_PROMPTED, granted)
                    .putLong(PREF_BATTERY_PROMPTED_AT, System.currentTimeMillis())
                    .apply()
            } catch (_: Throwable) {}
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Context-aware screenshot blocking: default OFF so users can
        // freely screenshot public/community rooms (memes, share-worthy
        // content). The web shell turns FLAG_SECURE on via
        // CallBridge.setBlockScreenshots(true) the moment it enters a
        // DM, a private room, or a thread that has disappearing /
        // view-once messages active. See static/js/screenshot_guard.js.
        try {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            // Honour a sticky user override ("always block") if it
            // was set before this version – otherwise stay unsecured
            // until the JS guard asks for protection.
            if (prefs.getBoolean(PREF_BLOCK_SCREENSHOTS, false)) {
                window.setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE
                )
            }
        } catch (e: Throwable) {
            Log.w(TAG, "FLAG_SECURE init failed", e)
        }

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

        // Prompt for a server URL on first launch, then initialise WebView.
        ensureServerConfigured {
            if (webViewInitialized) return@ensureServerConfigured
            try {
                initWebView(savedInstanceState)
                registerCallReceiver()
                webViewInitialized = true
            } catch (t: Throwable) {
                Log.e(TAG, "WebView init failed", t)
                showErrorScreen("WebView could not start:\n${t.message}")
            }
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

        startFirstRunPromptFlow()
    }

    private fun startFirstRunPromptFlow() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                pendingBatteryPromptAfterNotifications = true
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                return
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
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (pm.isIgnoringBatteryOptimizations(packageName)) {
                // Already exempt — record state and bail.
                prefs.edit().putBoolean(PREF_BATTERY_PROMPTED, true).apply()
                return
            }
            // Not exempt. Re-prompt only if it's been >= 7 days since the
            // last prompt (or this is the first time).
            val lastPromptedAt = prefs.getLong(PREF_BATTERY_PROMPTED_AT, 0L)
            val now = System.currentTimeMillis()
            if (lastPromptedAt != 0L && now - lastPromptedAt < BATTERY_REPROMPT_INTERVAL_MS) {
                return
            }
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            batteryOptimizationLauncher.launch(intent)
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
                    true
                } else {
                    false
                }
            }

            @Suppress("DEPRECATION")
            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return handleRequestedUrl(url)
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
                val hitUrl = view?.hitTestResult?.extra
                if (!hitUrl.isNullOrBlank()) {
                    return handleRequestedUrl(hitUrl)
                }

                val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                val popupWebView = WebView(this@MainActivity)
                popupWebView.settings.javaScriptEnabled = true
                popupWebView.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView,
                        request: WebResourceRequest
                    ): Boolean {
                        val handled = handleRequestedUrl(request.url.toString())
                        try { view.destroy() } catch (_: Throwable) {}
                        return handled
                    }

                    @Suppress("DEPRECATION")
                    @Deprecated("Deprecated in Java")
                    override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                        val handled = handleRequestedUrl(url)
                        try { view?.destroy() } catch (_: Throwable) {}
                        return handled
                    }

                    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                        super.onPageStarted(view, url, favicon)
                        if (!url.isNullOrBlank()) {
                            handleRequestedUrl(url)
                            try { view?.stopLoading() } catch (_: Throwable) {}
                            try { view?.destroy() } catch (_: Throwable) {}
                        }
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
        val rawUrl = savedInstanceState?.getString("url") ?: getConfiguredAppEntryUrl()
        val withRev = buildAppUrl(rawUrl)
        wv.loadUrl(withRev)

        // Cold-start from a call notification: dismiss the system tray ring
        // now that the in-app ringing/connecting overlay will take over.
        if (intent?.getBooleanExtra("incoming_call", false) == true) {
            try {
                val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
                nm.cancel(CallService.RING_NOTIFICATION_ID)
                nm.cancel(CallService.NOTIFICATION_ID)
            } catch (_: Throwable) {}
            try {
                val stop = Intent(this, CallService::class.java).apply {
                    action = CallService.ACTION_DISMISS_RING
                }
                startService(stop)
            } catch (_: Throwable) {}
        }

        // Deep-link handling
        intent?.data?.let { uri ->
            if (isAppHost(uri.host ?: "") && isAppPath(uri.path)) {
                wv.loadUrl(uri.toString())
            } else if (shouldOpenExternally(uri)) {
                openExternalUri(uri)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        try {
            if (intent.getBooleanExtra("incoming_call", false) == true) {
                // Tap on the incoming-call notification body. The activity is
                // already running, so the live WS/RTCPeerConnection is what
                // delivers the offer to the in-app #incoming-call popup. We
                // intentionally do NOT reload the WebView here — doing so
                // would tear down the live socket + peer connection and
                // leave both ends stuck on "Calling…/Connecting…". The
                // system has already brought us to the foreground; that's
                // all that's needed.
                Log.i(TAG, "incoming-call body tap: bring-to-front only, no reload")
                // Clear the system tray ringing notification — redundant
                // once the in-app overlay takes over and just noisy.
                try {
                    val nm = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
                    nm.cancel(CallService.RING_NOTIFICATION_ID)
                    nm.cancel(CallService.NOTIFICATION_ID)
                } catch (_: Throwable) {}
                try {
                    val stop = Intent(this, CallService::class.java).apply {
                        action = CallService.ACTION_DISMISS_RING
                    }
                    startService(stop)
                } catch (_: Throwable) {}
            } else {
                // Warm tap on a message notification: don't reload the whole
                // page, just route the WebView to the right DM thread via JS.
                val dmNick = intent.getStringExtra("dm_nick").orEmpty()
                if (dmNick.isNotBlank()) {
                    val escaped = dmNick.replace("\\", "\\\\").replace("'", "\\'")
                    webView?.postDelayed({
                        webView?.evaluateJavascript(
                            "try{(window.openDMWithNick||(window.Rooms&&window.Rooms.openDM))" +
                            "&&(window.openDMWithNick?openDMWithNick('$escaped'):window.Rooms.openDM('$escaped'));}catch(e){}",
                            null
                        )
                    }, 150)
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "onNewIntent incoming-call reload failed", e)
        }
        try {
            if (intent.getBooleanExtra("open_music", false) == true) {
                // Notification body tap: route to the channel/source
                // currently playing. Music.expand() handles both rooms
                // and FrogSocial Music tab. Slight delay so we run
                // after onResume's notifyAppForeground.
                webView?.postDelayed({
                    webView?.evaluateJavascript(
                        "try{window.Music&&window.Music.expand&&window.Music.expand();}catch(e){}",
                        null
                    )
                }, 250)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "onNewIntent open_music failed", e)
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
                if (normalizeServerBaseUrl(getServerBaseUrl()) == null) {
                    ensureServerConfigured {
                        try {
                            if (webView != null) {
                                webView?.reload()
                            } else {
                                initWebView(null)
                                webViewInitialized = true
                            }
                        } catch (t: Throwable) {
                            Log.e(TAG, "Retry failed", t)
                            showErrorScreen("Retry failed:\n${t.message}")
                        }
                    }
                    return@setOnClickListener
                }
                try {
                    if (webView != null) {
                        webView?.reload()
                    } else {
                        initWebView(null)
                        webViewInitialized = true
                    }
                } catch (t: Throwable) {
                    Log.e(TAG, "Retry failed", t)
                    showErrorScreen("Retry failed:\n${t.message}")
                }
            }

            findViewById<View>(R.id.btn_open_browser)?.setOnClickListener {
                try {
                    val openUrl = try {
                        getConfiguredAppEntryUrl()
                    } catch (_: Throwable) {
                        APP_URL
                    }
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(openUrl)))
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
        isAppVisible = true
        try { webView?.onResume() } catch (_: Throwable) {}
        // Refresh the FCM token if it's been more than 6h since the last
        // server-side sync. Catches silent token rotations (Play Services
        // updates, GCM rotations, app data restored to a new device) that
        // would otherwise leave the server pushing to a dead token and
        // make calls miss for days until the user re-logged in.
        try { FcmBridge.syncCurrentTokenIfStale(this) } catch (_: Throwable) {}
        // Tell the JS side the app came back to the foreground. We can't
        // rely on visibilitychange here: when music is active we skip
        // webView.onPause() in onPause() to keep audio running, so the
        // WebView never thinks it was hidden and never fires the event.
        // Music.notifyAppForeground() reconciles _paused state, the side
        // play/pause button, the sync badge, and the system tray icon.
        try {
            webView?.post {
                webView?.evaluateJavascript(
                    "(function(){try{if(window.Music&&typeof window.Music.notifyAppForeground==='function')window.Music.notifyAppForeground();}catch(e){}})();",
                    null
                )
            }
        } catch (_: Throwable) {}
    }

    override fun onPause() {
        isAppVisible = false
        if (!musicPlaybackActive) {
            try { webView?.onPause() } catch (_: Throwable) {}
        } else {
            // WebView keeps running so audio survives, but the JS layer
            // still needs to know we went bg, otherwise the side
            // play/pause button stays stuck on Pause forever
            // (visibilitychange never fires while webView.onPause is
            // skipped). notifyAppBackground() flips _paused=true and
            // forces every UI surface (button, badge, tray) to Play.
            try {
                webView?.evaluateJavascript(
                    "(function(){try{if(window.Music&&typeof window.Music.notifyAppBackground==='function')window.Music.notifyAppBackground();}catch(e){}})();",
                    null
                )
            } catch (_: Throwable) {}
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

        // 10.5: let the privacy settings UI in the web app toggle the
        // OS-level screenshot blocker. Persists across launches via
        // SharedPreferences. Default is true (blocked).
        @android.webkit.JavascriptInterface
        fun setBlockScreenshots(enabled: Boolean) {
            try {
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean(PREF_BLOCK_SCREENSHOTS, enabled).apply()
                activity.runOnUiThread {
                    if (enabled) {
                        activity.window.setFlags(
                            WindowManager.LayoutParams.FLAG_SECURE,
                            WindowManager.LayoutParams.FLAG_SECURE
                        )
                    } else {
                        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                }
            } catch (e: Throwable) {
                Log.w(TAG, "setBlockScreenshots failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun getBlockScreenshots(): Boolean {
            return try {
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getBoolean(PREF_BLOCK_SCREENSHOTS, false)
            } catch (e: Throwable) {
                true
            }
        }

        @android.webkit.JavascriptInterface
        fun getServerBaseUrl(): String {
            return activity.getServerBaseUrl()
        }

        @android.webkit.JavascriptInterface
        fun setServerBaseUrl(url: String) {
            activity.setServerBaseUrlFromJs(url)
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
                activity.updateMusicPlayback(title, subtitle, null, null, active, playing, muted)
            } catch (e: Throwable) {
                Log.e(TAG, "updateMusicPlayback failed", e)
            }
        }

        // V2 adds artwork URL + provider so the foreground service can render
        // a MediaStyle notification with album art + brand-colored card. Old
        // APKs without this method gracefully fall back to the V1 path.
        @android.webkit.JavascriptInterface
        fun updateMusicPlaybackV2(title: String?, subtitle: String?,
                                  artworkUrl: String?, provider: String?,
                                  active: Boolean, playing: Boolean, muted: Boolean) {
            try {
                activity.updateMusicPlayback(title, subtitle, artworkUrl, provider,
                    active, playing, muted)
            } catch (e: Throwable) {
                Log.e(TAG, "updateMusicPlaybackV2 failed", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun stopMusicPlayback() {
            try {
                activity.updateMusicPlayback(null, null, null, null, false, false, false)
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
        // FCM is the single source of truth for tray notifications when
        // the app is backgrounded — see FrogTalkFirebaseMessagingService.
        // The JS bridge calls into here for the foreground path so the
        // user still gets a system notification while the WebView is
        // visible (on a different DM, etc). When the activity is paused
        // we skip — the FCM service has already posted (or will post)
        // the canonical heads-up, and posting from here too would
        // duplicate the alert when the message also arrived over the
        // open WS connection.
        if (!isAppVisible) return
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
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
            .setCategory(androidx.core.app.NotificationCompat.CATEGORY_SOCIAL)
            .setVisibility(androidx.core.app.NotificationCompat.VISIBILITY_PUBLIC)
            // No setDefaults: the frogtalk_general channel already supplies
            // sound + vibration. Stacking DEFAULT_ALL on top caused some OEMs
            // to play the alert tone while suppressing the heads-up/tray
            // entry (the foreground "beep but no notification" bug).
            .setOnlyAlertOnce(false)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
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
        artworkUrl: String?,
        provider: String?,
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
                putExtra(MusicService.EXTRA_ARTWORK_URL, artworkUrl ?: "")
                putExtra(MusicService.EXTRA_PROVIDER, provider ?: "")
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
                    "toggle_play" -> {
                        // YouTube's iframe in an offscreen WebView is blocked
                        // from resuming playback by Chromium's autoplay
                        // policy. For YouTube going paused→playing we
                        // bring the activity to the foreground (so the
                        // WebView is on-screen) and then call the JS
                        // resumeFromNotification() helper, which clears
                        // the paused flag and kicks the bounded retry
                        // ladder. MusicService skipped the optimistic
                        // currentPlaying flip for this case, so the
                        // notification stays on ▶ until JS pushes the
                        // truth (ACTION_UPDATE) once playback actually
                        // starts. SoundCloud + Spotify embeds genuinely
                        // play from background; they keep the cheap
                        // direct toggle path.
                        val provider = intent.getStringExtra(MusicService.EXTRA_PROVIDER) ?: ""
                        val targetPlaying = intent.getBooleanExtra(MusicService.EXTRA_PLAYING, true)
                        if (provider == "youtube" && targetPlaying) {
                            try {
                                val launch = Intent(this@MainActivity, MainActivity::class.java).apply {
                                    action = Intent.ACTION_MAIN
                                    addCategory(Intent.CATEGORY_LAUNCHER)
                                    addFlags(
                                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                                        Intent.FLAG_ACTIVITY_SINGLE_TOP
                                    )
                                }
                                startActivity(launch)
                            } catch (e: Throwable) {
                                Log.w(TAG, "bring-to-front for YT resume failed", e)
                            }
                            // Kick the JS resume helper after onResume
                            // has had a chance to run. 250ms is plenty
                            // for the WebView to be on-screen and for
                            // the YT iframe to be ready to honor a
                            // playVideo command.
                            webView?.postDelayed({
                                webView?.evaluateJavascript(
                                    "try{window.Music&&window.Music.resumeFromNotification&&window.Music.resumeFromNotification();}catch(e){}",
                                    null
                                )
                            }, 250)
                        } else {
                            webView?.post {
                                webView?.evaluateJavascript(
                                    "try{window.Music&&window.Music.togglePauseGlobal&&window.Music.togglePauseGlobal();}catch(e){}",
                                    null
                                )
                            }
                        }
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
