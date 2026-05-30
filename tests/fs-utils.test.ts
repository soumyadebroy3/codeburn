import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_SESSION_FILE_BYTES,
  STREAM_THRESHOLD_BYTES,
  readSessionFile,
  readSessionLines,
} from '../src/fs-utils.js'

describe('readSessionFile', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    delete process.env.CODEBURN_VERBOSE
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) await rm(d, { recursive: true, force: true })
    }
  })

  async function tmpPath(content: string | Buffer): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'codeburn-fs-'))
    tmpDirs.push(base)
    const p = join(base, 'x.jsonl')
    await writeFile(p, content)
    return p
  }

  it('returns content for small files via readFile fast path', async () => {
    const p = await tmpPath('hello\nworld\n')
    expect(await readSessionFile(p)).toBe('hello\nworld\n')
  })

  it('returns content for files at the stream threshold via stream path', async () => {
    const p = await tmpPath(Buffer.alloc(STREAM_THRESHOLD_BYTES, 'a'))
    const got = await readSessionFile(p)
    expect(got).not.toBeNull()
    expect(got!.length).toBe(STREAM_THRESHOLD_BYTES)
  })

  it('returns null and skips files over the cap', async () => {
    const p = await tmpPath(Buffer.alloc(MAX_SESSION_FILE_BYTES + 1, 'b'))
    expect(await readSessionFile(p)).toBeNull()
  })

  it('emits stderr warning under CODEBURN_VERBOSE=1 for skipped file', async () => {
    process.env.CODEBURN_VERBOSE = '1'
    const p = await tmpPath(Buffer.alloc(MAX_SESSION_FILE_BYTES + 1, 'c'))
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await readSessionFile(p)
    expect(spy).toHaveBeenCalled()
    const msg = (spy.mock.calls[0][0] as string)
    expect(msg).toContain('codeburn')
    expect(msg).toContain('oversize')
    spy.mockRestore()
  })

  it('returns null on stat failure without throwing', async () => {
    expect(await readSessionFile('/nonexistent/path/x.jsonl')).toBeNull()
  })
})

describe('readSessionLines', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) await rm(d, { recursive: true, force: true })
    }
  })

  async function tmpPath(content: string): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'codeburn-lines-'))
    tmpDirs.push(base)
    const p = join(base, 'session.jsonl')
    await writeFile(p, content)
    return p
  }

  it('yields all lines from a file', async () => {
    const p = await tmpPath('line1\nline2\nline3\n')
    const lines: string[] = []
    for await (const line of readSessionLines(p)) lines.push(line)
    expect(lines).toEqual(['line1', 'line2', 'line3'])
  })

  it('does not leak file descriptors when generator is abandoned early', async () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n')
    const p = await tmpPath(content)
    const gen = readSessionLines(p)
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(first.value).toBe('line-0')
    // Abandoning the generator must close the underlying fd. If it didn't,
    // the surrounding test process would eventually exhaust file descriptors;
    // we can't directly probe rlimit but a clean .return() resolving without
    // throwing is the contract.
    const closed = await gen.return(undefined)
    expect(closed.done).toBe(true)
  })

  it('re-throws on a mid-stream read failure so callers can skip partial data', async () => {
    // A directory passes the stat size-guard but errors (EISDIR) once the
    // stream starts reading. That mid-stream failure must surface rather than
    // be swallowed as a clean EOF — otherwise callers cache truncated data.
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-lines-dir-'))
    tmpDirs.push(dir)
    await expect((async () => {
      const out: string[] = []
      for await (const line of readSessionLines(dir)) out.push(line)
      return out
    })()).rejects.toThrow()
  })

  it('stays silent (no throw, no lines) when the file does not exist', async () => {
    const missing = join(tmpdir(), 'codeburn-does-not-exist-xyz-123.jsonl')
    const lines: string[] = []
    for await (const line of readSessionLines(missing)) lines.push(line)
    expect(lines).toEqual([])
  })

  it('handles a trailing line without a final newline', async () => {
    const p = await tmpPath('first\nlast-no-newline')
    const lines: string[] = []
    for await (const line of readSessionLines(p)) lines.push(line)
    expect(lines).toEqual(['first', 'last-no-newline'])
  })

  it('preserves embedded UTF-8 bytes that span chunk boundaries', async () => {
    // 🔥 = F0 9F 94 A5 (4 bytes). With Buffer-based scanning, a multi-byte
    // codepoint that lands across an internal chunk boundary must still
    // decode correctly when we eventually toString('utf-8').
    const p = await tmpPath('codeburn 🔥 hits hot path\n')
    const lines: string[] = []
    for await (const line of readSessionLines(p)) lines.push(line)
    expect(lines).toEqual(['codeburn 🔥 hits hot path'])
  })

  it('yields a 5 MB single-line payload without OOM', async () => {
    // Regression test for the OOM that prompted the buffer-based scanner.
    // 5 MB is well below the prior failure threshold (~100 MB) but big
    // enough to exercise the chunk-concat path.
    const big = 'x'.repeat(5 * 1024 * 1024)
    const p = await tmpPath(big + '\n')
    let yielded = 0
    let observedLen = 0
    for await (const line of readSessionLines(p)) {
      yielded++
      observedLen = line.length
    }
    expect(yielded).toBe(1)
    expect(observedLen).toBe(5 * 1024 * 1024)
  })
})
