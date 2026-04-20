import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

import { createTerminalProgressReporter } from '../src/parse-progress.js'

describe('createTerminalProgressReporter', () => {
  it('renders a provider-aware cache bar with global counts', () => {
    const writes: string[] = []
    const stream = {
      isTTY: true,
      columns: 60,
      write: vi.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
    } as unknown as NodeJS.WriteStream

    const reporter = createTerminalProgressReporter(true, stream)
    reporter?.start(1899)
    reporter?.advance('claude')
    reporter?.advance('claude')
    reporter?.finish('claude')

    const text = stripVTControlCharacters(writes.join(''))
    expect(text).toContain('Updating Claude cache')
    expect(text).toContain('2/1899')
    expect(text).toContain('[')
    expect(text).not.toContain('.jsonl')
  })

  it('shrinks the bar on narrow terminals', () => {
    const writes: string[] = []
    const stream = {
      isTTY: true,
      columns: 34,
      write: vi.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
    } as unknown as NodeJS.WriteStream

    const reporter = createTerminalProgressReporter(true, stream)
    reporter?.start(100)
    reporter?.advance('codex')

    const text = stripVTControlCharacters(writes.join(''))
    expect(text).toContain('Updating Codex cache')
    expect(text).toContain('1/100')
    expect(text).toMatch(/\[[█░]{8}\]/)
  })

  it('returns null for non-tty streams', () => {
    const stream = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WriteStream
    expect(createTerminalProgressReporter(true, stream)).toBeNull()
  })

  it('uses stream color depth to configure output styling', () => {
    const writes: string[] = []
    const getColorDepth = vi.fn(() => 8)
    const stream = {
      isTTY: true,
      columns: 80,
      getColorDepth,
      write: vi.fn((chunk: string) => {
        writes.push(chunk)
        return true
      }),
    } as unknown as NodeJS.WriteStream

    const reporter = createTerminalProgressReporter(true, stream)
    reporter?.start(2)
    reporter?.advance('claude')

    expect(getColorDepth).toHaveBeenCalledTimes(1)
    expect(writes.join('')).toContain('Updating')
  })
}) 
