# Eddy — desktop app project

This folder packages **Eddy** (the macroinvertebrate lab counter) as a real
macOS desktop app using [Tauri](https://tauri.app). The app itself is 100%
client-side HTML/JS — no server — so the desktop wrapper is thin: it just
gives Eddy its own window, dock icon, and a `.dmg` installer.

## What you need (one-time setup on your Mac)

1. **Xcode command line tools.** Open Terminal and run:
   ```
   xcode-select --install
   ```
   Click "Install" in the popup. Takes a few minutes.

2. **Rust.** In Terminal, run:
   ```
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
   Accept the defaults (just press Enter). When it finishes, close and
   reopen Terminal so the new paths load. Verify with:
   ```
   rustc --version
   ```

3. **Node.js 20 or newer.** Easiest: download the macOS installer from
   https://nodejs.org and run it. Verify with:
   ```
   node --version
   ```

## Build Eddy

1. Open Terminal and go to this folder:
   ```
   cd ~/workspace/eddy-desktop
   ```
   (Or wherever you put this folder — adjust the path.)

2. Install the JavaScript tooling (one time):
   ```
   npm install
   ```

3. Generate the full icon set from the master icon (one time):
   ```
   npx tauri icon src-tauri/icons/icon.png
   ```
   This creates all the sizes macOS needs (`.icns`, PNGs) in
   `src-tauri/icons/`.

4. Make sure the exported app HTML is in place at:
   ```
   ~/workspace/your_files/macro-counter-online/macro-counter-online.html
   ```
   (`build.sh` will stop with a clear error if it's missing.)

5. Build:
   ```
   ./build.sh
   ```

6. Find your app:
   - `src-tauri/target/release/bundle/dmg/` → **Eddy.dmg** (the installer
     you can share or keep)
   - `src-tauri/target/release/bundle/macos/` → **Eddy.app** (drag it to
     your Applications folder or your dock)

## Notes

- **First build takes a while.** It downloads ~200 MB of Rust dependencies
  and compiles everything — expect several minutes on a MacBook Air. Later
  builds are much faster.
- **"Unidentified developer" warning.** The app is unsigned (Apple charges
  $99/year for a signing certificate). On first launch, right-click
  Eddy.app → **Open** → click Open in the dialog. After that it opens
  normally.
- **Updating the app.** When Eddy gets a new version, drop the fresh
  exported HTML in place and re-run `./build.sh`. Bump `version` in
  `src-tauri/tauri.conf.json` if you want the installer to show it.
- **Windows later.** The same project builds a Windows `.exe` installer on
  a Windows machine: add `"nsis"` to the `targets` list in
  `src-tauri/tauri.conf.json`, then run `npx tauri build` there.

## TODO before distributing

- [ ] **Choose a license.** MIT (anyone can use/share/modify) vs.
  all-rights-reserved (yours only). Add a `LICENSE` file here before
  handing the `.dmg` to anyone.
