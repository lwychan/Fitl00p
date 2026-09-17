import WidgetKit
import SwiftUI

// Mirrors ScoreWidget.swift's data shape — kept as a separate small copy
// (rather than shared across targets) since this project's convention is
// duplicating small platform-specific logic over sharing files across
// native targets (see diabetes-engine.js/.ts for the same pattern).
// FitLoopWatchApp's WatchDelegate writes this key via WatchConnectivity.
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

struct ComplicationEntry: TimelineEntry {
    let date: Date
    let scores: WatchScoreData?
}

struct ComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> ComplicationEntry {
        ComplicationEntry(date: Date(), scores: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (ComplicationEntry) -> Void) {
        completion(ComplicationEntry(date: Date(), scores: loadWatchScoreData()))
    }

    // The app calls WidgetCenter.reloadAllTimelines() itself whenever it
    // pushes fresh scores (see ScoreWidgetBridgePlugin), so this timeline
    // just needs today's snapshot plus a distant safety refresh — it isn't
    // the primary update mechanism.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ComplicationEntry>) -> Void) {
        let entry = ComplicationEntry(date: Date(), scores: loadWatchScoreData())
        let nextRefresh = Calendar.current.date(byAdding: .hour, value: 4, to: Date()) ?? Date().addingTimeInterval(4 * 3600)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

// Same fill/target/color convention as the phone dashboard's own gauges
// (SCORE_META in app.js): recovery/nutrition are 0-100 scores, strain is
// the real 0-21 TRIMP-style scale, steps/sleep fill against the user's own
// goal/need rather than an abstract score.
private func fillFraction(_ value: Double?, _ target: Double) -> Double {
    guard let value, target > 0 else { return 0 }
    return min(1, max(0, value / target))
}

// Uses SwiftUI's native accessory-capacity gauge rather than a fully
// custom liquid-orb view (used on the iOS widget / watch app screen) —
// watch faces frequently re-tint or force monochrome/always-on rendering
// on accessory-family complications, and Gauge + .accessoryCircularCapacity
// is the style Apple designed specifically to keep looking correct across
// all of those modes, unlike arbitrary custom SwiftUI content.
struct GaugeComplicationView: View {
    let fillPct: Double
    let value: String
    let color: Color

    var body: some View {
        Gauge(value: fillPct, in: 0...1) {
            EmptyView()
        } currentValueLabel: {
            Text(value)
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .tint(color)
    }
}

private func complicationWidget(kind: String, displayName: String, description: String,
                                 value: @escaping (WatchScoreData?) -> String,
                                 fillPct: @escaping (WatchScoreData?) -> Double,
                                 color: Color) -> some WidgetConfiguration {
    struct Content: View {
        let entry: ComplicationProvider.Entry
        let value: (WatchScoreData?) -> String
        let fillPct: (WatchScoreData?) -> Double
        let color: Color
        var body: some View {
            GaugeComplicationView(fillPct: fillPct(entry.scores), value: value(entry.scores), color: color)
        }
    }
    return StaticConfiguration(kind: kind, provider: ComplicationProvider()) { entry in
        Content(entry: entry, value: value, fillPct: fillPct, color: color)
            .containerBackground(.fill.tertiary, for: .widget)
    }
    .configurationDisplayName(displayName)
    .description(description)
    .supportedFamilies([.accessoryCircular])
}

struct RecoveryComplication: Widget {
    var body: some WidgetConfiguration {
        complicationWidget(
            kind: "RecoveryComplication", displayName: "Recovery", description: "Today's recovery score.",
            value: { $0?.recovery.map { "\($0)" } ?? "—" },
            fillPct: { fillFraction($0?.recovery.map(Double.init), 100) },
            color: Color(red: 0.91, green: 0.47, blue: 0.98)
        )
    }
}

struct SleepComplication: Widget {
    var body: some WidgetConfiguration {
        complicationWidget(
            kind: "SleepComplication", displayName: "Sleep", description: "Last night's sleep vs. your need.",
            value: { $0?.sleep.map { "\($0)" } ?? "—" },
            fillPct: { fillFraction($0?.sleepHours, $0?.sleepNeedHours ?? 8) },
            color: Color(red: 0.62, green: 0.53, blue: 0.96)
        )
    }
}

struct StrainComplication: Widget {
    var body: some WidgetConfiguration {
        complicationWidget(
            kind: "StrainComplication", displayName: "Strain", description: "Today's training strain.",
            value: { $0?.strain.map { String(format: "%.1f", $0) } ?? "—" },
            fillPct: { fillFraction($0?.strain, 21) },
            color: Color(red: 0.98, green: 0.62, blue: 0.26)
        )
    }
}

struct StepsComplication: Widget {
    var body: some WidgetConfiguration {
        complicationWidget(
            kind: "StepsComplication", displayName: "Steps", description: "Today's steps vs. your goal.",
            value: { $0?.steps.map { "\($0)" } ?? "—" },
            fillPct: { fillFraction($0?.steps.map(Double.init), Double($0?.stepsGoal ?? 10000)) },
            color: Color(red: 1.0, green: 0.84, blue: 0.04)
        )
    }
}

struct CalorieBalanceComplication: Widget {
    var body: some WidgetConfiguration {
        complicationWidget(
            kind: "CalorieBalanceComplication", displayName: "Calories", description: "How close to your calorie target today.",
            value: { $0?.nutritionScore.map { "\($0)" } ?? "—" },
            fillPct: { fillFraction($0?.nutritionScore.map(Double.init), 100) },
            color: Color(red: 0.20, green: 0.82, blue: 0.60)
        )
    }
}
