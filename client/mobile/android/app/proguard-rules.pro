# Keep WebView JavaScript interface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep permission request handling
-keep class android.webkit.PermissionRequest { *; }
-keep class android.webkit.WebChromeClient { *; }

# Keep Kotlin coroutines
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}

# Keep Material Components
-keep class com.google.android.material.** { *; }

# Keep WebRTC (org.webrtc) — JNI-bound native bridge for the screen-share peer.
# Release isn't minified today, but this future-proofs the JNI symbol names.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# OkHttp (screen-share signaling WebSocket)
-dontwarn okhttp3.**
-dontwarn okio.**

# Strip logging in release
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
}
