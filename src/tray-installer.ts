import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/// Public GitHub repo that hosts the signed Windows tray builds. `/releases/latest`
/// returns the newest tagged release; we filter its assets list for our MSI.
const RELEASE_API = 'https://api.github.com/repos/soumyadebroy3/codeburn/releases'
const ASSET_PATTERN = /^CodeBurn[. _-]?Tray.*\.msi$/i
const CHECKSUM_PATTERN = /\.msi\.sha256$/i
const SUPPORTED_OS = 'win32'
// Two tag patterns ship a tray .msi: `tray-v*` (component-only releases)
// and `v*` (lockstep fork-wide releases — npm + menubar + tray together).
// We pick the most recent release that has a tray MSI attached, regardless
// of which tag pattern, so the installer always reflects the latest build.
const TRAY_RELEASE_TAG_PATTERNS = [/^tray-v/, /^v\d/]

export type InstallResult = { msiPath: string; launched: boolean }

type ReleaseAsset = { name: string; browser_download_url: string }
type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }
type ResolvedAssets = { msi: ReleaseAsset; checksum: ReleaseAsset | null; tag: string }

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
  let msi: ReleaseAsset | undefined
  for (const release of releases) {
    if (!isTrayReleaseTag(release.tag_name)) continue
    const candidate = release.assets.find(a => ASSET_PATTERN.test(a.name))
    if (candidate) {
      trayRelease = release
      msi = candidate
      break
    }
  }
  if (!trayRelease || !msi) {
    throw new Error(
      `No tray-v* or v* release with a CodeBurn.Tray*.msi asset found. ` +
      `Check https://github.com/soumyadebroy3/codeburn/releases.`,
    )
  }
  const checksum = trayRelease.assets.find(a =>
    CHECKSUM_PATTERN.test(a.name) && a.name.startsWith(msi!.name),
  ) ?? null
  return { msi, checksum, tag: trayRelease.tag_name }
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

async function runMsiexec(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // msiexec lives at C:\Windows\System32\msiexec.exe on every Windows
    // install. Using the absolute path closes the PATH-injection vector
    // SonarQube would otherwise flag (S4036).
    const exe = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'msiexec.exe')
      : String.raw`C:\Windows\System32\msiexec.exe`
    const proc = spawn(exe, args, { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`msiexec exited with status ${code}`))
    })
  })
}

export async function installTrayApp(options: { force?: boolean } = {}): Promise<InstallResult> {
  ensureSupportedPlatform()

  console.log('Looking up the latest CodeBurn Tray release...')
  const { msi, checksum, tag } = await fetchLatestTrayAssets()
  console.log(`  Found: ${msi.name} (${tag})`)

  const stagingDir = await mkdtemp(join(tmpdir(), 'codeburn-tray-'))
  try {
    const archivePath = join(stagingDir, msi.name)
    console.log(`Downloading ${msi.name}...`)
    await downloadToFile(msi.browser_download_url, archivePath)

    if (!checksum) {
      throw new Error(
        `Release ${msi.name} does not publish a SHA-256 checksum file. ` +
        `Refusing to install an unverified MSI. ` +
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
      throw new Error(`MSI did not land at ${archivePath}.`)
    }

    // /qb = basic UI (progress bar only, no Wizard pages)
    // /norestart = never auto-reboot
    // REINSTALL=ALL REINSTALLMODE=vomus = force-reinstall when --force
    const args = ['/i', archivePath, '/qb', '/norestart']
    if (options.force) args.push('REINSTALL=ALL', 'REINSTALLMODE=vomus')

    console.log('Running MSI installer...')
    await runMsiexec(args)

    // Tauri's WiX installer doesn't ship a "launch app after install"
    // checkbox, so manually fire the .exe ourselves. Without this, users
    // get an empty 'codeburn tray' return and no visible tray icon, which
    // looks like the install silently failed. Best-effort: any failure
    // to launch (missing .exe, blocked by AV, etc.) is non-fatal — the
    // user can always start it from the Start Menu manually.
    const launched = await launchInstalledTray()

    return { msiPath: archivePath, launched }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

const TRAY_EXE_CANDIDATES = [
  String.raw`C:\Program Files\CodeBurn Tray\CodeBurn Tray.exe`,
  String.raw`C:\Program Files (x86)\CodeBurn Tray\CodeBurn Tray.exe`,
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
