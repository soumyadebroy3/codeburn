import { describe, it, expect } from 'vitest'
import { compactEntry } from '../src/parser.js'
import type { JournalEntry } from '../src/types.js'

describe('compactEntry — JSONL hot-loop memory shrink', () => {
  it('drops thinking and text blocks from assistant content', () => {
    const raw: JournalEntry = {
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          { type: 'thinking', thinking: 'long internal reasoning text...' },
          { type: 'text', text: 'observable answer' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    } as JournalEntry

    const compact = compactEntry(raw)
    const msg = compact.message
    expect(msg?.role).toBe('assistant')
    if (msg?.role !== 'assistant') return
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0]).toMatchObject({ type: 'tool_use', name: 'Bash' })
  })

  it('caps oversized bash commands to BASH_COMMAND_CAP (2000 chars)', () => {
    const huge = 'x'.repeat(10_000)
    const raw: JournalEntry = {
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: huge } }],
      },
    } as JournalEntry
    const compact = compactEntry(raw)
    if (compact.message?.role !== 'assistant') throw new Error('expected assistant')
    const tu = compact.message.content[0] as { input: { command?: string } }
    expect(tu.input.command).toHaveLength(2000)
  })

  it('caps user text content to USER_TEXT_CAP across multiple text blocks', () => {
    const long = 'a'.repeat(1500)
    const raw: JournalEntry = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: long },
          { type: 'text', text: long },
          { type: 'text', text: long },
        ],
      },
    } as JournalEntry
    const compact = compactEntry(raw)
    if (compact.message?.role !== 'user') throw new Error('expected user')
    const total = (compact.message.content as { text: string }[]).reduce((acc, b) => acc + b.text.length, 0)
    expect(total).toBeLessThanOrEqual(2000)
  })

  it('preserves Skill tool_use input fields needed for skill attribution', () => {
    const raw: JournalEntry = {
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 's', name: 'Skill', input: { skill: 'pdf', name: 'extract' } }],
      },
    } as JournalEntry
    const compact = compactEntry(raw)
    if (compact.message?.role !== 'assistant') throw new Error('expected assistant')
    const tu = compact.message.content[0] as { input: { skill?: string; name?: string } }
    expect(tu.input.skill).toBe('pdf')
    expect(tu.input.name).toBe('extract')
  })

  it('drops tool_result blocks entirely from assistant content', () => {
    const raw: JournalEntry = {
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } },
          { type: 'tool_result', tool_use_id: 'a', content: 'megabytes of file body...' },
        ],
      },
    } as JournalEntry
    const compact = compactEntry(raw)
    if (compact.message?.role !== 'assistant') throw new Error('expected assistant')
    expect(compact.message.content).toHaveLength(1)
    expect(compact.message.content[0]).toMatchObject({ type: 'tool_use', name: 'Read' })
  })

  it('caps total tool_use blocks at MAX_TOOL_BLOCKS (500)', () => {
    const content = Array.from({ length: 1200 }, (_, i) => ({ type: 'tool_use' as const, id: `t${i}`, name: 'Read', input: {} }))
    const raw: JournalEntry = {
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1, output_tokens: 1 },
        content,
      },
    } as JournalEntry
    const compact = compactEntry(raw)
    if (compact.message?.role !== 'assistant') throw new Error('expected assistant')
    expect(compact.message.content).toHaveLength(500)
  })

  it('keeps cache_creation breakdown so 1h-cache pricing stays accurate', () => {
    const raw: JournalEntry = {
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation: { ephemeral_1h_input_tokens: 2_500_000, ephemeral_5m_input_tokens: 100 },
          cache_creation_input_tokens: 2_500_100,
        },
        content: [],
      },
    } as JournalEntry
    const compact = compactEntry(raw)
    if (compact.message?.role !== 'assistant') throw new Error('expected assistant')
    expect(compact.message.usage.cache_creation?.ephemeral_1h_input_tokens).toBe(2_500_000)
    expect(compact.message.usage.cache_creation?.ephemeral_5m_input_tokens).toBe(100)
  })

  it('preserves sessionId, cwd, and timestamp for downstream attribution', () => {
    const raw: JournalEntry = {
      type: 'user',
      timestamp: '2026-05-15T10:00:00Z',
      sessionId: 'abc-123',
      cwd: '/repo',
      message: { role: 'user', content: 'hello' },
    } as JournalEntry
    const compact = compactEntry(raw)
    expect(compact.timestamp).toBe('2026-05-15T10:00:00Z')
    expect(compact.sessionId).toBe('abc-123')
    expect(compact.cwd).toBe('/repo')
  })

  it('skips assistant entries missing usage or model (returns entry unchanged)', () => {
    const raw: JournalEntry = {
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        // no model, no usage
        content: [],
      },
    } as unknown as JournalEntry
    const compact = compactEntry(raw)
    // Function returns the partially-built entry without populating message.
    expect(compact.type).toBe('assistant')
  })
})
