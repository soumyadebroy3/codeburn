/**
 * `--redact-paths` support. Replaces absolute project paths in JSON output
 * with stable per-machine hashes so a user can share `codeburn report --format json
 * --redact-paths` output without leaking their directory layout.
 *
 * The salt lives in ~/.cache/codeburn/redact-salt and is generated lazily on
 * first use. Different machines produce different hashes for the same path
 * (intentional — prevents cross-machine correlation).
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

let cachedSalt: string | null = null

function saltPath(): string {
  const dir = process.env.CODEBURN_CACHE_DIR ?? join(homedir(), '.cache', 'codeburn')
  return join(dir, 'redact-salt')
}

async function loadSalt(): Promise<string> {
  if (cachedSalt) return cachedSalt
  const path = saltPath()
  if (existsSync(path)) {
    cachedSalt = (await readFile(path, 'utf-8')).trim()
    if (cachedSalt) return cachedSalt
  }
  // Race-safe write: stage to a per-process temp file, then atomically
  // rename onto the final path. If two CLI invocations both find the salt
  // missing and both call randomBytes(32), the rename is the serialisation
  // point — second-to-finish loses, both processes re-read the surviving
  // salt afterwards. Without this, both processes would end up using
  // different in-memory salts and produce diverging hashes for the same
  // path within their respective runs.
  const dir = process.env.CODEBURN_CACHE_DIR ?? join(homedir(), '.cache', 'codeburn')
  await mkdir(dir, { recursive: true })
  const proposed = randomBytes(32).toString('hex')
  const tempPath = `${path}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tempPath, proposed, { encoding: 'utf-8', mode: 0o600 })
    await rename(tempPath, path)
  } catch {
    try { await unlink(tempPath) } catch { /* cleanup */ }
  }
  // Re-read whichever process won the rename race so all participants
  // converge on the same salt within this CLI run AND across overlapping
  // runs.
  if (existsSync(path)) {
    cachedSalt = (await readFile(path, 'utf-8')).trim()
    if (cachedSalt) return cachedSalt
  }
  cachedSalt = proposed
  return cachedSalt
}

export async function redactPath(absPath: string | null | undefined): Promise<string | null> {
  if (!absPath) return null
  const salt = await loadSalt()
  const h = createHash('sha256').update(salt).update(absPath).digest('hex').slice(0, 12)
  return `path:${h}`
}

/**
 * Walk an arbitrary JSON-serializable value and replace any string field
 * named `projectPath` (or matching home-rooted absolute paths) with a
 * salted hash. Mutates the input in place for efficiency.
 */
export async function redactInPlace(value: unknown): Promise<void> {
  const salt = await loadSalt()
  function hash(s: string): string {
    return 'path:' + createHash('sha256').update(salt).update(s).digest('hex').slice(0, 12)
  }
  function looksLikePath(s: string): boolean {
    if (s.startsWith('/Users/') || s.startsWith('/home/')) return true
    if (/^[A-Za-z]:\\/.test(s)) return true   // Windows
    if (s.startsWith(homedir())) return true
    return false
  }
  function walk(v: unknown): void {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item = v[i]
        if (typeof item === 'string' && looksLikePath(item)) v[i] = hash(item)
        else walk(item)
      }
      return
    }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      for (const key of Object.keys(obj)) {
        const child = obj[key]
        if (typeof child === 'string' && (key === 'projectPath' || key === 'cwd' || key === 'path' || looksLikePath(child))) {
          obj[key] = hash(child)
        } else {
          walk(child)
        }
      }
    }
  }
  walk(value)
}
