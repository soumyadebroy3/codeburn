import { open as openAsync, stat } from 'node:fs/promises'
import { openSync, closeSync, fstatSync, readFileSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

// Hard cap well below V8's 512 MB string limit even with split('\n') doubling.
// Stream threshold chosen as empirical breakeven between readFile+split peak
// memory and createReadStream+readline overhead for typical session files.
export const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024
export const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024

// Line-by-line streaming has bounded memory (one line at a time) and is not
// constrained by V8's string limit, so it can safely handle multi-GB session
// files. The cap here is purely a sanity check against pathological inputs;
// real Codex sessions for heavy users have been observed at 250+ MB and will
// continue to grow as context windows expand.
export const MAX_STREAM_SESSION_FILE_BYTES = 2 * 1024 * 1024 * 1024

function verbose(): boolean {
  return process.env.CODEBURN_VERBOSE === '1'
}

export function warn(msg: string): void {
  if (verbose()) process.stderr.write(`codeburn: ${msg}\n`)
}

// Open + fstat + read on the SAME file descriptor closes the TOCTOU window
// where stat() and the subsequent read could see different inodes (a swap
// between a small regular file and a 2 GB FIFO, for example). The handle
// guarantees we read exactly the file we sized.
export async function readSessionFile(filePath: string): Promise<string | null> {
  let handle
  try {
    handle = await openAsync(filePath, 'r')
  } catch (err) {
    warn(`open failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  }
  try {
    const s = await handle.stat()
    if (s.size > MAX_SESSION_FILE_BYTES) {
      warn(`skipped oversize file ${filePath} (${s.size} bytes > cap ${MAX_SESSION_FILE_BYTES})`)
      return null
    }
    if (s.size >= STREAM_THRESHOLD_BYTES) {
      // Use the FileHandle's own createReadStream so fd ownership is clean
      // (no double-close on GC). The stream takes ownership and the handle
      // is closed by the stream when it ends.
      const stream = handle.createReadStream({ encoding: 'utf-8' })
      handle = undefined // ownership transferred
      const chunks: string[] = []
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of rl) chunks.push(line)
      } finally {
        stream.destroy()
      }
      return chunks.join('\n')
    }
    const buf = await handle.readFile()
    return buf.toString('utf-8')
  } catch (err) {
    warn(`read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  } finally {
    if (handle) {
      try { await handle.close() } catch { /* ignore */ }
    }
  }
}

export function readSessionFileSync(filePath: string): string | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch (err) {
    warn(`open failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  }
  try {
    const size = fstatSync(fd).size
    if (size > MAX_SESSION_FILE_BYTES) {
      warn(`skipped oversize file ${filePath} (${size} bytes > cap ${MAX_SESSION_FILE_BYTES})`)
      return null
    }
    return readFileSync(fd, 'utf-8')
  } catch (err) {
    warn(`read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return null
  } finally {
    try { closeSync(fd) } catch { /* ignore */ }
  }
}

/// Buffer-based newline scanner. Replaces the old readline path so a
/// pathologically long line (100 MB+) doesn't build a ConsString tree that
/// V8 can't flatten without exceeding heap. Scans raw Bytes with
/// Buffer.indexOf(0x0a) and only allocates a string at yield time. Adapted
/// from upstream PR (OOM fix); fork keeps the security-conscious cap and
/// graceful-warn-on-failure contract.
export async function* readSessionLines(filePath: string): AsyncGenerator<string> {
  let size: number
  try {
    size = (await stat(filePath)).size
  } catch (err) {
    warn(`stat failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return
  }
  if (size > MAX_STREAM_SESSION_FILE_BYTES) {
    warn(`skipped oversize file ${filePath} (${size} bytes > stream cap ${MAX_STREAM_SESSION_FILE_BYTES})`)
    return
  }

  const stream = createReadStream(filePath)
  // `parts` accumulates Buffer slices for an in-progress line. Concat
  // happens once per complete line, so total resident memory tracks the
  // longest single line — not the whole file as ConsString trees did.
  let parts: Buffer[] = []
  let len = 0

  try {
    for await (const raw of stream) {
      const chunk = raw as Buffer
      let pos = 0
      while (pos < chunk.length) {
        const nl = chunk.indexOf(0x0a, pos)
        if (nl !== -1) {
          if (pos < nl) {
            parts.push(chunk.subarray(pos, nl))
            len += nl - pos
          }
          pos = nl + 1
          if (len === 0) {
            // Empty line — yield empty string to preserve the old readline
            // contract for consumers that count line numbers.
            yield ''
            continue
          }
          const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, len)
          parts = []
          len = 0
          // toString('utf-8') replaces invalid byte sequences with U+FFFD
          // — same behavior as our node:sqlite UTF-8 hardening (#272).
          yield buf.toString('utf-8')
        } else {
          const slice = chunk.subarray(pos)
          parts.push(slice)
          len += slice.length
          pos = chunk.length
        }
      }
    }
    // Trailing line with no final newline.
    if (len > 0) {
      const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts, len)
      yield buf.toString('utf-8')
    }
  } catch (err) {
    warn(`stream read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
  } finally {
    stream.destroy()
  }
}
