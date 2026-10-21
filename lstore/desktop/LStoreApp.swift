import AppKit
import Foundation
import WebKit
import UniformTypeIdentifiers

final class LStoreApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKDownloadDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverProcess: Process?
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]
    private var shuttingDown = false
    private var launchAttempts = 0
    private let address = URL(string: "http://127.0.0.1:3000")!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createWindow()
        checkServerReady { [weak self] ready in
            guard let self else { return }
            if ready {
                self.loadDashboard()
            } else {
                self.startServer()
                self.waitForServer()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        shuttingDown = true
        if let serverProcess, serverProcess.isRunning {
            serverProcess.terminate()
        }
    }

    private func checkServerReady(completion: @escaping (Bool) -> Void) {
        let request = URLRequest(
            url: address.appendingPathComponent("api/apps"),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 0.5
        )
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ready = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                completion(ready)
            }
        }.resume()
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self
        view.uiDelegate = self

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "LStore"
        window.minSize = NSSize(width: 760, height: 620)
        window.center()
        window.contentView = view
        window.makeKeyAndOrderFront(nil)

        self.webView = view
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }

    private func startServer() {
        guard let nodePath = Bundle.main.object(forInfoDictionaryKey: "LStoreNodeExecutable") as? String,
              FileManager.default.isExecutableFile(atPath: nodePath),
              let workspacePath = Bundle.main.object(forInfoDictionaryKey: "LStoreWorkspaceDirectory") as? String,
              let serverPath = Bundle.main.resourceURL?.appendingPathComponent("LStoreServer/server.js").path
        else {
            showError("LStore could not find Node.js or its local server files.")
            return
        }

        let dataDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/LStore/data", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        } catch {
            showError("LStore could not create its private data folder: \(error.localizedDescription)")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [serverPath]
        process.environment = ProcessInfo.processInfo.environment.merging([
            "HOST": "127.0.0.1",
            "PORT": "3000",
            "LSTORE_DATA_DIR": dataDirectory.path,
            "LSTORE_WORKSPACE_DIR": workspacePath,
        ]) { _, appValue in appValue }

        let logDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/LStore", isDirectory: true)
        let logFile = logDirectory.appendingPathComponent("server.log")

        do {
            try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logFile.path) {
                FileManager.default.createFile(atPath: logFile.path, contents: nil)
            }
            let logHandle = try FileHandle(forWritingTo: logFile)
            try logHandle.seekToEnd()
            process.standardOutput = logHandle
            process.standardError = logHandle
            process.terminationHandler = { [weak self] child in
                guard child.terminationStatus != 0 else { return }
                DispatchQueue.main.async {
                    guard let self, !self.shuttingDown else { return }
                    self.showError("The update service stopped unexpectedly. See ~/Library/Logs/LStore/server.log for details.")
                }
            }
            try process.run()
            serverProcess = process
        } catch {
            showError("LStore could not start its local update service: \(error.localizedDescription)")
        }
    }

    private func waitForServer() {
        launchAttempts += 1
        checkServerReady { [weak self] ready in
            guard let self else { return }
            if ready {
                self.loadDashboard()
                return
            }
            if self.launchAttempts >= 40 {
                self.showError("The local update service did not start. See ~/Library/Logs/LStore/server.log for details.")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                self.waitForServer()
            }
        }
    }

    private func loadDashboard() {
        webView?.load(URLRequest(url: address))
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.png, .jpeg, .webP]
        panel.message = "Choose a screenshot or sketch to use as visual inspiration. The image stays on this Mac."
        panel.prompt = "Choose Image"
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let downloadsDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Downloads", isDirectory: true)
        let safeFilename = (suggestedFilename as NSString).lastPathComponent
        let filename = safeFilename.isEmpty ? "Eddy.dmg" : safeFilename
        let name = filename as NSString
        var destination = downloadsDirectory.appendingPathComponent(filename)
        var suffix = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            let candidate = "\(name.deletingPathExtension) (\(suffix)).\(name.pathExtension)"
            destination = downloadsDirectory.appendingPathComponent(candidate)
            suffix += 1
        }
        downloadDestinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let destination = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else {
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([destination])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        showDownloadError(error.localizedDescription)
    }

    private func showDownloadError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Download failed"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Unable to start LStore"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

@main
enum LStoreMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = LStoreApp()
        application.delegate = delegate
        application.run()
    }
}
