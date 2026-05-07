/**
 * `codeburn diagnose` — runs the full discovery pipeline with verbose tracing
 * and surfaces every provider's session count + skipped files. The CLI's
 * default behaviour swallows almost everything (per-line catches, silent
 * read failures) so users hit "I see nothing in the dashboard" walls with
 * no diagnostic surface. This command is the answer.
 */

import { homedir } from 'os'
import { stat } from 'fs/promises'
import type { Provider } from './providers/types.js'
import { getAllProviders } from './providers/index.js'

type ProviderReport = {
  name: string
  displayName: string
  sessionCount: number
  oldestSession: string | null
  newestSession: string | null
  totalBytes: number
  errors: string[]
  durationMs: number
}

function shortHomePath(absPath: string): string {
  const home = homedir()
  return absPath.startsWith(home) ? '~' + absPath.slice(home.length) : absPath
}

async function statSessionFile(p: string): Promise<{ ok: true; mtime: number; size: number } | { ok: false; reason: string }> {
  try {
    const s = await stat(p)
    return { ok: true, mtime: s.mtimeMs, size: s.size }
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException).code ?? 'unknown' }
  }
}

async function reportProvider(provider: Provider): Promise<ProviderReport> {
  const start = Date.now()
  const errors: string[] = []
  let sessionCount = 0
  let totalBytes = 0
  let oldestMs = Infinity
  let newestMs = -Infinity
  let oldestPath = ''
  let newestPath = ''

  let sources
  try {
    sources = await provider.discoverSessions()
  } catch (e) {
    errors.push(`discoverSessions failed: ${(e as Error).message ?? 'unknown'}`)
    return {
      name: provider.name,
      displayName: provider.displayName,
      sessionCount: 0,
      oldestSession: null,
      newestSession: null,
      totalBytes: 0,
      errors,
      durationMs: Date.now() - start,
    }
  }

  for (const source of sources) {
    sessionCount += 1
    const stat = await statSessionFile(source.path)
    if (!stat.ok) {
      errors.push(`stat ${shortHomePath(source.path)}: ${stat.reason}`)
      continue
    }
    totalBytes += stat.size
    if (stat.mtime < oldestMs) { oldestMs = stat.mtime; oldestPath = source.path }
    if (stat.mtime > newestMs) { newestMs = stat.mtime; newestPath = source.path }
  }

  return {
    name: provider.name,
    displayName: provider.displayName,
    sessionCount,
    oldestSession: oldestPath ? `${shortHomePath(oldestPath)} (${new Date(oldestMs).toISOString()})` : null,
    newestSession: newestPath ? `${shortHomePath(newestPath)} (${new Date(newestMs).toISOString()})` : null,
    totalBytes,
    errors,
    durationMs: Date.now() - start,
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export async function runDiagnose(opts: { json?: boolean } = {}): Promise<void> {
  process.env.CODEBURN_VERBOSE = '1'

  const providers = await getAllProviders()
  const reports = await Promise.all(providers.map(reportProvider))

  if (opts.json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      providers: reports,
    }, null, 2))
    return
  }

  console.log('codeburn diagnose')
  console.log('────────────────────────────────────────')
  console.log('Provider                Sessions     Size    Time')
  console.log('────────────────────────────────────────')
  for (const r of reports) {
    const status = r.errors.length === 0 ? '✓' : '⚠'
    const name = r.displayName.padEnd(20)
    const sessions = String(r.sessionCount).padStart(7)
    const size = formatBytes(r.totalBytes).padStart(8)
    const time = `${r.durationMs}ms`.padStart(6)
    console.log(`${status} ${name} ${sessions}  ${size}  ${time}`)
  }
  console.log('────────────────────────────────────────')

  for (const r of reports) {
    if (r.errors.length === 0 && r.sessionCount === 0) continue
    if (r.errors.length === 0) continue
    console.log(`\n  ${r.displayName} issues:`)
    for (const err of r.errors.slice(0, 10)) {
      console.log(`    ${err}`)
    }
    if (r.errors.length > 10) console.log(`    ... and ${r.errors.length - 10} more`)
  }

  const totalSessions = reports.reduce((s: number, r: ProviderReport) => s + r.sessionCount, 0)
  const totalBytes = reports.reduce((s: number, r: ProviderReport) => s + r.totalBytes, 0)
  console.log(`\n  Total: ${totalSessions} sessions across ${reports.length} providers, ${formatBytes(totalBytes)} on disk.`)
  console.log(`  Run with --json for machine-readable output, or --period to scope.`)
}
