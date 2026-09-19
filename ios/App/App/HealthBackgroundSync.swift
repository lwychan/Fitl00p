import Foundation
import HealthKit
import Capacitor

// Background Health delivery. HealthKit wakes the app (even when it isn't
// running) when new samples of an observed type arrive; there's no web
// view in that wake, so this reads the last few days of daily totals
// natively and uploads them to the health-ingest edge function using a
// per-user ingest token the web app hands over via configure().
//
// Covers the metrics that are simple daily sums/averages. Sleep, workouts
// and weight are still handled by the foreground sync in app.js (sleep
// needs session stitching, weight respects the manual-logging setting).
final class HealthBackgroundSync {
    static let shared = HealthBackgroundSync()

    private let store = HKHealthStore()
    private let defaults = UserDefaults.standard
    private var started = false

    private enum Key {
        static let enabled = "hkbg.enabled"
        static let userId = "hkbg.userId"
        static let token = "hkbg.token"
        static let url = "hkbg.url"
        static let anonKey = "hkbg.anonKey"
    }

    private struct Metric {
        let id: HKQuantityTypeIdentifier
        let column: String
        let unit: HKUnit
        let option: HKStatisticsOptions
        let scale: Double
    }

    private let metrics: [Metric] = [
        Metric(id: .stepCount, column: "steps", unit: .count(), option: .cumulativeSum, scale: 1),
        Metric(id: .distanceWalkingRunning, column: "distance_km", unit: .meter(), option: .cumulativeSum, scale: 0.001),
        Metric(id: .activeEnergyBurned, column: "active_energy_kcal", unit: .kilocalorie(), option: .cumulativeSum, scale: 1),
        Metric(id: .basalEnergyBurned, column: "resting_energy_kcal", unit: .kilocalorie(), option: .cumulativeSum, scale: 1),
        Metric(id: .appleExerciseTime, column: "exercise_mins", unit: .minute(), option: .cumulativeSum, scale: 1),
        Metric(id: .heartRate, column: "heart_rate_avg", unit: HKUnit.count().unitDivided(by: .minute()), option: .discreteAverage, scale: 1),
        Metric(id: .restingHeartRate, column: "resting_hr", unit: HKUnit.count().unitDivided(by: .minute()), option: .discreteAverage, scale: 1),
        Metric(id: .heartRateVariabilitySDNN, column: "hrv_ms", unit: .secondUnit(with: .milli), option: .discreteAverage, scale: 1),
    ]

    var isEnabled: Bool { defaults.bool(forKey: Key.enabled) }

    // Called from the web app whenever the built-in Health sync is on and
    // a user is signed in.
    func configure(userId: String, token: String, url: String, anonKey: String) {
        defaults.set(userId, forKey: Key.userId)
        defaults.set(token, forKey: Key.token)
        defaults.set(url, forKey: Key.url)
        defaults.set(anonKey, forKey: Key.anonKey)
        defaults.set(true, forKey: Key.enabled)
        start()
    }

    func disable() {
        defaults.set(false, forKey: Key.enabled)
        for k in [Key.userId, Key.token] { defaults.removeObject(forKey: k) }
    }

    // Must run on every launch (AppDelegate) — HealthKit only delivers to
    // observer queries registered in the current process, including when
    // it launches the app in the background.
    func start() {
        guard isEnabled, !started, HKHealthStore.isHealthDataAvailable() else { return }
        started = true
        for m in metrics {
            guard let type = HKObjectType.quantityType(forIdentifier: m.id) else { continue }
            let observer = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                guard let self = self, error == nil, self.isEnabled else { completion(); return }
                self.syncRecentDays { completion() }
            }
            store.execute(observer)
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }

    // Debounces the burst of observer callbacks (one per type) that
    // arrive together into a single upload.
    private var syncing = false
    private func syncRecentDays(_ done: @escaping () -> Void) {
        if syncing { done(); return }
        syncing = true

        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        guard let start = calendar.date(byAdding: .day, value: -2, to: today) else { syncing = false; done(); return }
        let interval = DateComponents(day: 1)

        var byDay: [String: [String: Double]] = [:]
        let fmt = DateFormatter()
        fmt.calendar = calendar
        fmt.timeZone = calendar.timeZone
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"

        let group = DispatchGroup()
        let lock = NSLock()
        for m in metrics {
            guard let type = HKObjectType.quantityType(forIdentifier: m.id) else { continue }
            group.enter()
            let q = HKStatisticsCollectionQuery(
                quantityType: type, quantitySamplePredicate: nil,
                options: m.option, anchorDate: today, intervalComponents: interval)
            q.initialResultsHandler = { _, results, _ in
                results?.enumerateStatistics(from: start, to: Date()) { stat, _ in
                    let raw = m.option == .cumulativeSum ? stat.sumQuantity() : stat.averageQuantity()
                    guard let quantity = raw else { return }
                    let value = quantity.doubleValue(for: m.unit) * m.scale
                    let day = fmt.string(from: stat.startDate)
                    lock.lock(); byDay[day, default: [:]][m.column] = (value * 100).rounded() / 100; lock.unlock()
                }
                group.leave()
            }
            store.execute(q)
        }

        group.notify(queue: .global()) { [weak self] in
            guard let self = self else { done(); return }
            let rows = byDay.map { day, cols -> [String: Any] in
                var row: [String: Any] = cols
                row["log_date"] = day
                // steps/exercise_mins are integer columns
                for k in ["steps", "exercise_mins"] { if let v = cols[k] { row[k] = Int(v.rounded()) } }
                return row
            }
            self.upload(rows: rows) {
                self.syncing = false
                done()
            }
        }
    }

    private func upload(rows: [[String: Any]], done: @escaping () -> Void) {
        guard !rows.isEmpty,
              let userId = defaults.string(forKey: Key.userId),
              let token = defaults.string(forKey: Key.token),
              let base = defaults.string(forKey: Key.url),
              let anon = defaults.string(forKey: Key.anonKey),
              let url = URL(string: base + "/functions/v1/health-ingest"),
              let body = try? JSONSerialization.data(withJSONObject: ["userId": userId, "rows": rows])
        else { done(); return }

        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + anon, forHTTPHeaderField: "Authorization")
        req.setValue(anon, forHTTPHeaderField: "apikey")
        req.setValue(token, forHTTPHeaderField: "X-Ingest-Token")

        let status = { (code: Int) in
            self.defaults.set("\(ISO8601DateFormatter().string(from: Date())) status=\(code) rows=\(rows.count)", forKey: "hkbg.lastUpload")
        }
        URLSession.shared.dataTask(with: req) { _, response, error in
            if let http = response as? HTTPURLResponse {
                status(http.statusCode)
                // Token was revoked/rotated — stop retrying until the web
                // app hands over a fresh one.
                if http.statusCode == 401 { self.defaults.set(false, forKey: Key.enabled) }
            } else if let error = error {
                self.defaults.set("\(ISO8601DateFormatter().string(from: Date())) error=\(error.localizedDescription)", forKey: "hkbg.lastUpload")
            }
            done()
        }.resume()
    }

    var lastUpload: String { defaults.string(forKey: "hkbg.lastUpload") ?? "never" }
}

@objc(HealthBackgroundPlugin)
public class HealthBackgroundPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthBackgroundPlugin"
    public let jsName = "HealthBackground"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    @objc func configure(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"), let token = call.getString("token"),
              let url = call.getString("url"), let anonKey = call.getString("anonKey") else {
            call.reject("userId, token, url and anonKey are required")
            return
        }
        HealthBackgroundSync.shared.configure(userId: userId, token: token, url: url, anonKey: anonKey)
        call.resolve()
    }

    @objc func disable(_ call: CAPPluginCall) {
        HealthBackgroundSync.shared.disable()
        call.resolve()
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["enabled": HealthBackgroundSync.shared.isEnabled, "lastUpload": HealthBackgroundSync.shared.lastUpload])
    }
}
