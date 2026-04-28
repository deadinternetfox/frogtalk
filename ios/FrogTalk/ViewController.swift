//
//  ViewController.swift
//  FrogTalk
//
//  WKWebView host. Mirrors Android MainActivity.kt: builds the app URL,
//  installs the JS bridge, handles file uploads, permission requests,
//  external-link routing, deep links, and incoming-call handoff.
//

import UIKit
import WebKit
import AVFoundation
import PhotosUI

final class ViewController: UIViewController {

    // ── Configuration ────────────────────────────────────────────────────────
    private let APP_URL  = "https://frogtalk.xyz/app"
    private let WEB_HOST = "frogtalk.xyz"
    private let WEB_CACHE_REV = "20260428-ios-shell-v1"

    // ── State ────────────────────────────────────────────────────────────────
    static weak var shared: ViewController?
    private(set) var webView: WKWebView!
    private var loadingView: UIView?
    private var fileChooserCompletion: (([URL]?) -> Void)?
    var pendingDeepLink: URL?

    // ── Lifecycle ────────────────────────────────────────────────────────────
    override func viewDidLoad() {
        super.viewDidLoad()
        Self.shared = self

        view.backgroundColor = UIColor(red: 0.05, green: 0.07, blue: 0.09, alpha: 1.0) // #0d1117

        installWebView()
        installLoadingScreen()
        loadInitialURL()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // ── WebView setup ────────────────────────────────────────────────────────
    private func installWebView() {
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        prefs.preferredContentMode = .mobile

        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences = prefs
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.processPool = WKProcessPool()
        if #available(iOS 14.0, *) {
            config.upgradeKnownHostsToHTTPS = true
        }

        // Persistent cookie/storage so the user stays logged in across launches.
        let store = WKWebsiteDataStore.default()
        config.websiteDataStore = store

        // Inject the window.Android polyfill at document start so existing JS in
        // static/js/calls.js, notifications.js, etc. works unchanged.
        let userScript = WKUserScript(
            source: NativeBridge.injectedJavaScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        let userController = WKUserContentController()
        userController.addUserScript(userScript)

        // The single message handler that all JS bridge calls funnel into.
        let bridge = NativeBridge.shared
        bridge.viewController = self
        userController.add(bridge, name: NativeBridge.handlerName)
        config.userContentController = userController

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.scrollView.bounces = true
        wv.scrollView.contentInsetAdjustmentBehavior = .always
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.customUserAgent = (wv.value(forKey: "userAgent") as? String ?? "") + " FrogTalkiOS/1.4.7"

        view.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: view.topAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        webView = wv
    }

    private func installLoadingScreen() {
        let v = UIView(frame: view.bounds)
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        v.backgroundColor = view.backgroundColor

        let label = UILabel()
        label.text = "🐸 FrogTalk"
        label.textColor = .white
        label.font = .systemFont(ofSize: 30, weight: .semibold)
        label.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: v.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: v.centerYAnchor),
        ])

        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        v.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: v.centerXAnchor),
            spinner.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 24),
        ])

        view.addSubview(v)
        loadingView = v
    }

    private func hideLoadingScreen() {
        UIView.animate(withDuration: 0.25,
                       animations: { self.loadingView?.alpha = 0 },
                       completion: { _ in self.loadingView?.removeFromSuperview() })
    }

    // ── URL handling ─────────────────────────────────────────────────────────
    private func loadInitialURL() {
        let url: URL = {
            if let dl = pendingDeepLink, isFrogTalkURL(dl) { return dl }
            return URL(string: buildAppURL())!
        }()
        webView.load(URLRequest(url: url))
    }

    private func buildAppURL(extraQuery: [String: String] = [:]) -> String {
        var comps = URLComponents(string: APP_URL)!
        var items = [
            URLQueryItem(name: "mobile", value: "ios"),
            URLQueryItem(name: "rev", value: WEB_CACHE_REV),
        ]
        for (k, v) in extraQuery { items.append(URLQueryItem(name: k, value: v)) }
        comps.queryItems = items
        return comps.string ?? APP_URL
    }

    /// Open a Universal-Link URL in the embedded webview if it belongs to us.
    func loadRequestedURL(_ url: URL) {
        guard isFrogTalkURL(url) else {
            UIApplication.shared.open(url)
            return
        }
        webView.load(URLRequest(url: url))
    }

    /// Called by CallManager when the user taps Accept on a CallKit screen.
    /// Loads the app with `?incoming_call=1&call_id=&peer_nick=&action=answer`.
    func presentIncomingCall(callId: String?, peerNick: String?, action: String) {
        var extra: [String: String] = ["incoming_call": "1", "action": action]
        if let cid = callId, !cid.isEmpty { extra["call_id"] = cid }
        if let nick = peerNick, !nick.isEmpty { extra["peer_nick"] = nick }
        let url = URL(string: buildAppURL(extraQuery: extra))!
        webView.load(URLRequest(url: url))
    }

    private func isFrogTalkURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == WEB_HOST || host.hasSuffix(".\(WEB_HOST)")
    }
}

// MARK: - WKNavigationDelegate
extension ViewController: WKNavigationDelegate {

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow); return
        }

        // Allow navigation inside frogtalk.xyz; route everything else to Safari.
        if isFrogTalkURL(url) || url.scheme == "about" || url.scheme == "data" {
            decisionHandler(.allow); return
        }
        if url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
            decisionHandler(.cancel); return
        }
        // Custom schemes (mailto:, tel:, frogtalk:, etc.)
        if UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hideLoadingScreen()
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        let nse = error as NSError
        if nse.domain == NSURLErrorDomain && nse.code == NSURLErrorCancelled { return }
        showError(message: nse.localizedDescription)
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        let nse = error as NSError
        if nse.domain == NSURLErrorDomain && nse.code == NSURLErrorCancelled { return }
        showError(message: nse.localizedDescription)
    }

    private func showError(message: String) {
        loadingView?.isHidden = false
        loadingView?.subviews.compactMap { $0 as? UILabel }.first?.text = "⚠️ \(message)"
    }
}

// MARK: - WKUIDelegate (file uploads, permissions, alerts)
extension ViewController: WKUIDelegate {

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard origin.host.lowercased().hasSuffix(WEB_HOST) else {
            decisionHandler(.deny); return
        }
        decisionHandler(.grant)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}
