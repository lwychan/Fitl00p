import SwiftUI
import WatchConnectivity
import WidgetKit

@main
struct FitLoopWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchDelegate.self) var delegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

// Receives the phone's pushed scores via WatchConnectivity and mirrors
// them into the watch's own local App Group container, so
// FitLoopWatchWidgets' complications can read the same JSON shape
// ScoreWidgetBridgePlugin writes on the phone side — App Groups don't
// sync across devices, WatchConnectivity is the transport between them.
class WatchDelegate: NSObject, WKApplicationDelegate, WCSessionDelegate {
    func applicationDidFinishLaunching() {
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        if !context.isEmpty { saveContext(context) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        saveContext(applicationContext)
    }

    private func saveContext(_ context: [String: Any]) {
        guard let defaults = UserDefaults(suiteName: "group.com.lwychan.fitl00p"),
              let data = try? JSONSerialization.data(withJSONObject: context) else { return }
        defaults.set(data, forKey: "fitloop.todayScores")
        WidgetCenter.shared.reloadAllTimelines()
        // WCSessionDelegate callbacks can arrive off the main thread; the
        // notification drives a SwiftUI @State update in ContentView, which
        // needs to happen on main.
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .fitLoopScoresUpdated, object: nil)
        }
    }
}

extension Notification.Name {
    static let fitLoopScoresUpdated = Notification.Name("fitLoopScoresUpdated")
}
