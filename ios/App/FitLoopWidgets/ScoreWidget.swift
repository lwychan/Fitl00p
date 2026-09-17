import WidgetKit
import SwiftUI

// Mirrors the JSON blob ScoreWidgetBridgePlugin.writeScores() writes into
// the shared App Group container — this widget never computes a score
// itself, only reads whatever the app last pushed (see app.js's
// pushScoresToWidgets()).
struct ScoreData: Codable {
    var recovery: Int?
    var sleep: Int?
    var strain: Int?
    var netCaloriesKcal: Int?
    var netCaloriesIsDeficit: Bool?
    var steps: Int?
    var updatedAt: String?
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
    // pushes fresh scores (see ScoreWidgetBridgePlugin), so this timeline
    // just needs today's snapshot plus a distant safety refresh — it isn't
    // the primary update mechanism.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ScoreEntry>) -> Void) {
        let entry = ScoreEntry(date: Date(), scores: loadScoreData())
        let nextRefresh = Calendar.current.date(byAdding: .hour, value: 4, to: Date()) ?? Date().addingTimeInterval(4 * 3600)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }
}

struct ScoreStat: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title2).bold()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ScoreWidgetView: View {
    var entry: ScoreProvider.Entry

    var body: some View {
        if let s = entry.scores {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    ScoreStat(label: "Recovery", value: s.recovery.map { "\($0)" } ?? "—")
                    ScoreStat(label: "Sleep", value: s.sleep.map { "\($0)" } ?? "—")
                }
                HStack {
                    ScoreStat(label: "Strain", value: s.strain.map { "\($0)" } ?? "—")
                    ScoreStat(label: "Steps", value: s.steps.map { "\($0)" } ?? "—")
                }
                if let net = s.netCaloriesKcal {
                    Text("\(abs(net)) kcal \(s.netCaloriesIsDeficit == true ? "deficit" : "surplus")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("FitLoop Scores")
        .description("Today's recovery, sleep, strain, steps and calorie balance.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
