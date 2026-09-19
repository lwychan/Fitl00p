import Capacitor
import WebKit

// CapApp-SPM's Package.swift only auto-wires npm-installed Capacitor plugins
// (see its "DO NOT MODIFY" header) — a local, in-repo plugin with no npm
// package has to be registered manually here instead.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScoreWidgetBridgePlugin())
        bridge?.registerPluginInstance(HealthBackgroundPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(
            self, selector: #selector(appBecameActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    // iOS can kill the web view's content process while the app sits in the
    // background (memory pressure). Capacitor reloads on the termination
    // callback, but a page that comes back blank/black or unresponsive
    // isn't detected — so on every return to the foreground, confirm the
    // page actually answers and has content, and reload it if not.
    @objc private func appBecameActive() {
        guard let wv = webView else { return }
        var answered = false
        wv.evaluateJavaScript("document.body ? document.body.childElementCount : 0") { result, error in
            answered = true
            if error != nil || (result as? Int ?? 0) == 0 {
                DispatchQueue.main.async { wv.reload() }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if !answered { wv.reload() }
        }
    }
}
