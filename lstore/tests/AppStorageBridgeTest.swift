import AppKit
import Foundation
import WebKit
import Darwin

final class AppStorageBridgeTest: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private let supportDirectory: URL
    private let mode: String
    private let bundleIdentifier = "com.eddy.lstore.storage-test"
    private var store: AppDataStore?
    private var webView: WKWebView?
    private var window: NSWindow?

    init(supportDirectory: URL, mode: String) {
        self.supportDirectory = supportDirectory
        self.mode = mode
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let store = try AppDataStore(
                bundleIdentifier: bundleIdentifier,
                applicationSupportDirectory: supportDirectory
            )
            self.store = store

            let directory = supportDirectory.appendingPathComponent("web-content", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let html = """
            <!doctype html><html><head><meta charset="utf-8"></head><body>
            <script>
              \(mode == "write" ? #"window.appStorage.setItem("garden", JSON.stringify(["Fern", "Mint"]));"# : "")
              document.body.dataset.storageReady = window.appStorage.getItem("garden");
            </script>
            </body></html>
            """
            let page = directory.appendingPathComponent("index.html")
            try html.write(to: page, atomically: true, encoding: .utf8)

            let configuration = WKWebViewConfiguration()
            configuration.userContentController.add(store, name: "appStorage")
            configuration.userContentController.addUserScript(WKUserScript(
                source: try store.initialScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
            let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240), configuration: configuration)
            webView.navigationDelegate = self
            self.webView = webView

            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            window.contentView = webView
            window.orderFrontRegardless()
            self.window = window
            webView.loadFileURL(page, allowingReadAccessTo: directory)
        } catch {
            fail(error.localizedDescription)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.body.dataset.storageReady") { result, error in
            do {
                if let error {
                    throw error
                }
                guard result as? String == #"["Fern","Mint"]"# else {
                    throw self.testError("The WebKit appStorage API returned the wrong value.")
                }

                guard let store = self.store,
                      store.string(forKey: "garden") == #"["Fern","Mint"]"# else {
                    throw self.testError("The WebKit storage bridge did not save its value.")
                }

                if self.mode == "write" {
                    try self.verifyPrivateFilePermissions()
                    try self.verifyStorageLimits(store)
                    print("PASS: WebKit appStorage bridge writes app data.")
                    print("PASS: App data is stored with private file permissions.")
                    print("PASS: Delete and size-limit protections work.")
                } else {
                    print("PASS: App data remains available after quitting and reopening the app process.")
                }
                exit(0)
            } catch {
                self.fail(error.localizedDescription)
            }
        }
    }

    private func verifyPrivateFilePermissions() throws {
        let dataURL = supportDirectory
            .appendingPathComponent("Lee Vitaly Wyszynski/Apps/\(bundleIdentifier)/storage.json")
        let permissions = try FileManager.default.attributesOfItem(atPath: dataURL.path)[.posixPermissions] as? NSNumber
        guard permissions?.intValue == 0o600 else {
            throw testError("Saved app data permissions are not private.")
        }
    }

    private func verifyStorageLimits(_ store: AppDataStore) throws {
        try store.removeValue(forKey: "garden")
        guard store.string(forKey: "garden") == nil else {
            throw testError("Removing saved app data did not work.")
        }
        try store.setValue(#"["Fern","Mint"]"#, forKey: "garden")

        do {
            try store.setValue(String(repeating: "x", count: 256 * 1024 + 1), forKey: "too-large")
            throw testError("The storage size limit was not enforced.")
        } catch let error as NSError where error.domain == "LStoreAppData" {
            guard store.string(forKey: "too-large") == nil else {
                throw testError("An invalid storage write changed saved data.")
            }
        }
    }

    private func testError(_ message: String) -> NSError {
        NSError(domain: "AppStorageBridgeTest", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func fail(_ message: String) -> Never {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

@main
enum AppStorageBridgeTestMain {
    static func main() {
        guard CommandLine.arguments.count == 3,
              ["write", "reopen"].contains(CommandLine.arguments[2]) else {
            fputs("Usage: AppStorageBridgeTest <temporary-application-support-directory> <write|reopen>\n", stderr)
            exit(2)
        }
        let application = NSApplication.shared
        let delegate = AppStorageBridgeTest(
            supportDirectory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true),
            mode: CommandLine.arguments[2]
        )
        application.delegate = delegate
        application.run()
    }
}
