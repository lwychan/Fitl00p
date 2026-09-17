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
    var strain: Int?
    var netCaloriesKcal: Int?
    var netCaloriesIsDeficit: Bool?
    var steps: Int?
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

    func getTimeline(in context: Context, completion: @escaping (Timeline<ComplicationEntry>) -> Void) {
        let entry = ComplicationEntry(date: Date(), scores: loadWatchScoreData())
        let nextRefresh = Calendar.current.date(byAdding: .hour, value: 4, to: Date()) ?? Date().addingTimeInterval(4 * 3600)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

struct ComplicationWidgetView: View {
    var entry: ComplicationProvider.Entry

    var body: some View {
        if let recovery = entry.scores?.recovery {
            Gauge(value: Double(recovery), in: 0...100) {
                Text("Rec")
            } currentValueLabel: {
                Text("\(recovery)")
            }
            .gaugeStyle(.accessoryCircular)
        } else {
            Text("—")
        }
    }
}

// v1 ships one metric (Recovery) in one family (circular) — the same
// scope-narrowing already applied to the iOS Home Screen widget (Phase B):
// simplest correct thing first, since every change here can only be
// validated via a full Codemagic CI cycle, not locally.
struct ComplicationWidget: Widget {
    let kind: String = "ComplicationWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ComplicationProvider()) { entry in
            ComplicationWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Recovery")
        .description("Today's recovery score.")
        .supportedFamilies([.accessoryCircular])
    }
}
