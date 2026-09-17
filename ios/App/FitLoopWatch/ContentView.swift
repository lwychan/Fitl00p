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
struct LiquidGaugeView: View {
    let fillPct: Double
    let color: Color
    let value: String
    let label: String

    var body: some View {
        ZStack {
            Circle().fill(Color.white.opacity(0.06))
            GeometryReader { geo in
                VStack {
                    Spacer(minLength: 0)
                    LinearGradient(colors: [color.opacity(0.85), color], startPoint: .top, endPoint: .bottom)
                        .frame(height: geo.size.height * fillPct)
                }
            }
            .clipShape(Circle())
            Circle()
                .fill(Color.white.opacity(0.35))
                .frame(width: 8, height: 6)
                .blur(radius: 1.2)
                .offset(x: -6, y: -8)
            VStack(spacing: 0) {
                Text(value).font(.callout).bold().foregroundStyle(.white)
                Text(label).font(.system(size: 8)).foregroundStyle(.white.opacity(0.7))
            }
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
        MetricRow(id: "calories", fillPct: fillFraction(s?.nutritionScore.map(Double.init), 100),
                  color: Color(red: 0.20, green: 0.82, blue: 0.60),
                  value: s?.nutritionScore.map { "\($0)" } ?? "—", label: "Calories"),
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
            } else {
                VStack(spacing: 4) {
                    Text("FitLoop").font(.headline)
                    Text("Open the iPhone app to sync").font(.caption2).foregroundStyle(.secondary)
                }
                .padding()
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
