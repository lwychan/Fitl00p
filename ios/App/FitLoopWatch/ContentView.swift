import SwiftUI

// Same shape ScoreWidgetBridgePlugin.writeScores() writes and
// WatchDelegate.saveContext() mirrors into this device's own App Group —
// duplicated per-target rather than shared, matching this project's
// existing convention (see diabetes-engine.js/.ts).
struct WatchScoreData: Codable {
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
    var updatedAt: String?
}

func loadWatchScoreData() -> WatchScoreData? {
    guard let defaults = UserDefaults(suiteName: "group.com.lwychan.fitl00p"),
          let data = defaults.data(forKey: "fitloop.todayScores") else { return nil }
    return try? JSONDecoder().decode(WatchScoreData.self, from: data)
}

// The Nebula theme's liquid-fill gauge (see .score-gauge__liquid in
// src/app.css) ported to SwiftUI — full rendering control here since this
// is the app's own screen, not a watch-face-embedded complication (those
// use the platform Gauge/.accessoryCircularCapacity style instead, see
// FitLoopWatchWidgets/ComplicationWidget.swift, since watch faces often
// re-tint or force monochrome on third-party complications).
//
// Text is sized proportionally to the gauge's own rendered diameter
// (via GeometryReader) rather than a fixed point size — a fixed size
// looked lost/tiny inside the large gauge circles on the iOS systemLarge
// widget while being fine on the small watch screen, since the circles
// themselves scale with their container but fixed-size text doesn't.
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

private func fillFraction(_ value: Double?, _ target: Double) -> Double {
    guard let value, target > 0 else { return 0 }
    return min(1, max(0, value / target))
}

struct MetricRow: Identifiable {
    let id: String
    let fillPct: Double
    let color: Color
    let value: String
    let label: String
}

func metricRows(for s: WatchScoreData?) -> [MetricRow] {
    [
        MetricRow(id: "recovery", fillPct: fillFraction(s?.recovery.map(Double.init), 100),
                  color: Color(red: 0.91, green: 0.47, blue: 0.98),
                  value: s?.recovery.map { "\($0)" } ?? "—", label: "Recovery"),
        MetricRow(id: "sleep", fillPct: fillFraction(s?.sleepHours, s?.sleepNeedHours ?? 8),
                  color: Color(red: 0.62, green: 0.53, blue: 0.96),
                  value: s?.sleep.map { "\($0)" } ?? "—", label: "Sleep"),
        MetricRow(id: "strain", fillPct: fillFraction(s?.strain, 21),
                  color: Color(red: 0.98, green: 0.62, blue: 0.26),
                  value: s?.strain.map { String(format: "%.1f", $0) } ?? "—", label: "Strain"),
        MetricRow(id: "steps", fillPct: fillFraction(s?.steps.map(Double.init), Double(s?.stepsGoal ?? 10000)),
                  color: Color(red: 1.0, green: 0.84, blue: 0.04),
                  value: s?.steps.map { "\($0)" } ?? "—", label: "Steps"),
        // Labelled "Cal %" (not "Calories") and shown with a % sign — this
        // is computeNutritionScore's 0-100 "how close to your eat target"
        // score, not a raw kcal count, and a bare number like "68" under
        // "Calories" reads as an actual calorie amount, which it isn't.
        MetricRow(id: "calories", fillPct: fillFraction(s?.nutritionScore.map(Double.init), 100),
                  color: Color(red: 0.20, green: 0.82, blue: 0.60),
                  value: s?.nutritionScore.map { "\($0)%" } ?? "—", label: "Cal %"),
    ]
}

struct ContentView: View {
    @State private var scores: WatchScoreData?

    var body: some View {
        ScrollView {
            if scores != nil {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ForEach(metricRows(for: scores)) { row in
                        LiquidGaugeView(fillPct: row.fillPct, color: row.color, value: row.value, label: row.label)
                            .aspectRatio(1, contentMode: .fit)
                    }
                }
                .padding(.horizontal, 4)
                // The watch's system time is drawn over the top of every
                // app screen — a bare ScrollView doesn't reserve room for
                // it, so the first row's gauges scrolled up underneath it.
                .padding(.top, 20)
            } else {
                VStack(spacing: 4) {
                    Text("FitLoop").font(.headline)
                    Text("Open the iPhone app to sync").font(.caption2).foregroundStyle(.secondary)
                }
                .padding()
                .padding(.top, 20)
            }
        }
        .onAppear { scores = loadWatchScoreData() }
        .onReceive(NotificationCenter.default.publisher(for: .fitLoopScoresUpdated)) { _ in
            scores = loadWatchScoreData()
        }
    }
}

#Preview {
    ContentView()
}
