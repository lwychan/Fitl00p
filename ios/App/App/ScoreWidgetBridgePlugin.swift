import Capacitor
import WidgetKit
import WatchConnectivity
import Foundation

// Bridges the dashboard's already-computed daily scores (recovery, sleep,
// strain, net calories — see computeRecoveryScore/computeSleepScore/
// computeStrainScore/renderNetCalories in app.js) into the shared App Group
// container, so the widget/complication extensions can read them without a
// second Swift implementation of the score math.
@objc(ScoreWidgetBridgePlugin)
public class ScoreWidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {
    public let identifier = "ScoreWidgetBridgePlugin"
    public let jsName = "ScoreWidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "writeScores", returnType: CAPPluginReturnPromise)
    ]

    static let appGroupId = "group.com.lwychan.fitl00p"
    static let scoresKey = "fitloop.todayScores"

    @objc override public func load() {
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    @objc func writeScores(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: Self.appGroupId) else {
            call.reject("App Group unavailable")
            return
        }

        var scores: [String: Any] = [
            "updatedAt": call.getString("updatedAt") ?? ISO8601DateFormatter().string(from: Date())
        ]
        if let v = call.getInt("recovery") { scores["recovery"] = v }
        if let v = call.getInt("sleep") { scores["sleep"] = v }
        // Strain is a real 0-21 scale with one decimal (e.g. 14.2), not an
        // integer — getInt would silently drop it.
        if let v = call.getDouble("strain") { scores["strain"] = v }
        if let v = call.getInt("netCaloriesKcal") { scores["netCaloriesKcal"] = v }
        if let v = call.getBool("netCaloriesIsDeficit") { scores["netCaloriesIsDeficit"] = v }
        if let v = call.getInt("steps") { scores["steps"] = v }
        if let v = call.getInt("stepsGoal") { scores["stepsGoal"] = v }
        if let v = call.getDouble("sleepHours") { scores["sleepHours"] = v }
        if let v = call.getDouble("sleepNeedHours") { scores["sleepNeedHours"] = v }
        if let v = call.getInt("nutritionScore") { scores["nutritionScore"] = v }

        if let data = try? JSONSerialization.data(withJSONObject: scores) {
            defaults.set(data, forKey: Self.scoresKey)
        }

        // Mirror to a paired Watch, if any — App Groups don't sync across
        // devices on their own, WatchConnectivity's application context is
        // the transport FitLoopWatch's WatchDelegate receives this through.
        let session = WCSession.default
        if WCSession.isSupported() && session.activationState == .activated
            && session.isPaired && session.isWatchAppInstalled {
            try? session.updateApplicationContext(scores)
        }

        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    // Required by WCSessionDelegate on iOS — nothing to do for this
    // one-way score push beyond satisfying the protocol.
    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
