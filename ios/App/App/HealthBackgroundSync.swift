import Foundation
import HealthKit
import Capacitor

// Background Health delivery. HealthKit wakes the app (even when it isn't
// running) when new samples of an observed type arrive; there's no web
// view in that wake, so this reads the last few days natively and uploads
// them to the health-ingest edge function using a per-user ingest token
// the web app hands over via configure().
//
// Mirrors the foreground sync in app.js (runHealthKitSync): daily
// sums/averages, weight (unless the user logs weight manually), sleep
// sessions grouped by wake date, and workouts. Anything named slightly
// differently from the foreground path self-corrects: both upsert on the
// same keys, so the next app-open sync overwrites it.
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
        static let ignoreWeight = "hkbg.ignoreWeight"
        static let lastUpload = "hkbg.lastUpload"
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
    private let weightMetric = Metric(id: .bodyMass, column: "weight_kg", unit: .gramUnit(with: .kilo), option: .discreteAverage, scale: 1)

    var isEnabled: Bool { defaults.bool(forKey: Key.enabled) }
    var lastUpload: String { defaults.string(forKey: Key.lastUpload) ?? "never" }

    // Called from the web app whenever the built-in Health sync is on and
    // a user is signed in.
    func configure(userId: String, token: String, url: String, anonKey: String, ignoreWeight: Bool) {
        defaults.set(userId, forKey: Key.userId)
        defaults.set(token, forKey: Key.token)
        defaults.set(url, forKey: Key.url)
        defaults.set(anonKey, forKey: Key.anonKey)
        defaults.set(ignoreWeight, forKey: Key.ignoreWeight)
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

        var types: [HKSampleType] = metrics.compactMap { HKObjectType.quantityType(forIdentifier: $0.id) }
        types.append(HKObjectType.workoutType())
        if let t = HKObjectType.quantityType(forIdentifier: .bodyMass) { types.append(t) }
        if let t = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { types.append(t) }

        // Every type triggers the same full recent-days sync.
        for type in types {
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

        let fmt = DateFormatter()
        fmt.calendar = calendar
        fmt.timeZone = calendar.timeZone
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"
        let startDay = fmt.string(from: start)

        var byDay: [String: [String: Any]] = [:]
        var workoutRows: [[String: Any]] = []
        let group = DispatchGroup()
        let lock = NSLock()

        let ignoreWeight = defaults.bool(forKey: Key.ignoreWeight)
        let allMetrics = ignoreWeight ? metrics : metrics + [weightMetric]
        for m in allMetrics {
            guard let type = HKObjectType.quantityType(forIdentifier: m.id) else { continue }
            group.enter()
            let query = HKStatisticsCollectionQuery(
                quantityType: type, quantitySamplePredicate: nil,
                options: m.option, anchorDate: today, intervalComponents: interval)
            query.initialResultsHandler = { _, results, _ in
                results?.enumerateStatistics(from: start, to: Date()) { stat, _ in
                    let raw = m.option == .cumulativeSum ? stat.sumQuantity() : stat.averageQuantity()
                    guard let quantity = raw else { return }
                    let value = quantity.doubleValue(for: m.unit) * m.scale
                    let day = fmt.string(from: stat.startDate)
                    lock.lock(); byDay[day, default: [:]][m.column] = (value * 100).rounded() / 100; lock.unlock()
                }
                group.leave()
            }
            store.execute(query)
        }

        // Sleep: raw category segments, widened a day either side like the
        // foreground path so a session straddling the window isn't cut.
        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            group.enter()
            let from = calendar.date(byAdding: .day, value: -1, to: start) ?? start
            let pred = HKQuery.predicateForSamples(withStart: from, end: Date().addingTimeInterval(86400), options: [])
            let sleepQuery = HKSampleQuery(sampleType: sleepType, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                let sleep = Self.sleepByWakeDate((samples as? [HKCategorySample]) ?? [], fmt: fmt)
                lock.lock()
                for (day, cols) in sleep where day >= startDay {
                    for (k, v) in cols { byDay[day, default: [:]][k] = v }
                }
                lock.unlock()
                group.leave()
            }
            store.execute(sleepQuery)
        }

        group.enter()
        let workoutPred = HKQuery.predicateForSamples(withStart: start, end: Date(), options: [])
        let workoutQuery = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: workoutPred, limit: 100, sortDescriptors: nil) { _, samples, _ in
            let iso = ISO8601DateFormatter()
            for case let w as HKWorkout in samples ?? [] {
                var row: [String: Any] = [
                    "external_id": w.uuid.uuidString,
                    "workout_type": Self.workoutTypeName(w.workoutActivityType),
                    "started_at": iso.string(from: w.startDate),
                    "ended_at": iso.string(from: w.endDate),
                    "duration_min": (w.duration / 60 * 10).rounded() / 10,
                ]
                if let e = w.totalEnergyBurned?.doubleValue(for: .kilocalorie()) { row["active_energy_kcal"] = (e * 10).rounded() / 10 }
                if let d = w.totalDistance?.doubleValue(for: .meter()) { row["distance_km"] = (d / 10).rounded() / 100 }
                lock.lock(); workoutRows.append(row); lock.unlock()
            }
            group.leave()
        }
        store.execute(workoutQuery)

        group.notify(queue: .global()) { [weak self] in
            guard let self = self else { done(); return }
            let rows = byDay.map { day, cols -> [String: Any] in
                var row: [String: Any] = cols
                row["log_date"] = day
                // steps/exercise_mins are integer columns
                for k in ["steps", "exercise_mins"] { if let v = cols[k] as? Double { row[k] = Int(v.rounded()) } }
                return row
            }
            self.upload(rows: rows, workouts: workoutRows) {
                self.syncing = false
                done()
            }
        }
    }

    // Same grouping rules as hkSleepSessionsByWakeDate in app.js: segments
    // less than 90 min apart form one session, attributed to the local date
    // of its last segment; only asleep stages count (not inBed/awake).
    private static func sleepByWakeDate(_ samples: [HKCategorySample], fmt: DateFormatter) -> [String: [String: Any]] {
        let sorted = samples.sorted { $0.startDate < $1.startDate }
        var sessions: [[HKCategorySample]] = []
        var lastEnd = Date.distantPast
        for s in sorted {
            if !sessions.isEmpty && s.startDate.timeIntervalSince(lastEnd) <= 90 * 60 {
                sessions[sessions.count - 1].append(s)
                lastEnd = max(lastEnd, s.endDate)
            } else {
                sessions.append([s])
                lastEnd = s.endDate
            }
        }
        let iso = ISO8601DateFormatter()
        func round2(_ x: Double) -> Double { (x * 100).rounded() / 100 }
        var out: [String: [String: Any]] = [:]
        for segs in sessions {
            let asleep = segs.filter {
                $0.value != HKCategoryValueSleepAnalysis.inBed.rawValue && $0.value != HKCategoryValueSleepAnalysis.awake.rawValue
            }
            if asleep.isEmpty { continue }
            func hours(_ stage: Int?) -> Double {
                let sel = stage == nil ? asleep : asleep.filter { $0.value == stage! }
                return sel.reduce(0) { $0 + $1.endDate.timeIntervalSince($1.startDate) / 3600 }
            }
            guard let wake = segs.map({ $0.endDate }).max(), let begin = segs.map({ $0.startDate }).min() else { continue }
            out[fmt.string(from: wake)] = [
                "sleep_total_hrs": round2(hours(nil)),
                "sleep_deep_hrs": round2(hours(HKCategoryValueSleepAnalysis.asleepDeep.rawValue)),
                "sleep_rem_hrs": round2(hours(HKCategoryValueSleepAnalysis.asleepREM.rawValue)),
                "sleep_core_hrs": round2(hours(HKCategoryValueSleepAnalysis.asleepCore.rawValue)),
                "sleep_start": iso.string(from: begin),
                "sleep_end": iso.string(from: wake),
            ]
        }
        return out
    }

    // Names match the Health plugin's WorkoutType raw values for the
    // common activities; anything else is "other" until the foreground
    // sync re-upserts the same external_id with the plugin's own name.
    private static func workoutTypeName(_ t: HKWorkoutActivityType) -> String {
        switch t {
        case .running: return "running"
        case .cycling: return "cycling"
        case .walking: return "walking"
        case .swimming: return "swimming"
        case .yoga: return "yoga"
        case .traditionalStrengthTraining: return "strengthTraining"
        case .functionalStrengthTraining: return "functionalStrengthTraining"
        case .hiking: return "hiking"
        case .highIntensityIntervalTraining: return "highIntensityIntervalTraining"
        case .elliptical: return "elliptical"
        case .rowing: return "rowing"
        case .coreTraining: return "coreTraining"
        case .crossTraining: return "crossTraining"
        case .dance: return "dance"
        case .tennis: return "tennis"
        case .soccer: return "soccer"
        case .basketball: return "basketball"
        case .golf: return "golf"
        case .boxing: return "boxing"
        default: return "other"
        }
    }

    private func upload(rows: [[String: Any]], workouts: [[String: Any]], done: @escaping () -> Void) {
        guard !rows.isEmpty || !workouts.isEmpty,
              let userId = defaults.string(forKey: Key.userId),
              let token = defaults.string(forKey: Key.token),
              let base = defaults.string(forKey: Key.url),
              let anon = defaults.string(forKey: Key.anonKey),
              let url = URL(string: base + "/functions/v1/health-ingest"),
              let body = try? JSONSerialization.data(withJSONObject: ["userId": userId, "rows": rows, "workouts": workouts] as [String: Any])
        else { done(); return }

        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + anon, forHTTPHeaderField: "Authorization")
        req.setValue(anon, forHTTPHeaderField: "apikey")
        req.setValue(token, forHTTPHeaderField: "X-Ingest-Token")

        let stamp = ISO8601DateFormatter().string(from: Date())
        URLSession.shared.dataTask(with: req) { [weak self] _, response, error in
            guard let self = self else { done(); return }
            if let http = response as? HTTPURLResponse {
                self.defaults.set("\(stamp) status=\(http.statusCode) rows=\(rows.count) workouts=\(workouts.count)", forKey: Key.lastUpload)
                // Token was revoked/rotated — stop retrying until the web
                // app hands over a fresh one.
                if http.statusCode == 401 { self.defaults.set(false, forKey: Key.enabled) }
            } else if let error = error {
                self.defaults.set("\(stamp) error=\(error.localizedDescription)", forKey: Key.lastUpload)
            }
            done()
        }.resume()
    }
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
        HealthBackgroundSync.shared.configure(userId: userId, token: token, url: url, anonKey: anonKey,
                                              ignoreWeight: call.getBool("ignoreWeight") ?? false)
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
