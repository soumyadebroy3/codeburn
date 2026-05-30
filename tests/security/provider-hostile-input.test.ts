import { describe, it, expect, afterAll } from 'vitest'
import { createOpenClawProvider } from '../../src/providers/openclaw.js'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Regression coverage for the untrusted-session-data hardening: provider
// parsers must not throw on schema-drifted / hostile input (which, because the
// parser.ts source loop has no per-source catch, would otherwise abort analysis
// for every provider), must not be tricked by a `__proto__` tool name, and must
// not let string/NaN token fields corrupt aggregate totals.

const baseDir = join(tmpdir(), `codeburn-hostile-${Date.now()}`)

async function setup(dir: string, agent: string, sessionId: string, lines: string[]): Promise<void> {
  const sessionsDir = join(dir, agent, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(join(sessionsDir, `${sessionId}.jsonl`), lines.join('\n'))
}

async function parseAll(dir: string): Promise<any[]> {
  const provider = createOpenClawProvider(dir)
  const sources = await provider.discoverSessions()
  const calls: any[] = []
  for (const source of sources) {
    const parser = provider.createSessionParser(source, new Set())
    for await (const call of parser.parse()) calls.push(call)
  }
  return calls
}

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('openclaw parser — hostile / malformed input', () => {
  it('does not throw when an assistant message.content is a non-array', async () => {
    const dir = join(baseDir, 'nonarray-content')
    await setup(dir, 'proj', 's1', [
      JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-04-20T10:00:00.000Z', cwd: '/tmp' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:03.000Z',
        message: {
          role: 'assistant', model: 'claude-sonnet-4-6',
          content: { not: 'an array' },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        },
      }),
    ])
    const calls = await parseAll(dir)
    expect(calls).toHaveLength(1)
    expect(calls[0].tools).toEqual([])
  })

  it('keeps a "__proto__" tool name as a plain string and never pollutes Object.prototype', async () => {
    const dir = join(baseDir, 'proto')
    await setup(dir, 'proj', 's1', [
      JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-04-20T10:00:00.000Z', cwd: '/tmp' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:03.000Z',
        message: {
          role: 'assistant', model: 'claude-sonnet-4-6',
          content: [
            { type: 'toolCall', name: '__proto__', arguments: {} },
            { type: 'toolCall', name: 'constructor', arguments: {} },
          ],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        },
      }),
    ])
    const calls = await parseAll(dir)
    expect(calls).toHaveLength(1)
    // Tool names are plain strings, not the inherited prototype member.
    for (const t of calls[0].tools) expect(typeof t).toBe('string')
    // No prototype pollution leaked anywhere.
    expect(({} as any).polluted).toBeUndefined()
    expect((Object.prototype as any).polluted).toBeUndefined()
  })

  it('coerces string / NaN token fields to finite numbers instead of corrupting totals', async () => {
    const dir = join(baseDir, 'bad-tokens')
    await setup(dir, 'proj', 's1', [
      JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-04-20T10:00:00.000Z', cwd: '/tmp' }),
      JSON.stringify({
        type: 'message', id: 'a1', timestamp: '2026-04-20T10:00:03.000Z',
        message: {
          role: 'assistant', model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input: '500', output: null, cacheRead: -10, cacheWrite: 50, totalTokens: 0 },
        },
      }),
    ])
    const calls = await parseAll(dir)
    expect(calls).toHaveLength(1)
    const c = calls[0]
    for (const v of [c.inputTokens, c.outputTokens, c.cacheReadInputTokens, c.cacheCreationInputTokens]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
    expect(c.inputTokens).toBe(0)   // "500" string → 0, not concatenated
    expect(c.outputTokens).toBe(0)  // null → 0
    expect(c.cacheReadInputTokens).toBe(0) // negative → 0
    expect(c.cacheCreationInputTokens).toBe(50)
  })
})
