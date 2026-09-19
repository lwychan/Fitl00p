import Capacitor

// CapApp-SPM's Package.swift only auto-wires npm-installed Capacitor plugins
// (see its "DO NOT MODIFY" header) — a local, in-repo plugin with no npm
// package has to be registered manually here instead.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScoreWidgetBridgePlugin())
        bridge?.registerPluginInstance(HealthBackgroundPlugin())
    }
}
