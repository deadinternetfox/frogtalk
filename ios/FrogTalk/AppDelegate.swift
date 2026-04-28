//
//  AppDelegate.swift
//  FrogTalk
//
//  Mirrors android/app/src/main/java/xyz/frogtalk/app/MainActivity.kt onCreate() +
//  FrogTalkFirebaseMessagingService.kt — owns app lifecycle, push registration,
//  CallKit/PushKit handoff.
//

import UIKit
import UserNotifications
import PushKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    /// Shared CallKit-backed call manager. PushKit pushes route here.
    let callManager = CallManager.shared

    /// Push notification + APNs/FCM controller.
    let pushHandler = PushHandler.shared

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {

        // CallKit must be initialised before the first VoIP push lands; otherwise
        // iOS will permanently suspend the process.
        callManager.bootstrap()

        // Register for both regular APNs alerts (FCM) and VoIP pushes (PushKit).
        pushHandler.bootstrap(application: application)

        // UNUserNotificationCenter delegate so foreground notifications still
        // present + tap actions route into the webview.
        UNUserNotificationCenter.current().delegate = NotificationRouter.shared

        return true
    }

    // MARK: - APNs token (regular alerts; FCM also taps in via its own callback).
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        pushHandler.handleAPNsToken(deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[FrogTalk] APNs register failed: %@", String(describing: error))
    }

    // MARK: - Universal Links (https://frogtalk.xyz/...) → reload webview.
    func application(_ application: UIApplication,
                     continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = userActivity.webpageURL {
            ViewController.shared?.loadRequestedURL(url)
            return true
        }
        return false
    }

    // MARK: - UISceneSession lifecycle.
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration",
                                    sessionRole: connectingSceneSession.role)
    }
}
