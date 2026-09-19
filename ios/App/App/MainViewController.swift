import Capacitor
import WebKit

// CapApp-SPM's Package.swift only auto-wires npm-installed Capacitor plugins
// (see its "DO NOT MODIFY" header) — a local, in-repo plugin with no npm
// package has to be registered manually here instead.
class MainViewController: CAPBridgeViewController {
    private var wasInBackground = false

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

    @objc private func appEnteredBackground() { wasInBackground = true }

    // iOS can kill the web view's content process while the app sits in the
    // background (memory pressure). Capacitor reloads on the termination
    // callback, but a page that comes back blank or unresponsive isn't
    // detected — so on returning from the background, confirm the page
    // answers and has content. Deliberately NOT run on a cold launch (the
    // page is legitimately still loading then, and reloading it restarts
    // the load), and an empty page gets a second look before any reload.
    @objc private func appBecameActive() {
        guard wasInBackground, let wv = webView else { return }
        wasInBackground = false
        probe(wv, attemptsLeft: 2)
    }

    private func probe(_ wv: WKWebView, attemptsLeft: Int) {
        var answered = false
        wv.evaluateJavaScript("document.body ? document.body.childElementCount : 0") { [weak self] result, error in
            answered = true
            if error != nil { DispatchQueue.main.async { wv.reload() }; return }
            if (result as? Int ?? 0) == 0 {
                if attemptsLeft > 1 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self?.probe(wv, attemptsLeft: attemptsLeft - 1) }
                } else {
                    DispatchQueue.main.async { wv.reload() }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            if !answered { wv.reload() }
        }
    }
}
