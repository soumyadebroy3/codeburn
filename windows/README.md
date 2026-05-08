# CodeBurn Windows Tray (Tauri)

Native Windows system-tray companion to the `codeburn` CLI. Mirrors the
macOS Swift menubar in `mac/`: same panels, same data path, same brand. The
two apps share the same JSON contract (the `codeburn report --format json`
output) so any change to a panel ports across with a single new component.

## Architecture

```
windows/
├── src/                  React + TypeScript WebView frontend (the popover UI)
├── src-tauri/            Rust shell — tray icon, window, plugins, IPC
│   ├── src/
│   │   ├── main.rs       entry, hides console window in release
│   │   ├── lib.rs        Tauri builder, tray + menu wiring
│   │   ├── codeburn_cli.rs   hardened spawn (port of CodeburnCLI.swift)
│   │   ├── log_sanitizer.rs  credential redaction (port of LogSanitizer.swift)
│   │   └── ipc.rs        #[tauri::command] handlers exposed to JS
│   ├── tauri.conf.json   bundle id, window config, plugin config
│   └── Cargo.toml
├── scripts/build-msi.ps1 wrapper around cargo tauri build
└── README.md
```

The tray polls `codeburn report --format json -p <period>` every 30s and
renders the result in a Mica/Acrylic-blurred WebView popover. Click outside
the popover hides it; right-click the tray icon for menu (Show, Refresh,
Open full report, Quit).

## Build (Windows)

Prereqs (one-time on a fresh dev machine):

```powershell
# Rust + Cargo
winget install Rustlang.Rustup
rustup default stable

# Node 22+
winget install OpenJS.NodeJS.LTS

# Tauri prerequisites (WebView2 ships with Windows 11 by default)
# https://v2.tauri.app/start/prerequisites/#windows
```

Local dev:

```powershell
cd windows
npm install
npm run tauri:dev      # opens the popover with hot-reload on the frontend
```

Production build (produces .msi + .exe NSIS installer):

```powershell
cd windows
npm install
npm run tauri:build
# Artefacts land in src-tauri/target/release/bundle/{msi,nsis}/
```

## CI builds

The `.github/workflows/release-tray.yml` workflow builds the .msi on
`windows-latest` whenever a `tray-v*` tag is pushed:

```bash
git tag tray-v0.1.0
git push origin tray-v0.1.0
```

The workflow attaches the `.msi`, `.exe`, and matching `.sha256` to a
GitHub Release, plus a `latest.json` manifest for the auto-updater plugin.

## Install for end users

Three paths, in order of friction:

```bash
# 1. Through the CLI (mirrors `codeburn menubar` on macOS)
npm install -g @soumyadebroy3/codeburn
codeburn tray

# 2. Direct download
# Visit https://github.com/soumyadebroy3/codeburn/releases/latest
# and double-click the .msi

# 3. Scoop (when a manifest is published)
scoop bucket add soumyadebroy3 https://github.com/soumyadebroy3/scoop-codeburn
scoop install codeburn-tray
```

## Code signing

v1 ships ad-hoc-signed (no Authenticode certificate). On first run users
see a Microsoft SmartScreen warning ("Windows protected your PC") and must
click "More info → Run anyway" once. This is the Windows analogue of the
macOS Gatekeeper "downloaded from internet" warning the Swift app shows.

When budget allows for a code-signing cert (~$200/yr), drop the `.cer` /
`.pfx` into the `release-tray.yml` secrets and add a `signtool sign` step
before the artefact upload. Auto-updater verifies signatures via Tauri's
public key separately, so unsigned artefacts still update correctly.

## Security posture

- **Hardened spawn**: `codeburn` is only invoked from a trusted path
  (Program Files, npm-global, scoop\\shims, WinGet\\Packages). PATH-hijacked
  binaries from a writable directory are refused.
- **Env scrub**: NODE_*, DYLD_*, LD_*, PYTHON*, GIT_* environment
  variables are stripped before spawning the CLI.
- **Log sanitizer**: any stderr surfaced to the UI runs through the same
  regex set as the Swift `LogSanitizer.swift` (sk-ant-, sk-, JWT,
  Bearer, 40+ char tokens) before display or logging.
- **CSP**: WebView content-security-policy locks scripts to `'self'` so a
  pwn'd HTML report can't pull external JS.

## Differences from the macOS app

This is a v1. Some features in the Swift menubar are not yet ported:

| Feature | macOS Swift | Windows Tauri |
|---|---|---|
| Tray icon + popover | ✓ | ✓ |
| Period switcher (Today/7d/30d/Month/All) | ✓ | ✓ |
| Activity + Models panels | ✓ | ✓ |
| Plan progress bars (5h window, 7d total, 7d Sonnet) | ✓ | partial — basic numbers only |
| Capacity estimator (confidence tiers) | ✓ | not yet ported |
| Quota-threshold notifications | ✓ | not yet ported |
| Auto-updater | ✓ | ✓ via tauri-plugin-updater |
| Login-on-launch | ✓ | ✓ via tauri-plugin-autostart |
| Compact mode | ✓ | not yet ported |
| Claude OAuth keychain integration | ✓ | not yet ported |

The roadmap to feature parity tracks via the upstream issue tracker.
