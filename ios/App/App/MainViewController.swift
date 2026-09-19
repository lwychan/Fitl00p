import Capacitor
import WebKit

// CapApp-SPM's Package.swift only auto-wires npm-installed Capacitor plugins
// (see its "DO NOT MODIFY" header) — a local, in-repo plugin with no npm
// package has to be registered manually here instead.
class MainViewController: CAPBridgeViewController {
    private var wasInBackground = false
    static let lifecycleKey = "native.lifecycle"

    // Short native-side event log, drained into error_logs by the web app
    // after the next successful login (HealthBackground.status) — so a
    // blank-screen report can be traced to what iOS actually did.
    static func note(_ text: String) {
        var lines = UserDefaults.standard.stringArray(forKey: lifecycleKey) ?? []
        lines.append("\(ISO8601DateFormatter().string(from: Date())) \(text)")
        UserDefaults.standard.set(Array(lines.suffix(15)), forKey: lifecycleKey)
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScoreWidgetBridgePlugin())
        bridge?.registerPluginInstance(HealthBackgroundPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(appEnteredBackground),
                       name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(appBecameActive),
                       name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc private func appEnteredBackground() {
        wasInBackground = true
        Self.note("entered background")
    }

    // iOS can kill or blank the web view while the app sits in the
    // background. On return, confirm the page is actually rendering (a
    // requestAnimationFrame only fires for a page that's painting) and has
    // content; reload it if not. Deliberately NOT run on a cold launch (the
    // page is legitimately still loading then, and reloading restarts it).
    @objc private func appBecameActive() {
        guard wasInBackground, let wv = webView else { return }
        wasInBackground = false
        Self.note("active again, probing page")
        wv.setNeedsLayout()
        probe(wv, attemptsLeft: 2)
    }

    // Two plain evaluateJavaScript calls (the async-function API misfired on
    // a healthy page): one confirms the DOM has content and schedules a
    // requestAnimationFrame, a second, shortly after, confirms that frame
    // actually ran — i.e. the page is painting. A failure gets one retry
    // before any reload, since a reload of a working page costs more than
    // waiting a few seconds.
    private func probe(_ wv: WKWebView, attemptsLeft: Int) {
        let retry = { [weak self] (why: String) in
            if attemptsLeft > 1 {
                Self.note("probe: (why), re-checking")
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self?.probe(wv, attemptsLeft: attemptsLeft - 1) }
            } else {
                Self.note("probe: (why) — reloading")
                DispatchQueue.main.async { wv.reload() }
            }
        }
        var answered = false
        let js = "window.__flRaf = false; requestAnimationFrame(function () { window.__flRaf = true; }); document.body ? document.body.childElementCount : 0"
        wv.evaluateJavaScript(js) { result, error in
            answered = true
            if let error = error { retry("script error ((error.localizedDescription))"); return }
            if (result as? Int ?? 0) == 0 { retry("empty page"); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                wv.evaluateJavaScript("window.__flRaf === true") { painted, _ in
                    if (painted as? Bool) == true { Self.note("probe ok") } else { retry("page not painting") }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            if !answered { retry("no answer from page") }
        }
    }
}
