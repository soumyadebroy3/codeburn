import { readFile, mkdir, stat, open, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'

import type { ParsedProviderCall } from './providers/types.js'

const CODEX_CACHE_VERSION = 2
const CACHE_FILE = 'codex-results.json'
const FINGERPRINT_BYTES = 256

type FileFingerprint = { mtimeMs: number; sizeBytes: number; headHash: string }

type FileEntry = {
  mtimeMs: number
  sizeBytes: number
  headHash: string
  project: string
  calls: ParsedProviderCall[]
}

type ResultCache = {
  version: number
  files: Record<string, FileEntry>
}

function getCacheDir(): string {
  return process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILE)
}

let memCache: ResultCache | null = null

async function loadCache(): Promise<ResultCache> {
  if (memCache) return memCache
  try {
    const raw = await readFile(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as ResultCache
    if (cache.version === CODEX_CACHE_VERSION && cache.files && typeof cache.files === 'object') {
      // Wipe any prototype-pollution attempt in the loaded cache.
      const safeFiles: Record<string, FileEntry> = Object.create(null) as Record<string, FileEntry>
      for (const [k, v] of Object.entries(cache.files)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
        safeFiles[k] = v
      }
      memCache = { version: CODEX_CACHE_VERSION, files: safeFiles }
      return memCache
    }
  } catch {}
  memCache = { version: CODEX_CACHE_VERSION, files: Object.create(null) as Record<string, FileEntry> }
  return memCache
}

function fingerprintMatches(entry: FileEntry, fp: FileFingerprint): boolean {
  return entry.mtimeMs === fp.mtimeMs
    && entry.sizeBytes === fp.sizeBytes
    && entry.headHash === fp.headHash
}

function getEntry(cache: ResultCache, filePath: string, fp: FileFingerprint): FileEntry | null {
  if (!Object.hasOwn(cache.files, filePath)) return null
  const entry = cache.files[filePath]
  if (entry && fingerprintMatches(entry, fp)) return entry
  return null
}

async function hashHead(filePath: string, sizeBytes: number): Promise<string> {
  // Hash the first FINGERPRINT_BYTES of the file. Defends against
  // truncate-then-rewrite at the same final size and the same mtime
  // (1 ms granularity collisions on fast writers) returning stale cached
  // results.
  const handle = await open(filePath, 'r')
  try {
    const len = Math.min(FINGERPRINT_BYTES, sizeBytes)
    const buf = Buffer.alloc(len)
    if (len > 0) await handle.read(buf, 0, len, 0)
    return createHash('sha256').update(buf).digest('hex').slice(0, 16)
  } finally {
    await handle.close()
  }
}

export async function readCachedCodexResults(
  filePath: string,
): Promise<ParsedProviderCall[] | null> {
  try {
    const fp = await fingerprintFile(filePath)
    if (!fp) return null
    const cache = await loadCache()
    const entry = getEntry(cache, filePath, fp)
    return entry?.calls ?? null
  } catch {}
  return null
}

export async function getCachedCodexProject(
  filePath: string,
): Promise<string | null> {
  try {
    const fp = await fingerprintFile(filePath)
    if (!fp) return null
    const cache = await loadCache()
    const entry = getEntry(cache, filePath, fp)
    return entry?.project ?? null
  } catch {}
  return null
}

export async function fingerprintFile(
  filePath: string,
): Promise<FileFingerprint | null> {
  try {
    const s = await stat(filePath)
    const headHash = await hashHead(filePath, s.size)
    return { mtimeMs: s.mtimeMs, sizeBytes: s.size, headHash }
  } catch {
    return null
  }
}

export async function writeCachedCodexResults(
  filePath: string,
  project: string,
  calls: ParsedProviderCall[],
  fingerprint: FileFingerprint,
): Promise<void> {
  try {
    const cache = await loadCache()
    cache.files[filePath] = {
      mtimeMs: fingerprint.mtimeMs,
      sizeBytes: fingerprint.sizeBytes,
      headHash: fingerprint.headHash,
      project,
      calls,
    }
  } catch {}
}

export async function flushCodexCache(): Promise<void> {
  if (!memCache) return
  try {
    const paths = Object.keys(memCache.files)
    for (const p of paths) {
      try {
        await stat(p)
      } catch {
        delete memCache.files[p]
      }
    }

    const dir = getCacheDir()
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    const finalPath = getCachePath()
    const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
    const payload = JSON.stringify(memCache)
    const handle = await open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(payload, { encoding: 'utf-8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tempPath, finalPath)
    } catch (err) {
      try { await unlink(tempPath) } catch {}
      throw err
    }
  } catch {}
}
