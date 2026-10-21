# LStore on your Mac

LStore is a Mac app with its own window and Dock icon. It automatically starts
the local update service when opened; no browser tab or Terminal window is
needed. It listens only on this Mac, at `127.0.0.1:3000`.

## Build and open the Mac app

Double-click `build-mac-app.command` in Finder, or run:

```bash
cd /Users/leviwyszynski/eddy/lstore
./build-mac-app.command
```

The app is installed at `~/Applications/LStore.app` and opened automatically.
Drag it from Applications to the Dock. If macOS says the app cannot be opened,
Control-click LStore in Applications, choose **Open**, and confirm.

The bundled app uses the Node.js installation present on this Mac. Release
files and the admin token are stored separately in
`~/Library/Application Support/LStore/data`; the app itself can be rebuilt
without losing releases.

## Storefront

The main screen features the latest Eddy release and a clear **Download**
button for the Mac installer. The release notes and recent version history are
shown below it; the technical updater address is tucked into an optional
details section. Downloading saves the installer—it does not install Eddy
automatically.

## Local app studio

The app studio asks the local Ollama model to create a small, self-contained
web app prototype. Try its interactive sandboxed preview, review the source
files, and ask for changes in plain language as often as needed. Each change
appears as a reviewable draft; save it only when you are happy. Saving stores
the source under `~/Library/Application Support/LStore/data/projects` but
does not install or publish it.

You can optionally attach a PNG, JPEG, or WebP screenshot or sketch to an app
idea or change request. LStore resizes it on this Mac and asks the local
Ollama vision model (`qwen2.5vl:3b`) to describe its visible design. The image
is not uploaded, saved with the project, or included in an exported app. The
vision model download is about 3.2 GB; text-only suggestions continue to work
if it is not installed. The app studio shows the resulting app as a live,
interactive preview before saving.

Choose the app you want from the saved-app dropdown, then describe a change in
everyday language. Review the new preview and files, then explicitly save the
change to that same project. The saved app stays unchanged until you do.
Each saved change keeps the prior version in LStore. Use **Restore selected
version** on that project's card to bring an earlier version back; the current
version is kept in history too. Restoring changes the LStore project only.
Choose **Update installed app** separately if you want that restored version
to replace the app in Applications.
Saved apps can be tried again from **Your app projects**. Choose **Install in
Applications** to build and install the standalone WebKit-based Mac app in
`~/Applications`. If it is already installed, choose **Update installed app**
to replace that copy with the version saved in LStore; quit and reopen it to
see the changes. These are local app copies, not public releases.

Choose **Prepare copy to share** to build a ZIP in `~/Downloads/LStore Exports`.
LStore asks first and does not send or upload it. The ZIP contains the app and
recipient notes, but not the app's saved data. Review the package and share it
yourself only with people you choose. The app is ad-hoc signed, not Apple
Developer ID signed or notarized, so macOS may show a security warning on
another Mac. This export does not provide automatic updates to other people.

Installed apps run independently of LStore and keep app data in a private,
per-app folder under `~/Library/Application Support/Lee Vitaly Wyszynski/Apps`.
The interactive preview uses temporary in-memory data; installed apps can
retain data using the provided `window.appStorage` API. Each app has a 5 MB
data limit. Back up this folder if the app contains information you need.
Deleting LStore does not delete installed app bundles or this app-data folder,
but it removes the studio you use to revise projects and build local updates.

These generated apps are offline web interfaces in a native Mac window, not
full-featured Tauri apps. Updates on this Mac are manual and require LStore.
The local model does not use a hosted AI quota, but its capability and speed
depend on this Mac; review both the preview and generated files before saving
or installing.

## Local Eddy coding helper

The LStore dashboard includes a coding helper powered by Ollama and the local
`qwen2.5-coder:3b` model. It does not use a hosted AI service, API key, paid
credits, or provider message quota. Requests and selected Eddy source files
stay on this Mac. The model uses local CPU/GPU and memory, so responses may be
slower and less capable than a large hosted model.

The helper also accepts an optional PNG, JPEG, or WebP screenshot or sketch.
The same local `qwen2.5vl:3b` vision model describes the image for the coder;
the picture is not included in Eddy's source changes or release. The helper
shows a visual concept mockup for review, not a screenshot of a running Eddy
build. Screenshot understanding requires the approximately 3.2 GB vision
model download; text-only coding suggestions remain available without it.

Describe a change in the helper and review its suggested code. Choose
**Yes, create my update** only if the suggestion looks right. LStore then
applies the reviewed change, increments Eddy's patch version, builds and signs
the Mac app, and publishes the release here. Existing local edits are read as
the current source and checked for changes before the suggestion is applied.
Eddy downloads the new version the next time its updater checks while LStore
is running.

For visual changes, LStore also shows a before-and-after concept preview. It
is an illustration of the idea, not a screenshot or guarantee of the finished
app; open the optional code details to inspect the actual proposed changes.

The model is local and has no hosted AI subscription, API key, or provider
message quota. Its speed and coding ability depend on this Mac, and it can
make mistakes, so always review the suggestion. Build failures are shown in
LStore; the reviewed source change remains in the project so it can be fixed.

## Your Eddy releases

There are 36 historical published versions imported from GitHub and local
releases 0.3.4, 0.3.5, and 0.3.6. The dashboard lists Eddy and its five most
recent releases. The latest release fixes startup with the local LStore
updater.

## Publishing a future Eddy release

Open the LStore app and leave it running, then run this from Terminal in the
Eddy project:

```bash
cd /Users/leviwyszynski/eddy/lstore
LSTORE_URL=http://localhost:3000 npm run publish:eddy -- 0.3.6 "Describe the changes"
```

The publisher signs a Tauri update with the existing private key at
`~/.tauri/eddy.key` and uploads it to LStore on this Mac. Keep that private key
backed up and never copy it into the app, release files, or Git repository.
Use a new version number for each future release.

## Important limitations

- This personal Mac installation is intentionally local-only. Other computers
  cannot reach its `localhost` update service. To update a different computer,
  LStore will eventually need to run on a private server reachable by that
  computer.
- The imported historical release files were copied from GitHub once. Future
  updates can be built and published locally.
- Eddy 0.3.5 is built to check this Mac's LStore. Keep the LStore app running
  while Eddy checks for or downloads updates.
- The updater allows HTTP because its update service is this Mac's local
  `localhost` server. Keep that service bound to loopback; do not point this
  setting at a public or untrusted HTTP server.
- The app bundle has a valid local macOS signature, but it is not signed with
  an Apple Developer ID or notarized. macOS may still show a first-open
  warning; if so, Control-click Eddy and choose **Open**.
- Back up `~/Library/Application Support/LStore/data` and `~/.tauri/eddy.key`.
