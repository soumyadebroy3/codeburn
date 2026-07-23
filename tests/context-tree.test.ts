import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  add,
  buildContextTree,
  estimateTokens,
  lineToText,
  newAcc,
  relativeAge,
  snapshot,
  snapshotRows,
  IMAGE_TOKEN_FALLBACK,
  type SessionRef,
} from '../src/context-tree.js'
import { buildCodexContextTree } from '../src/context-tree-codex.js'

function writeSession(lines: unknown[]): SessionRef {
  const dir = mkdtempSync(join(tmpdir(), 'codeburn-ctx-'))
  const filePath = join(dir, 'session.jsonl')
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { filePath, sessionId: 'session', project: 'proj', mtimeMs: Date.now(), sizeBytes: 0 }
}

describe('context-tree pure helpers', () => {
  it('estimateTokens is chars/4 rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('add increments count and tokens', () => {
    const stat = { count: 0, tokens: 0 }
    add(stat, 10)
    add(stat, 5)
    expect(stat).toEqual({ count: 2, tokens: 15 })
  })

  it('lineToText passes strings through', () => {
    expect(lineToText('{"a":1}')).toBe('{"a":1}')
  })

  it('relativeAge buckets by minutes/hours/days', () => {
    const now = Date.now()
    expect(relativeAge(now)).toBe('0m ago')
    expect(relativeAge(now - 5 * 60_000)).toBe('5m ago')
    expect(relativeAge(now - 3 * 3_600_000)).toBe('3h ago')
    expect(relativeAge(now - 2 * 86_400_000)).toBe('2d ago')
  })

  it('snapshotRows omits empty optional rows and keeps role headers', () => {
    const acc = newAcc()
    add(acc.assistantText, 100)
    acc.assistantCount = 1
    add(acc.userText, 40)
    acc.userCount = 1
    const rows = snapshotRows(snapshot(acc))
    const labels = rows.map((r) => r.label)
    expect(labels).toContain('assistant')
    expect(labels).toContain('user')
    // No image / reasoning / compact-summary rows since those buckets are empty.
    expect(labels).not.toContain('image')
    expect(labels).not.toContain('reasoning')
    expect(labels).not.toContain('compact-summary')
  })

  it('snapshot sums role totals', () => {
    const acc = newAcc()
    add(acc.assistantText, 100)
    add(acc.toolCall, 20)
    add(acc.userText, 40)
    add(acc.toolResult, 8)
    const snap = snapshot(acc)
    expect(snap.assistant.tokens).toBe(120)
    expect(snap.user.tokens).toBe(40)
    expect(snap.tokens).toBe(168)
  })
})

describe('buildContextTree (Claude)', () => {
  it('accumulates assistant text, tool calls, user text and reported usage', async () => {
    const ref = writeSession([
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [
            { type: 'text', text: 'hello world response' },
            { type: 'tool_use', name: 'Read', input: { file: 'x.ts' } },
          ],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 2000 },
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: 'a user question here' }] },
      },
    ])
    const result = await buildContextTree(ref)
    expect(result.model).toBe('claude-sonnet-4')
    expect(result.full.assistant.count).toBe(1)
    expect(result.full.user.count).toBe(1)
    expect(result.full.assistant.text.tokens).toBeGreaterThan(0)
    expect(result.full.assistant.byTool.some((t) => t.tool === 'Read')).toBe(true)
    expect(result.reported).not.toBeNull()
    // input + cache_read + output = 3050
    expect(result.reported?.context).toBe(3050)
  })

  it('splits full vs effective around a compact boundary', async () => {
    const ref = writeSession([
      { type: 'user', uuid: 'u0', message: { role: 'user', content: 'before compaction text block' } },
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 5000, preservedSegment: { headUuid: 'u1' } } },
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'after compaction preserved text' } },
    ])
    const result = await buildContextTree(ref)
    expect(result.compactions).toBe(1)
    // full includes both user messages; effective only the preserved one.
    expect(result.full.user.count).toBe(2)
    expect(result.effective.user.count).toBe(1)
    expect(result.full.tokens).toBeGreaterThan(result.effective.tokens)
  })

  it('classifies meta text and images', async () => {
    const ref = writeSession([
      {
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>be nice</system-reminder>' },
            { type: 'image', source: {} },
          ],
        },
      },
    ])
    const result = await buildContextTree(ref)
    expect(result.full.user.meta.count).toBe(1)
    expect(result.full.user.image.count).toBe(1)
    expect(result.full.user.image.tokens).toBe(IMAGE_TOKEN_FALLBACK)
  })

  it('skips sidechain and file-history-snapshot lines', async () => {
    const ref = writeSession([
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'user', uuid: 'u1', isSidechain: true, message: { role: 'user', content: 'sidechain noise' } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'real user message' } },
    ])
    const result = await buildContextTree(ref)
    expect(result.full.user.count).toBe(1)
  })
})

describe('buildCodexContextTree', () => {
  it('walks rollout items and reads token_count usage', async () => {
    const ref = writeSession([
      { type: 'session_meta', payload: { type: 'session_meta', cwd: '/home/x/proj', base_instructions: { text: 'system prompt goes here and here' } } },
      { type: 'turn_context', payload: { type: 'turn_context', model: 'gpt-5-codex' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'implement the feature' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'here is the assistant reply' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { reasoning_output_tokens: 300 },
            last_token_usage: { input_tokens: 1200, output_tokens: 80, total_tokens: 1280 },
            model_context_window: 272_000,
          },
        },
      },
    ])
    const result = await buildCodexContextTree(ref)
    expect(result.model).toBe('gpt-5-codex')
    expect(result.full.assistant.count).toBe(1)
    expect(result.full.user.count).toBe(1)
    expect(result.full.assistant.byTool.some((t) => t.tool === 'shell')).toBe(true)
    expect(result.full.assistant.reasoning.tokens).toBe(300)
    expect(result.full.system.tokens).toBeGreaterThan(0)
    expect(result.reported).toEqual({ context: 1280, window: 272_000 })
  })

  it('resets the live segment on a compaction', async () => {
    const ref = writeSession([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old turn before compaction' }] } },
      { type: 'compacted', payload: { type: 'compacted', message: 'summary of prior work', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'kept after compaction' }] }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'new reply post compaction' }] } },
    ])
    const result = await buildCodexContextTree(ref)
    expect(result.compactions).toBe(1)
    // full has the old user turn + new assistant; effective segment excludes the
    // pre-compaction original but includes replacement history + new items.
    expect(result.full.user.count).toBe(1)
    expect(result.effective.user.count).toBe(1)
    expect(result.effective.user.compactSummary.count).toBe(1)
  })
})
