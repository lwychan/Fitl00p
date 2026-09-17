import Capacitor
import WidgetKit
import Foundation

// Bridges the dashboard's already-computed daily scores (recovery, sleep,
// strain, net calories — see computeRecoveryScore/computeSleepScore/
// computeStrainScore/renderNetCalories in app.js) into the shared App Group
// container, so the widget/complication extensions can read them without a
// second Swift implementation of the score math. Writing here is inert
// (nothing to reload) until FitLoopWidgets exists as a target.
@objc(ScoreWidgetBridgePlugin)
public class ScoreWidgetBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScoreWidgetBridgePlugin"
    public let jsName = "ScoreWidgetBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "writeScores", returnType: CAPPluginReturnPromise)
    ]

    static let appGroupId = "group.com.lwychan.fitl00p"
    static let scoresKey = "fitloop.todayScores"

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
        if let v = call.getInt("strain") { scores["strain"] = v }
        if let v = call.getInt("netCaloriesKcal") { scores["netCaloriesKcal"] = v }
        if let v = call.getBool("netCaloriesIsDeficit") { scores["netCaloriesIsDeficit"] = v }
        if let v = call.getInt("steps") { scores["steps"] = v }

        if let data = try? JSONSerialization.data(withJSONObject: scores) {
            defaults.set(data, forKey: Self.scoresKey)
        }

        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}
