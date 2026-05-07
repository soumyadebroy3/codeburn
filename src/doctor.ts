/**
 * `codeburn doctor` — verifies the runtime environment is sane. Catches
 * common foot-guns upfront: stale Node version, world-readable cache,
 * missing optional providers, etc. Returns non-zero exit when any check
 * is "fail"; "warn" is non-fatal but printed.
 */

import { stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

type CheckStatus = 'pass' | 'warn' | 'fail'
type Check = { name: string; status: CheckStatus; detail: string }

const MIN_NODE_MAJOR = 22

function nodeMajor(): number {
  const m = process.versions.node.match(/^(\d+)/)
  return m ? parseInt(m[1], 10) : 0
}

async function checkNode(): Promise<Check> {
  const major = nodeMajor()
  if (major >= MIN_NODE_MAJOR) {
    return { name: 'Node.js version', status: 'pass', detail: `v${process.versions.node} (≥${MIN_NODE_MAJOR}.x required)` }
  }
  return { name: 'Node.js version', status: 'fail', detail: `v${process.versions.node} — codeburn requires Node ${MIN_NODE_MAJOR}+ for node:sqlite (Cursor/OpenCode/Goose providers).` }
}

async function checkCachePermissions(): Promise<Check> {
  const dir = process.env.CODEBURN_CACHE_DIR ?? join(homedir(), '.cache', 'codeburn')
  let s
  try {
    s = await stat(dir)
  } catch {
    return { name: 'Cache directory', status: 'pass', detail: `${dir} (does not exist yet — created on first run)` }
  }
  // POSIX mode bits. Anything wider than 0o700 (group/other-readable) leaks
  // session-derived data to other local users.
  const mode = s.mode & 0o777
  if (mode === 0o700) {
    return { name: 'Cache directory', status: 'pass', detail: `${dir} (mode 0700)` }
  }
  if (mode === 0o755 || mode === 0o775) {
    return { name: 'Cache directory', status: 'warn', detail: `${dir} is mode 0${mode.toString(8)} — other users on this machine can read your cached cost data. Run \`chmod 700 ${dir}\`.` }
  }
  return { name: 'Cache directory', status: 'warn', detail: `${dir} mode 0${mode.toString(8)} (expected 0700)` }
}

async function checkAtLeastOneProvider(): Promise<Check> {
  const { getAllProviders } = await import('./providers/index.js')
  const providers = await getAllProviders()
  let any = false
  for (const p of providers) {
    try {
      const sources = await p.discoverSessions()
      if (sources.length > 0) { any = true; break }
    } catch { /* keep trying */ }
  }
  if (any) return { name: 'AI tool sessions', status: 'pass', detail: 'at least one provider has session data on disk' }
  return {
    name: 'AI tool sessions',
    status: 'warn',
    detail: 'no provider returned any sessions. Run `codeburn diagnose` to see why.',
  }
}

async function checkSqliteAvailable(): Promise<Check> {
  // Use createRequire so the bundler doesn't try to inline node:sqlite.
  // node:sqlite is "experimental" in Node 22 (no flag in 22.5+) and stable
  // in Node 24.
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  try {
    req('node:sqlite')
    return { name: 'SQLite (Cursor/OpenCode/Goose)', status: 'pass', detail: 'node:sqlite available' }
  } catch (e) {
    return {
      name: 'SQLite (Cursor/OpenCode/Goose)',
      status: 'warn',
      detail: `node:sqlite import failed (${(e as Error).message ?? 'unknown'}). Cursor / OpenCode / Goose providers are unavailable.`,
    }
  }
}

const SYMBOL: Record<CheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' }

export async function runDoctor(opts: { json?: boolean } = {}): Promise<number> {
  const checks: Check[] = []
  checks.push(await checkNode())
  checks.push(await checkCachePermissions())
  checks.push(await checkSqliteAvailable())
  checks.push(await checkAtLeastOneProvider())

  if (opts.json) {
    console.log(JSON.stringify({ schemaVersion: 1, checks }, null, 2))
  } else {
    console.log('codeburn doctor')
    console.log('────────────────────────────────────────')
    for (const c of checks) {
      console.log(`${SYMBOL[c.status]} ${c.name}`)
      console.log(`    ${c.detail}`)
    }
    const failed = checks.filter(c => c.status === 'fail').length
    const warned = checks.filter(c => c.status === 'warn').length
    console.log('────────────────────────────────────────')
    if (failed) console.log(`${failed} failure(s), ${warned} warning(s).`)
    else if (warned) console.log(`${warned} warning(s) — codeburn will run but may not see all providers.`)
    else console.log('All checks pass.')
  }

  return checks.some(c => c.status === 'fail') ? 1 : 0
}
