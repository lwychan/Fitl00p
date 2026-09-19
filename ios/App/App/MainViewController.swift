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

    private func probe(_ wv: WKWebView, attemptsLeft: Int) {
        var answered = false
        let js = "return await new Promise(r => requestAnimationFrame(() => r(document.body ? document.body.childElementCount : 0)));"
        wv.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            answered = true
            switch result {
            case .failure(let error):
                Self.note("probe failed (\(error.localizedDescription)) — reloading")
                DispatchQueue.main.async { wv.reload() }
            case .success(let value):
                if (value as? Int ?? 0) == 0 {
                    if attemptsLeft > 1 {
                        Self.note("probe: empty page, re-checking")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self?.probe(wv, attemptsLeft: attemptsLeft - 1) }
                    } else {
                        Self.note("probe: page still empty — reloading")
                        DispatchQueue.main.async { wv.reload() }
                    }
                } else {
                    Self.note("probe ok")
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            if !answered {
                Self.note("probe timed out (page not rendering) — reloading")
                wv.reload()
            }
        }
    }
}
