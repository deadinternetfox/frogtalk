//
//  NativeBridge.swift
//  FrogTalk
//
//  WKScriptMessageHandler that mirrors the Android `window.Android` JS bridge.
//
//  An injected user-script polyfills `window.Android.*` so the existing JS in
//  static/js/calls.js, static/js/notifications.js, static/js/music.js, etc.
//  works on iOS unchanged. Each Android method becomes a postMessage to a
//  single message handler named `frogtalk`, dispatched here by `fn` name.
//

import UIKit
import WebKit
import AVFoundation
import UserNotifications
import AudioToolbox

final class NativeBridge: NSObject, WKScriptMessageHandler {

    static let shared = NativeBridge()
    static let handlerName = "frogtalk"

    weak var viewController: ViewController?

    /// User-script source. Defines `window.Android` and mirrors every method
    /// the Android wrapper exposes (see CallBridge in MainActivity.kt). All
    /// methods funnel into a single postMessage so adding new bridge fns is
    /// a one-liner here + matching case in `userContentController(...)`.
    static func injectedJavaScript() -> String {
        return """
        (function () {
          if (window.Android && window.Android.__frogtalkIosShim) return;
          var send = function (fn, args) {
            try {
              window.webkit.messageHandlers.\(NativeBridge.handlerName).postMessage({
                fn: fn, args: args || {}
              });
            } catch (e) { /* bridge missing, no-op */ }
          };
          var ios = {
            __frogtalkIosShim: true,
            startCallNotification: function (peerNick) { send('startCallNotification', {peerNick: peerNick}); },
            endCallNotification: function () { send('endCallNotification'); },
            ringForCall: function (peerNick, callId) { send('ringForCall', {peerNick: peerNick, callId: callId}); },
            dismissRing: function () { send('dismissRing'); },
            showNotification: function (title, body) { send('showNotification', {title: title, body: body}); },
            updateStoryUploadNotification: function (percent, status) { send('updateStoryUploadNotification', {percent: percent, status: status}); },
            finishStoryUploadNotification: function (success, message) { send('finishStoryUploadNotification', {success: !!success, message: message}); },
            stopMusicPlayback: function () { send('stopMusicPlayback'); },
            registerFcmToken: function (sessionToken) { send('registerFcmToken', {sessionToken: sessionToken}); },
            vibrate: function (ms) { send('vibrate', {ms: ms}); },
            playNotificationTone: function () { send('playNotificationTone'); },
            setBlockScreenshots: function (on) { send('setBlockScreenshots', {on: !!on}); },
            getServerBaseUrl: function () { return ''; },
            setServerBaseUrl: function (url) { send('setServerBaseUrl', {url: url}); },
            isInForeground: function () { return true; }
          };
          window.Android = ios;
          // Optional: also expose under window.FrogTalkBridge so future JS can
          // be platform-aware without sniffing window.Android.
          window.FrogTalkBridge = ios;
        })();
        """
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == NativeBridge.handlerName,
              let body = message.body as? [String: Any],
              let fn = body["fn"] as? String else { return }
        let args = (body["args"] as? [String: Any]) ?? [:]
        DispatchQueue.main.async { self.dispatch(fn: fn, args: args) }
    }

    private func dispatch(fn: String, args: [String: Any]) {
        switch fn {
        case "startCallNotification":
            let nick = args["peerNick"] as? String ?? ""
            CallManager.shared.startOutgoingCall(peerNick: nick)

        case "endCallNotification":
            CallManager.shared.endActiveCall()

        case "ringForCall":
            // The web app calls this to indicate it is ringing; CallKit ringing
            // is normally driven by VoIP push. This call is a no-op on iOS but
            // we keep it for parity (also used as a heartbeat).
            break

        case "dismissRing":
            CallManager.shared.dismissIncomingCall()

        case "showNotification":
            let title = args["title"] as? String ?? "FrogTalk"
            let body  = args["body"] as? String ?? ""
            postLocalNotification(title: title, body: body)

        case "updateStoryUploadNotification":
            let percent = (args["percent"] as? NSNumber)?.intValue ?? 0
            let status  = args["status"] as? String
            postProgressNotification(percent: percent, status: status, finished: false, success: nil)

        case "finishStoryUploadNotification":
            let success = (args["success"] as? Bool) ?? true
            let message = args["message"] as? String
            postProgressNotification(percent: 100, status: message, finished: true, success: success)

        case "stopMusicPlayback":
            AudioSessionController.shared.deactivate()

        case "registerFcmToken":
            let session = args["sessionToken"] as? String ?? ""
            PushHandler.shared.rememberSessionToken(session)
            PushHandler.shared.uploadCurrentTokens()

        case "vibrate":
            let ms = (args["ms"] as? NSNumber)?.doubleValue ?? 30
            performHaptic(ms: ms)

        case "playNotificationTone":
            AudioServicesPlaySystemSound(1007) // SMS-style chirp

        case "setTorch":
            let on = (args["on"] as? Bool) ?? false
            setTorch(on: on)

        case "setServerBaseUrl":
            let url = args["url"] as? String ?? ""
            viewController?.setServerBaseUrlFromJs(url)

        default:
            NSLog("[FrogTalk] Unknown bridge fn: %@", fn)
        }
    }

    // MARK: - Helpers

    private func postLocalNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(
            identifier: "ft-local-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }

    private func postProgressNotification(percent: Int, status: String?, finished: Bool, success: Bool?) {
        let content = UNMutableNotificationContent()
        if finished {
            content.title = (success ?? true) ? "Upload complete" : "Upload failed"
            content.body  = status ?? ""
        } else {
            content.title = "Uploading…"
            content.body  = (status ?? "") + " (\(percent)%)"
        }
        content.sound = nil
        let req = UNNotificationRequest(
            identifier: "ft-story-upload",   // stable id replaces previous progress
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(req)
    }

    private func performHaptic(ms: Double) {
        let style: UIImpactFeedbackGenerator.FeedbackStyle = {
            if ms >= 100 { return .heavy }
            if ms >= 30  { return .medium }
            return .light
        }()
        let gen = UIImpactFeedbackGenerator(style: style)
        gen.prepare()
        gen.impactOccurred()
    }

    private func setTorch(on: Bool) {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return }
        do {
            try device.lockForConfiguration()
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        } catch {
            NSLog("[FrogTalk] torch failed: %@", String(describing: error))
        }
    }
}
