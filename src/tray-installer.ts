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
const RELEASE_TAG_PREFIX = 'tray-v'

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

async function fetchLatestTrayAssets(): Promise<ResolvedAssets> {
  // Pull the most recent 30 releases and pick the first one whose tag starts
  // with `tray-v`. We can't use `/releases/latest` because that returns the
  // single newest release across the whole repo — and `mac-v*` releases for
  // the macOS menubar would shadow our tray releases.
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
  const trayRelease = releases.find(r => r.tag_name.startsWith(RELEASE_TAG_PREFIX))
  if (!trayRelease) {
    throw new Error(
      `No \`${RELEASE_TAG_PREFIX}*\` release found. The Windows tray hasn't been published yet — ` +
      `check https://github.com/soumyadebroy3/codeburn/releases.`,
    )
  }
  const msi = trayRelease.assets.find(a => ASSET_PATTERN.test(a.name))
  if (!msi) {
    throw new Error(
      `No MSI asset found in release ${trayRelease.tag_name}. ` +
      `Check https://github.com/soumyadebroy3/codeburn/releases.`,
    )
  }
  const checksum = trayRelease.assets.find(a =>
    CHECKSUM_PATTERN.test(a.name) && a.name.startsWith(msi.name),
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

    return { msiPath: archivePath, launched: true }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
