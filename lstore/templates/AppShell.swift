import AppKit
import WebKit

final class AppDataStore: NSObject, WKScriptMessageHandler {
    private let fileURL: URL
    private let lock = NSLock()
    private var values: [String: String]
    private let maximumBytes = 5 * 1024 * 1024
    private let maximumValueBytes = 256 * 1024

    init(bundleIdentifier: String, applicationSupportDirectory: URL? = nil) throws {
        guard bundleIdentifier.range(of: #"^[A-Za-z0-9.-]+$"#, options: .regularExpression) != nil else {
            throw NSError(domain: "LStoreAppData", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "This app does not have a valid private data location.",
            ])
        }
        let supportDirectory: URL
        if let applicationSupportDirectory {
            supportDirectory = applicationSupportDirectory
        } else {
            supportDirectory = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
        }
        let ownerDirectory = supportDirectory.appendingPathComponent("Lee Vitaly Wyszynski", isDirectory: true)
        let appsDirectory = ownerDirectory.appendingPathComponent("Apps", isDirectory: true)
        let appDirectory = appsDirectory.appendingPathComponent(bundleIdentifier, isDirectory: true)
        for directory in [ownerDirectory, appsDirectory, appDirectory] {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        }
        fileURL = appDirectory.appendingPathComponent("storage.json")
        if FileManager.default.fileExists(atPath: fileURL.path) {
            let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
            guard data.count <= maximumBytes else {
                throw NSError(domain: "LStoreAppData", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "This app’s saved data is larger than the supported limit.",
                ])
            }
            let decoded = try JSONDecoder().decode([String: String].self, from: data)
            try Self.validate(decoded, maximumValueBytes: maximumValueBytes, maximumBytes: maximumBytes)
            values = decoded
        } else {
            values = [:]
        }
        super.init()
    }

    func initialScript() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let data = try JSONEncoder().encode(values)
        let encoded = data.base64EncodedString()
        return """
        (() => {
          const bytes = Uint8Array.from(atob('\(encoded)'), character => character.charCodeAt(0));
          const values = JSON.parse(new TextDecoder().decode(bytes));
          const write = (action, key, value) => {
            window.webkit.messageHandlers.appStorage.postMessage({ action, key, value });
          };
          Object.defineProperty(window, 'appStorage', {
            configurable: false,
            value: Object.freeze({
              getItem: key => Object.prototype.hasOwnProperty.call(values, String(key)) ? values[String(key)] : null,
              setItem: (key, value) => {
                key = String(key);
                value = String(value);
                values[key] = value;
                write('set', key, value);
              },
              removeItem: key => {
                key = String(key);
                delete values[key];
                write('remove', key, '');
              },
              clear: () => {
                for (const key of Object.keys(values)) delete values[key];
                write('clear', '', '');
              },
              key: index => Object.keys(values)[index] ?? null,
              get length() { return Object.keys(values).length; }
            })
          });
        })();
        """
    }

    func string(forKey key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    func setValue(_ value: String, forKey key: String) throws {
        try update(action: "set", key: key, value: value)
    }

    func removeValue(forKey key: String) throws {
        try update(action: "remove", key: key, value: "")
    }

    func removeAllValues() throws {
        try update(action: "clear", key: "", value: "")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            showWriteError("The app sent an invalid data change.")
            return
        }
        do {
            try update(action: action, key: body["key"] as? String ?? "", value: body["value"] as? String ?? "")
        } catch {
            showWriteError("Your latest change could not be saved. Check available disk space and try again.\n\n\(error.localizedDescription)")
        }
    }

    private func update(action: String, key: String, value: String) throws {
        guard action == "clear" || (!key.isEmpty && key.utf8.count <= 128) else {
            throw NSError(domain: "LStoreAppData", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "The app’s data change was too large or invalid.",
            ])
        }
        guard action != "set" || value.utf8.count <= maximumValueBytes else {
            throw NSError(domain: "LStoreAppData", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "The app’s data change was too large or invalid.",
            ])
        }
        guard ["set", "remove", "clear"].contains(action) else {
            throw NSError(domain: "LStoreAppData", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "The app sent an unsupported data change.",
            ])
        }

        lock.lock()
        let previousValues = values
        if action == "clear" {
            values.removeAll()
        } else if action == "set" {
            values[key] = value
        } else {
            values.removeValue(forKey: key)
        }
        do {
            try persistValues()
            lock.unlock()
        } catch {
            values = previousValues
            lock.unlock()
            throw error
        }
    }

    private func persistValues() throws {
        try Self.validate(values, maximumValueBytes: maximumValueBytes, maximumBytes: maximumBytes)
        let data = try JSONEncoder().encode(values)
        try data.write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    private static func validate(
        _ values: [String: String],
        maximumValueBytes: Int,
        maximumBytes: Int
    ) throws {
        guard values.allSatisfy({ !$0.key.isEmpty && $0.key.utf8.count <= 128 && $0.value.utf8.count <= maximumValueBytes }),
              let data = try? JSONEncoder().encode(values),
              data.count <= maximumBytes else {
            throw NSError(domain: "LStoreAppData", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "The app’s saved data is invalid or larger than the supported limit.",
            ])
        }
    }

    private func showWriteError(_ message: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "Could not save app data"
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.runModal()
        }
    }
}

#if !LSTORE_STORAGE_TEST
final class GeneratedApp: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var projectDirectory: URL?
    private var appDataStore: AppDataStore?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        guard let projectDirectory = Bundle.main.resourceURL?.appendingPathComponent("App", isDirectory: true) else {
            showError("The app files could not be found.")
            return
        }
        self.projectDirectory = projectDirectory
        let page = projectDirectory.appendingPathComponent("index.html")
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
            showError("The app does not have a valid identifier for its private data.")
            return
        }
        let appDataStore: AppDataStore
        do {
            appDataStore = try AppDataStore(bundleIdentifier: bundleIdentifier)
        } catch {
            showError("The app’s private data could not be opened: \(error.localizedDescription)")
            return
        }
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(appDataStore, name: "appStorage")
        do {
            configuration.userContentController.addUserScript(WKUserScript(
                source: try appDataStore.initialScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        } catch {
            showError("The app’s saved data could not be prepared: \(error.localizedDescription)")
            return
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.loadFileURL(page, allowingReadAccessTo: projectDirectory)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "My App"
        window.minSize = NSSize(width: 620, height: 480)
        window.center()
        window.contentView = view
        window.makeKeyAndOrderFront(nil)

        self.webView = view
        self.window = window
        self.appDataStore = appDataStore
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              url.isFileURL,
              let projectDirectory,
              url.standardizedFileURL.path.hasPrefix(projectDirectory.standardizedFileURL.path + "/")
        else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Unable to open app"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

@main
enum GeneratedAppMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = GeneratedApp()
        application.delegate = delegate
        application.run()
    }
}
#endif
