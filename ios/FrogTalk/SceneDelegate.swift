//
//  SceneDelegate.swift
//  FrogTalk
//

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = (scene as? UIWindowScene) else { return }
        let win = UIWindow(windowScene: windowScene)
        let root = ViewController()
        win.rootViewController = root
        win.makeKeyAndVisible()
        window = win

        // Universal Link launch
        if let activity = connectionOptions.userActivities.first,
           activity.activityType == NSUserActivityTypeBrowsingWeb,
           let url = activity.webpageURL {
            root.pendingDeepLink = url
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL else { return }
        ViewController.shared?.loadRequestedURL(url)
    }
}
