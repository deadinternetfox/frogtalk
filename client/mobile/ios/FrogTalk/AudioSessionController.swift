//
//  AudioSessionController.swift
//  FrogTalk
//
//  Centralised AVAudioSession management. CallKit drives activation for calls;
//  the JS bridge can deactivate (stopMusicPlayback) when the web music player
//  is paused/closed.
//

import Foundation
import AVFoundation

final class AudioSessionController {

    static let shared = AudioSessionController()

    func activateForCall() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord,
                                    mode: .voiceChat,
                                    options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
            try session.setActive(true, options: [])
        } catch {
            NSLog("[FrogTalk] audio activate failed: %@", String(describing: error))
        }
    }

    func deactivate() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            NSLog("[FrogTalk] audio deactivate failed: %@", String(describing: error))
        }
    }
}
