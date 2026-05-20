//
//  CallManager.swift
//  FrogTalk
//
//  CallKit integration. Replaces android/CallService.kt + CallDeclineReceiver.kt.
//
//  - Outgoing calls: web app → bridge → CXStartCallAction → CallKit screen.
//  - Incoming calls: PushKit VoIP push → reportNewIncomingCall (synchronous!) →
//    CallKit ring UI. User answer/decline routed via CXProviderDelegate.
//

import Foundation
import CallKit
import AVFoundation

/// Mirrors `routers/calls.py::DeclineCallRequest`.
struct PendingIncomingCall {
    let uuid: UUID
    let callId: String?      // server-side numeric id
    let peerNick: String?
    let isVideo: Bool
}

final class CallManager: NSObject {

    static let shared = CallManager()

    private(set) var provider: CXProvider!
    private let callController = CXCallController()
    private var current: PendingIncomingCall?

    /// Called from AppDelegate.didFinishLaunching — must run before the first
    /// VoIP push arrives or iOS will permanently suspend the process.
    func bootstrap() {
        let cfg = CXProviderConfiguration(localizedName: "FrogTalk")
        cfg.supportsVideo = true
        cfg.maximumCallsPerCallGroup = 1
        cfg.maximumCallGroups = 1
        cfg.supportedHandleTypes = [.generic]
        cfg.includesCallsInRecents = true
        if let img = UIImage(named: "AppIcon") {
            cfg.iconTemplateImageData = img.pngData()
        }

        self.provider = CXProvider(configuration: cfg)
        self.provider.setDelegate(self, queue: nil)
    }

    // MARK: - Incoming (called from PushHandler when a VoIP push arrives)
    /// Synchronously reports a new incoming call to CallKit. PushKit requires
    /// this to be called inline in the VoIP push handler.
    func reportIncomingCall(callId: String?,
                            peerNick: String?,
                            isVideo: Bool,
                            completion: @escaping (Error?) -> Void) {
        let uuid = UUID()
        current = PendingIncomingCall(uuid: uuid, callId: callId, peerNick: peerNick, isVideo: isVideo)

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: peerNick ?? "FrogTalk")
        update.localizedCallerName = peerNick
        update.hasVideo = isVideo
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        provider.reportNewIncomingCall(with: uuid, update: update, completion: completion)
    }

    // MARK: - Outgoing
    func startOutgoingCall(peerNick: String) {
        let uuid = UUID()
        let handle = CXHandle(type: .generic, value: peerNick)
        let action = CXStartCallAction(call: uuid, handle: handle)
        action.isVideo = false
        callController.request(CXTransaction(action: action)) { err in
            if let e = err { NSLog("[FrogTalk] startCall failed: %@", String(describing: e)) }
        }
    }

    func endActiveCall() {
        guard let cur = current else { return }
        let action = CXEndCallAction(call: cur.uuid)
        callController.request(CXTransaction(action: action)) { _ in }
        current = nil
    }

    func dismissIncomingCall() {
        endActiveCall()
    }
}

// MARK: - CXProviderDelegate
extension CallManager: CXProviderDelegate {

    func providerDidReset(_ provider: CXProvider) {
        current = nil
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        // User tapped Accept on the CallKit screen. Tell the web app to wire up
        // the WebRTC accept flow.
        let cur = current
        ViewController.shared?.presentIncomingCall(
            callId: cur?.callId,
            peerNick: cur?.peerNick,
            action: "answer"
        )
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        // User tapped Decline / End. POST /api/calls/decline mirrors the
        // Android FcmBridge.declineCall path so the peer's call_reject and
        // the callee-side call_handled events both fire.
        let cur = current
        current = nil
        if let cid = cur?.callId, !cid.isEmpty {
            PushHandler.shared.declineCall(callId: cid, peerNick: cur?.peerNick)
        } else if let nick = cur?.peerNick, !nick.isEmpty {
            PushHandler.shared.declineCall(callId: nil, peerNick: nick)
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        AudioSessionController.shared.activateForCall()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        AudioSessionController.shared.deactivate()
    }
}
