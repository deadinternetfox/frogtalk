//
//  PushHandler.swift
//  FrogTalk
//
//  Push registration. Mirrors:
//  - android/.../FrogTalkFirebaseMessagingService.kt (FCM token upload + decline)
//  - PushKit VoIP path (no Android equivalent — Android uses high-priority FCM).
//
//  iOS uses two separate push channels:
//
//    1. Regular APNs alerts via Firebase Cloud Messaging (re-uses the existing
//       Firebase project — add an iOS app in the console). Uploaded with
//       platform="ios" so the backend can target it.
//    2. PushKit VoIP pushes for cold-launch incoming-call ringing. Uploaded
//       with platform="ios_voip"; backend sends through APNs HTTP/2 with
//       `apns-push-type: voip` and topic xyz.frogtalk.app.voip.
//

import Foundation
import UIKit
import PushKit
import UserNotifications
#if canImport(FirebaseCore)
import FirebaseCore
import FirebaseMessaging
#endif

final class PushHandler: NSObject {

    static let shared = PushHandler()

    private var voipRegistry: PKPushRegistry?
    private var sessionToken: String?
    private var lastFcmToken: String?
    private var lastVoipToken: String?

    /// Persists the web session token so we can authenticate token-upload and
    /// decline-call calls. Stored in the keychain (sane default; not currently
    /// implemented — using UserDefaults for now, mirrors Android SharedPrefs).
    func rememberSessionToken(_ token: String) {
        guard !token.isEmpty else { return }
        sessionToken = token
        UserDefaults.standard.set(token, forKey: "ft_session_token")
    }

    private func currentSessionToken() -> String? {
        if let t = sessionToken, !t.isEmpty { return t }
        let t = UserDefaults.standard.string(forKey: "ft_session_token")
        sessionToken = t
        return t
    }

    func bootstrap(application: UIApplication) {
        // Ask for alert/sound/badge permission. Without this iOS still delivers
        // VoIP pushes (those don't need user consent) but suppresses banners.
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, err in
            NSLog("[FrogTalk] notif perm granted=%d err=%@", granted, String(describing: err))
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }

        // Register for VoIP pushes (separate token from regular APNs).
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.voipRegistry = registry

        // Hook FCM if Firebase is linked into the build (SPM).
        #if canImport(FirebaseCore)
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()
        }
        Messaging.messaging().delegate = self
        #endif
    }

    /// Forward APNs token to FCM so it can mint its own token.
    func handleAPNsToken(_ data: Data) {
        #if canImport(FirebaseCore)
        Messaging.messaging().apnsToken = data
        #endif
    }

    // MARK: - Token upload to backend
    /// POST /api/push/register — mirrors FcmBridge.kt registerToken().
    /// platform: "ios" for FCM-delivered pushes, "ios_voip" for PushKit.
    private func uploadToken(_ token: String, platform: String) {
        guard let session = currentSessionToken(), !session.isEmpty else {
            NSLog("[FrogTalk] uploadToken skipped: no session token yet")
            return
        }
        guard var comps = URLComponents(string: "https://frogtalk.xyz/api/push/fcm-subscribe") else { return }
        comps.queryItems = []
        guard let url = comps.url else { return }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(session, forHTTPHeaderField: "X-Session-Token")
        let body: [String: Any] = ["token": token, "platform": platform]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: req) { _, resp, err in
            if let e = err {
                NSLog("[FrogTalk] uploadToken err: %@", String(describing: e))
            } else if let r = resp as? HTTPURLResponse {
                NSLog("[FrogTalk] uploadToken %@ → %d", platform, r.statusCode)
            }
        }.resume()
    }

    /// Re-uploads whichever tokens we have cached. Called whenever the web app
    /// hands us a fresh session token (registerFcmToken bridge call).
    func uploadCurrentTokens() {
        if let t = lastFcmToken { uploadToken(t, platform: "ios") }
        if let t = lastVoipToken { uploadToken(t, platform: "ios_voip") }
    }

    // MARK: - Decline (mirrors FcmBridge.kt declineCall)
    func declineCall(callId: String?, peerNick: String?) {
        guard let session = currentSessionToken() else { return }
        guard let url = URL(string: "https://frogtalk.xyz/api/calls/decline") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(session, forHTTPHeaderField: "X-Session-Token")
        var body: [String: Any] = [:]
        if let c = callId { body["call_id"] = c }
        if let n = peerNick { body["peer_nick"] = n }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { _, _, err in
            if let e = err {
                NSLog("[FrogTalk] declineCall err: %@", String(describing: e))
            }
        }.resume()
    }
}

// MARK: - PushKit (VoIP)
extension PushHandler: PKPushRegistryDelegate {

    func pushRegistry(_ registry: PKPushRegistry,
                      didUpdate pushCredentials: PKPushCredentials,
                      for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        lastVoipToken = token
        NSLog("[FrogTalk] VoIP token: %@", token)
        uploadToken(token, platform: "ios_voip")
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didInvalidatePushTokenFor type: PKPushType) {
        if type == .voIP { lastVoipToken = nil }
    }

    /// MUST call CallKit reportNewIncomingCall synchronously before completion,
    /// otherwise iOS terminates the app and disables VoIP pushes for it.
    func pushRegistry(_ registry: PKPushRegistry,
                      didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType,
                      completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }

        let dict = payload.dictionaryPayload
        let callId   = (dict["call_id"]   as? String) ?? (dict["callId"] as? String)
        let peerNick = (dict["peer_nick"] as? String) ?? (dict["peerNick"] as? String)
                        ?? (dict["caller"] as? String)
        let isVideo  = (dict["is_video"]  as? Bool) ?? false

        CallManager.shared.reportIncomingCall(
            callId: callId, peerNick: peerNick, isVideo: isVideo
        ) { err in
            if let e = err {
                NSLog("[FrogTalk] reportNewIncomingCall failed: %@", String(describing: e))
            }
            completion()
        }
    }
}

// MARK: - FCM
#if canImport(FirebaseCore)
extension PushHandler: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let token = fcmToken else { return }
        lastFcmToken = token
        NSLog("[FrogTalk] FCM token: %@", token)
        uploadToken(token, platform: "ios")
    }
}
#endif
