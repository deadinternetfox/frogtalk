//
//  NotificationRouter.swift
//  FrogTalk
//
//  UNUserNotificationCenterDelegate. Handles foreground presentation and
//  notification taps. Tap action carries `userInfo["url"]` (set by FCM payload
//  data field "url") which loads the corresponding deep URL in the webview.
//

import UIKit
import UserNotifications

final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {

    static let shared = NotificationRouter()

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler:
                                @escaping (UNNotificationPresentationOptions) -> Void) {
        if #available(iOS 14.0, *) {
            completionHandler([.banner, .list, .sound, .badge])
        } else {
            completionHandler([.alert, .sound, .badge])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let urlStr = info["url"] as? String, let url = URL(string: urlStr) {
            ViewController.shared?.loadRequestedURL(url)
        } else if let path = info["path"] as? String,
                  let url = URL(string: "https://frogtalk.xyz" + path) {
            ViewController.shared?.loadRequestedURL(url)
        }
        completionHandler()
    }
}
