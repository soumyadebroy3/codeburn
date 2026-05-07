/**
 * `--redact-paths` support. Replaces absolute project paths in JSON output
 * with stable per-machine hashes so a user can share `codeburn report --format json
 * --redact-paths` output without leaking their directory layout.
 *
 * The salt lives in ~/.cache/codeburn/redact-salt and is generated lazily on
 * first use. Different machines produce different hashes for the same path
 * (intentional — prevents cross-machine correlation).
 */

import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'

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
  const dir = process.env.CODEBURN_CACHE_DIR ?? join(homedir(), '.cache', 'codeburn')
  await mkdir(dir, { recursive: true })
  cachedSalt = randomBytes(32).toString('hex')
  await writeFile(path, cachedSalt, { encoding: 'utf-8', mode: 0o600 })
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
