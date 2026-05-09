import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/// Public GitHub repo that hosts the signed Windows tray builds. `/releases/latest`
/// returns the newest tagged release; we filter its assets list for our MSI.
const RELEASE_API = 'https://api.github.com/repos/soumyadebroy3/codeburn/releases'
// Prefer the NSIS .exe (per-user install, no admin / UAC required)
// over the MSI (per-machine, needs admin and silently rolls back if the
// user declines or no UAC prompt fires under /qb).
const ASSET_PATTERN_NSIS = /^CodeBurn[. _-]?Tray.*setup\.exe$/i
const ASSET_PATTERN_MSI = /^CodeBurn[. _-]?Tray.*\.msi$/i
const CHECKSUM_SUFFIX = '.sha256'
const SUPPORTED_OS = 'win32'
// Two tag patterns ship a tray .msi: `tray-v*` (component-only releases)
// and `v*` (lockstep fork-wide releases — npm + menubar + tray together).
// We pick the most recent release that has a tray MSI attached, regardless
// of which tag pattern, so the installer always reflects the latest build.
const TRAY_RELEASE_TAG_PATTERNS = [/^tray-v/, /^v\d/]

export type InstallResult = { installerPath: string; launched: boolean }

type ReleaseAsset = { name: string; browser_download_url: string }
type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }
type ResolvedAssets = { installer: ReleaseAsset; checksum: ReleaseAsset | null; tag: string }

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

function ensureSupportedPlatform(): void {
  if (platform() !== SUPPORTED_OS) {
    throw new Error(
      `The tray app is Windows only (detected: ${platform()}).\n` +
      `On macOS, use \`codeburn menubar\` instead — it installs the native Swift menubar app.`,
    )
  }
}

function isTrayReleaseTag(tagName: string): boolean {
  return TRAY_RELEASE_TAG_PATTERNS.some(p => p.test(tagName))
}

async function fetchLatestTrayAssets(): Promise<ResolvedAssets> {
  // Pull the most recent 30 releases and walk them in order (newest first).
  // Pick the first one whose tag matches a tray release pattern AND has a
  // tray .msi attached. This is the right shape because:
  //   1. /releases/latest only returns the single newest tag across the
  //      whole repo, and mac-v* releases would shadow ours
  //   2. Both `tray-v*` (component-only) and `v*` (lockstep) releases ship
  //      a tray .msi after the consolidated workflow rollout
  //   3. Skipping releases without a tray asset is safe — `mac-vX` releases
  //      have no MSI, and we just keep walking the list
  const response = await fetch(RELEASE_API, {
    headers: {
      'User-Agent': 'codeburn-tray-installer',
      Accept: 'application/vnd.github+json',
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: HTTP ${response.status}`)
  }
  const releases = await response.json() as ReleaseResponse[]
  let trayRelease: ReleaseResponse | null = null
  let installer: ReleaseAsset | undefined
  for (const release of releases) {
    if (!isTrayReleaseTag(release.tag_name)) continue
    // Prefer NSIS .exe over .msi — NSIS installs per-user under
    // %LOCALAPPDATA% without admin/UAC. The MSI is per-machine and
    // silently rolls back without elevation under msiexec /qb.
    const nsis = release.assets.find(a => ASSET_PATTERN_NSIS.test(a.name))
    const msi = release.assets.find(a => ASSET_PATTERN_MSI.test(a.name))
    if (nsis ?? msi) {
      trayRelease = release
      installer = nsis ?? msi
      break
    }
  }
  if (!trayRelease || !installer) {
    throw new Error(
      `No tray-v* or v* release with a CodeBurn.Tray installer asset found. ` +
      `Check https://github.com/soumyadebroy3/codeburn/releases.`,
    )
  }
  const checksum = trayRelease.assets.find(a =>
    a.name === installer.name + CHECKSUM_SUFFIX,
  ) ?? null
  return { installer, checksum, tag: trayRelease.tag_name }
}

async function verifyChecksum(archivePath: string, checksumUrl: string): Promise<void> {
  const response = await fetch(checksumUrl, {
    headers: { 'User-Agent': 'codeburn-tray-installer' },
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`Checksum download failed: HTTP ${response.status}`)
  }
  const text = await response.text()
  // String.split always returns a non-empty array, so [0] is defined; no
  // non-null assertion needed.
  const [head = ''] = text.trim().split(/\s+/)
  const expected = head.toLowerCase()
  const fileBytes = await readFile(archivePath)
  const actual = createHash('sha256').update(fileBytes).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${archivePath}.\n` +
      `  Expected: ${expected}\n` +
      `  Got:      ${actual}\n` +
      `The download may be corrupted or tampered with.`,
    )
  }
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'codeburn-tray-installer' },
    redirect: 'follow',
  })
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed: HTTP ${response.status}`)
  }
  // `as never` is the documented escape hatch for the DOM ReadableStream
  // <-> Node ReadableStream signature mismatch. Sonar S4325 is wrong here:
  // without the assertion TS rejects the call. Same pattern as
  // src/menubar-installer.ts:116.
  const nodeStream = Readable.fromWeb(response.body as never) // NOSONAR S4325
  await pipeline(nodeStream, createWriteStream(destPath))
}

/// Re-validate the installer filename right before we spawn it. The asset
/// name is already filtered against ASSET_PATTERN_{NSIS,MSI} when the release
/// list is fetched, and the file's SHA-256 is verified against the .sha256
/// sidecar before this function is called — but CodeQL's taint analysis
/// cannot follow data across those boundaries (js/command-line-injection,
/// alert #1). Re-asserting the pattern at the spawn site gives CodeQL a
/// visible sanitizer and gives us defense-in-depth: even if a future
/// refactor accidentally bypassed the upstream filter, this guard would
/// still refuse to spawn anything that doesn't look like our installer.
function assertSafeInstallerPath(installerPath: string, isMsi: boolean): void {
  const name = basename(installerPath)
  const pattern = isMsi ? ASSET_PATTERN_MSI : ASSET_PATTERN_NSIS
  if (!pattern.test(name)) {
    throw new Error(`refusing to spawn unrecognized installer: ${name}`)
  }
}

async function runInstaller(installerPath: string, isMsi: boolean, force: boolean): Promise<void> {
  assertSafeInstallerPath(installerPath, isMsi)
  if (isMsi) {
    return new Promise((resolve, reject) => {
      // msiexec lives at C:\Windows\System32\msiexec.exe on every Windows
      // install. Using the absolute path closes the PATH-injection vector
      // SonarQube would otherwise flag (S4036).
      const exe = process.env.SystemRoot
        ? join(process.env.SystemRoot, 'System32', 'msiexec.exe')
        : String.raw`C:\Windows\System32\msiexec.exe`
      // /qb = basic UI; /norestart = never auto-reboot
      // REINSTALL=ALL REINSTALLMODE=vomus = force-reinstall when --force
      const args = ['/i', installerPath, '/qb', '/norestart']
      if (force) args.push('REINSTALL=ALL', 'REINSTALLMODE=vomus')
      const proc = spawn(exe, args, { stdio: 'inherit' })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`msiexec exited with status ${code}`))
      })
    })
  }
  // NSIS installer: a self-contained .exe. Run with /S for silent install
  // unless --force is requested (then show the wizard so the user can
  // confirm overwrite). Per-user install means no UAC prompt.
  return new Promise((resolve, reject) => {
    const args = force ? [] : ['/S']
    const proc = spawn(installerPath, args, { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`NSIS installer exited with status ${code}`))
    })
  })
}

export async function installTrayApp(options: { force?: boolean } = {}): Promise<InstallResult> {
  ensureSupportedPlatform()

  console.log('Looking up the latest CodeBurn Tray release...')
  const { installer, checksum, tag } = await fetchLatestTrayAssets()
  const isMsi = ASSET_PATTERN_MSI.test(installer.name)
  const flavor = isMsi ? 'MSI (per-machine, requires admin)' : 'NSIS (per-user, no admin)'
  console.log(`  Found: ${installer.name} (${tag}) — ${flavor}`)

  const stagingDir = await mkdtemp(join(tmpdir(), 'codeburn-tray-'))
  try {
    const archivePath = join(stagingDir, installer.name)
    console.log(`Downloading ${installer.name}...`)
    await downloadToFile(installer.browser_download_url, archivePath)

    if (!checksum) {
      throw new Error(
        `Release ${installer.name} does not publish a SHA-256 checksum file. ` +
        `Refusing to install an unverified binary. ` +
        `Set CODEBURN_INSECURE_INSTALL=1 to skip verification (not recommended).`,
      )
    }
    if (process.env.CODEBURN_INSECURE_INSTALL === '1') {
      console.log('Warning: skipping checksum verification because CODEBURN_INSECURE_INSTALL=1.')
    } else {
      console.log('Verifying checksum...')
      await verifyChecksum(archivePath, checksum.browser_download_url)
    }

    if (!(await exists(archivePath))) {
      throw new Error(`Installer did not land at ${archivePath}.`)
    }

    console.log(`Running ${isMsi ? 'MSI' : 'NSIS'} installer...`)
    await runInstaller(archivePath, isMsi, options.force === true)

    // Tauri's WiX installer doesn't ship a "launch app after install"
    // checkbox, so manually fire the .exe ourselves. Without this, users
    // get an empty 'codeburn tray' return and no visible tray icon, which
    // looks like the install silently failed. Best-effort: any failure
    // to launch (missing .exe, blocked by AV, etc.) is non-fatal — the
    // user can always start it from the Start Menu manually.
    const launched = await launchInstalledTray()

    return { installerPath: archivePath, launched }
  } finally {
    // Cleanup must not fail the install. Windows can hold a file handle on
    // the just-extracted installer .exe for a few seconds after the NSIS
    // process exits, which makes rm throw EPERM even with `force: true`.
    // The temp dir lives under %TEMP% and Windows cleans it on its own
    // schedule anyway — best-effort log, never throw.
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.log(`  (Note: temp staging dir was held open and could not be removed: ${detail.split('\n')[0]}. ` +
        `Windows will clean it up automatically. Safe to ignore.)`)
    }
  }
}

// Tauri NSIS installs per-user under %LOCALAPPDATA%\<productName>\ (with
// the spaced product name), and the binary uses Cargo's [package].name —
// `codeburn-tray.exe` (lowercase, hyphenated) — NOT productName.exe. The
// per-machine MSI fallbacks under Program Files are kept in case a future
// release switches to a per-machine install or runs under admin.
const LOCAL_APPDATA = process.env.LOCALAPPDATA ?? String.raw`C:\Users\Default\AppData\Local`
const TRAY_EXE_CANDIDATES = [
  String.raw`${LOCAL_APPDATA}\CodeBurn Tray\codeburn-tray.exe`,
  String.raw`C:\Program Files\CodeBurn Tray\codeburn-tray.exe`,
  String.raw`C:\Program Files (x86)\CodeBurn Tray\codeburn-tray.exe`,
]

async function launchInstalledTray(): Promise<boolean> {
  for (const exe of TRAY_EXE_CANDIDATES) {
    if (!(await exists(exe))) continue
    try {
      // detached + ignored stdio so the tray app keeps running after the
      // CLI exits; otherwise Node would tear it down with the parent.
      const child = spawn(exe, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      console.log(`  Launched ${exe}.`)
      console.log('  (Look in the system tray near the clock — click the ^ chevron if hidden.)')
      return true
    } catch {
      return false
    }
  }
  console.log('  Note: install completed but the tray binary was not at any expected path.')
  console.log('  Start it manually from the Start Menu ("CodeBurn Tray").')
  return false
}
