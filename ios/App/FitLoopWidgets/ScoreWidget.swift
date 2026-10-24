import WidgetKit
import SwiftUI

// Mirrors the JSON blob ScoreWidgetBridgePlugin.writeScores() writes into
// the shared App Group container — this widget never computes a score
// itself, only reads whatever the app last pushed (see app.js's
// pushScoresToWidgets()).
struct ScoreData: Codable {
    var recovery: Int?
    var sleep: Int?
    var strain: Double?
    var netCaloriesKcal: Int?
    var netCaloriesIsDeficit: Bool?
    var steps: Int?
    var stepsGoal: Int?
    var sleepHours: Double?
    var sleepNeedHours: Double?
    var nutritionScore: Int?
    var bodyBattery: Int?
    var bodyBatteryRate: Double?
    var bodyBatteryAt: String?
    var updatedAt: String?

    // Body Battery at `date`: the last value the app computed, carried on at
    // its rate for at most 3 hours (the app recomputes properly when opened).
    func bodyBattery(at date: Date) -> Int? {
        guard let base = bodyBattery else { return nil }
        guard let rate = bodyBatteryRate, let atString = bodyBatteryAt,
              let at = ISO8601DateFormatter.withFractions.date(from: atString) ?? ISO8601DateFormatter().date(from: atString)
        else { return base }
        let hours = min(3, max(0, date.timeIntervalSince(at) / 3600))
        return Int(min(100, max(5, (Double(base) + rate * hours).rounded())))
    }
}

extension ISO8601DateFormatter {
    static let withFractions: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

func loadScoreData() -> ScoreData? {
    guard let defaults = UserDefaults(suiteName: "group.com.lwychan.fitl00p"),
          let data = defaults.data(forKey: "fitloop.todayScores") else { return nil }
    return try? JSONDecoder().decode(ScoreData.self, from: data)
}

struct ScoreEntry: TimelineEntry {
    let date: Date
    let scores: ScoreData?
}

struct ScoreProvider: TimelineProvider {
    func placeholder(in context: Context) -> ScoreEntry {
        ScoreEntry(date: Date(), scores: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (ScoreEntry) -> Void) {
        completion(ScoreEntry(date: Date(), scores: loadScoreData()))
    }

    // The app calls WidgetCenter.reloadAllTimelines() itself whenever it
    // pushes fresh scores (see ScoreWidgetBridgePlugin). Between pushes,
    // one entry every 15 minutes for 3 hours lets the Body Battery gauge
    // tick on at its last rate (see ScoreData.bodyBattery(at:)).
    func getTimeline(in context: Context, completion: @escaping (Timeline<ScoreEntry>) -> Void) {
        let scores = loadScoreData()
        let now = Date()
        let entries = (0...12).map { i in
            ScoreEntry(date: now.addingTimeInterval(Double(i) * 15 * 60), scores: scores)
        }
        let nextRefresh = now.addingTimeInterval(4 * 3600)
        completion(Timeline(entries: entries, policy: .after(nextRefresh)))
    }
}

// The Nebula theme's liquid-fill gauge (see .score-gauge__liquid in
// src/app.css) ported to SwiftUI: a dark orb that fills bottom-up with a
// colored gradient as the metric approaches its target, plus a glassy
// specular highlight. fillPct is pre-clamped by the caller.
//
// Text is sized proportionally to the gauge's own rendered diameter (via
// GeometryReader) rather than a fixed point size — a fixed size looked
// lost/tiny inside the much bigger circles on the systemLarge widget
// while being fine at systemMedium, since the circles scale with their
// container but fixed-size text doesn't.
struct LiquidGaugeView: View {
    let fillPct: Double
    let color: Color
    let value: String
    let label: String

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            ZStack {
                Circle().fill(Color.white.opacity(0.06))
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    LinearGradient(colors: [color.opacity(0.85), color], startPoint: .top, endPoint: .bottom)
                        .frame(height: size * fillPct)
                }
                .clipShape(Circle())
                Circle()
                    .fill(Color.white.opacity(0.35))
                    .frame(width: size * 0.14, height: size * 0.1)
                    .blur(radius: size * 0.02)
                    .offset(x: -size * 0.14, y: -size * 0.18)
                VStack(spacing: size * 0.02) {
                    Text(value)
                        .font(.system(size: size * 0.26, weight: .bold))
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                        .foregroundStyle(.white)
                    Text(label)
                        .font(.system(size: size * 0.13, weight: .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .foregroundStyle(.white.opacity(0.75))
                }
                .padding(.horizontal, size * 0.06)
            }
            .frame(width: size, height: size)
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
    }
}

// Same fill/target/color convention as the phone dashboard's own gauges
// (SCORE_META in app.js) — recovery/nutrition are 0-100 scores, strain is
// the real 0-21 TRIMP-style scale, steps/sleep fill against the user's own
// goal/need rather than an abstract score.
struct GaugeSpec: Identifiable {
    let id: String
    let value: Double?
    let target: Double
    let color: Color
    let label: String
    let displayValue: String

    var fillPct: Double {
        guard let value, target > 0 else { return 0 }
        return min(1, max(0, value / target))
    }
}

// Same zone colours as the app-bar battery (76+ green, 51-75 blue,
// 26-50 amber, 25 and under red).
func bodyBatteryColor(_ level: Int?) -> Color {
    guard let level else { return Color(red: 0.19, green: 0.82, blue: 0.35) }
    if level >= 76 { return Color(red: 0.19, green: 0.82, blue: 0.35) }
    if level >= 51 { return Color(red: 0.04, green: 0.62, blue: 1.0) }
    if level >= 26 { return Color(red: 1.0, green: 0.62, blue: 0.04) }
    return Color(red: 1.0, green: 0.27, blue: 0.23)
}

func gaugeSpecs(for s: ScoreData?, at date: Date = Date()) -> [GaugeSpec] {
    let battery = s?.bodyBattery(at: date)
    return [
        GaugeSpec(id: "battery", value: battery.map(Double.init), target: 100,
                   color: bodyBatteryColor(battery), label: "Battery",
                   displayValue: battery.map { "\($0)%" } ?? "—"),
        GaugeSpec(id: "recovery", value: s?.recovery.map(Double.init), target: 100,
                   color: Color(red: 0.91, green: 0.47, blue: 0.98), label: "Recovery",
                   displayValue: s?.recovery.map { "\($0)" } ?? "—"),
        GaugeSpec(id: "sleep", value: s?.sleepHours, target: s?.sleepNeedHours ?? 8,
                   color: Color(red: 0.62, green: 0.53, blue: 0.96), label: "Sleep",
                   displayValue: s?.sleep.map { "\($0)" } ?? "—"),
        GaugeSpec(id: "strain", value: s?.strain, target: 21,
                   color: Color(red: 0.98, green: 0.62, blue: 0.26), label: "Strain",
                   displayValue: s?.strain.map { String(format: "%.1f", $0) } ?? "—"),
        GaugeSpec(id: "steps", value: s?.steps.map(Double.init), target: Double(s?.stepsGoal ?? 10000),
                   color: Color(red: 1.0, green: 0.84, blue: 0.04), label: "Steps",
                   displayValue: s?.steps.map { "\($0)" } ?? "—"),
        // Labelled "Cal %" (not "Calories") and shown with a % sign — this
        // is computeNutritionScore's 0-100 "how close to your eat target"
        // score, not a raw kcal count, and a bare number like "68" under
        // "Calories" reads as an actual calorie amount, which it isn't.
        GaugeSpec(id: "calories", value: s?.nutritionScore.map(Double.init), target: 100,
                   color: Color(red: 0.20, green: 0.82, blue: 0.60), label: "Cal %",
                   displayValue: s?.nutritionScore.map { "\($0)%" } ?? "—"),
    ]
}

struct ScoreWidgetView: View {
    var entry: ScoreProvider.Entry

    var body: some View {
        if entry.scores != nil {
            let specs = gaugeSpecs(for: entry.scores, at: entry.date)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(specs) { spec in
                    LiquidGaugeView(fillPct: spec.fillPct, color: spec.color, value: spec.displayValue, label: spec.label)
                        .aspectRatio(1, contentMode: .fit)
                }
            }
            .padding()
        } else {
            VStack(spacing: 4) {
                Text("Open FitLoop").font(.caption).foregroundStyle(.secondary)
                Text("to sync your scores").font(.caption2).foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}

struct ScoreWidget: Widget {
    let kind: String = "ScoreWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ScoreProvider()) { entry in
            ScoreWidgetView(entry: entry)
                .containerBackground(Color(red: 0.02, green: 0.02, blue: 0.04), for: .widget)
        }
        .configurationDisplayName("FitLoop Scores")
        .description("Body Battery plus today's recovery, sleep, strain, steps and calorie balance.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
