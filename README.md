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
- **Automatic updates.** The desktop app checks quietly at startup when
  automatic updates are enabled (the default). A downloaded update appears
  as a **Restart to update** pill; if dismissed, it is applied after five
  idle minutes. The updater verifies each update with the Tauri signing key;
  this key is separate from Apple's code-signing and notarization credentials.
- **Preparing a release.** Keep the versions in `package.json`,
  `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` identical. The
  release workflow builds a signed Apple Silicon updater artifact and
  publishes it when a matching `v<version>` tag is pushed. Do not push a
  release tag until the update and release assets are ready.
- **Signing-key setup.** In the repository's GitHub Actions secrets, set
  `TAURI_SIGNING_PRIVATE_KEY` to the contents of the private key that matches
  the updater public key in `src-tauri/tauri.conf.json`, and set
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to its password (or an empty value if
  the key has no password). Keep a secure backup of the private key. Never
  commit it or share it in chat. Replacing the key requires changing the
  configured public key and would prevent existing installations from
  verifying updates signed by the old key.
- **Windows later.** The same project builds a Windows `.exe` installer on
  a Windows machine: add `"nsis"` to the `targets` list in
  `src-tauri/tauri.conf.json`, then run `npx tauri build` there.

## TODO before distributing

- [ ] **Choose a license.** MIT (anyone can use/share/modify) vs.
  all-rights-reserved (yours only). Add a `LICENSE` file here before
  handing the `.dmg` to anyone.
