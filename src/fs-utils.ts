import { open as openAsync } from 'fs/promises'
import { openSync, closeSync, fstatSync, readFileSync } from 'fs'
import { createInterface } from 'readline'

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

export async function* readSessionLines(filePath: string): AsyncGenerator<string> {
  let handle
  try {
    handle = await openAsync(filePath, 'r')
  } catch (err) {
    warn(`open failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    return
  }
  try {
    const s = await handle.stat()
    if (s.size > MAX_STREAM_SESSION_FILE_BYTES) {
      warn(`skipped oversize file ${filePath} (${s.size} bytes > stream cap ${MAX_STREAM_SESSION_FILE_BYTES})`)
      return
    }
    const stream = handle.createReadStream({ encoding: 'utf-8' })
    const ownedHandle = handle
    handle = undefined // stream now owns the fd
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) yield line
    } catch (err) {
      warn(`stream read failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
    } finally {
      stream.destroy()
      // createReadStream({autoClose:true}) closes the fd when stream ends/errors,
      // but if the consumer abandons the generator early the FileHandle's GC
      // close is what runs. Explicitly close here to avoid the deprecation.
      try { await ownedHandle.close() } catch { /* fd may already be closed by stream */ }
    }
  } catch (err) {
    warn(`stat failed for ${filePath}: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}`)
  } finally {
    if (handle) {
      try { await handle.close() } catch { /* ignore */ }
    }
  }
}
