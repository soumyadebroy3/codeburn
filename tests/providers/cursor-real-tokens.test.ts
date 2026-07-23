import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isSqliteAvailable } from '../../src/sqlite.js'
import { getAllProviders } from '../../src/providers/index.js'
import type { Provider, ParsedProviderCall } from '../../src/providers/types.js'

/// Pinned regression for the Cursor real-context-token crediting (fork port of
/// upstream #575's intent). On current Cursor builds the per-bubble tokenCount
/// is {0,0}, so codeburn previously estimated INPUT tokens from the visible
/// bubble text length — a large undercount of the real prompt. The only real
/// input figure on disk is Cursor's own context meter, stored per conversation
/// in composerData.promptTokenBreakdown.totalUsedTokens (or, on older builds,
/// contextTokensUsed). This test asserts that when a conversation has a meter:
///   - the conversation's real context tokens are credited ONCE via a synthetic
///     cursor:composer-input:<conversationId> record;
///   - that record is NOT the per-bubble text estimate (it equals the meter);
///   - the credit is anchored to composerData.createdAt (so daily-cache
///     buckets it deterministically); and
///   - the user bubble's text-length input estimate is suppressed (no
///     double-count of input).
/// It also asserts the fallback path (contextTokensUsed and, when
/// composerData.createdAt is absent, anchoring to the first bubble timestamp),
/// and that conversations WITHOUT a meter keep the old text-estimate behaviour.

const skipReason = isSqliteAvailable()
  ? null
  : 'node:sqlite not available — needs Node 22+; skipping'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cursor-real-tokens-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

type SqliteWriter = {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): unknown }
  close(): void
}

async function openWriter(dbPath: string): Promise<SqliteWriter> {
  const Module = await import('node:module')
  const requireForSqlite = Module.createRequire(import.meta.url)
  const { DatabaseSync } = requireForSqlite('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteWriter
  }
  return new DatabaseSync(dbPath)
}

function bubbleValue(opts: {
  conversationId: string
  text: string
  type: 1 | 2
  createdAt: string
  model?: string
}): string {
  const value: Record<string, unknown> = {
    type: opts.type,
    conversationId: opts.conversationId,
    text: opts.text,
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    createdAt: opts.createdAt,
  }
  if (opts.model) value['modelInfo'] = { modelName: opts.model }
  return JSON.stringify(value)
}

async function getCursorProvider(): Promise<Provider> {
  const all = await getAllProviders()
  const p = all.find(p => p.name === 'cursor')
  if (!p) throw new Error('cursor provider not registered')
  return p
}

async function parseAll(dbPath: string): Promise<ParsedProviderCall[]> {
  const provider = await getCursorProvider()
  const seenKeys = new Set<string>()
  const source = { path: dbPath, project: 'test-project', provider: 'cursor' }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
    calls.push(call)
  }
  return calls
}

/// Build a DB whose bubbles all carry {0,0} token counts (the current Cursor
/// shape) and, for some conversations, a composerData meter row.
async function buildDb(opts: {
  // For a recent createdAt so the 180-day lookback window includes the rows.
  bubbleTs: string
  // conversationId -> { totalUsedTokens?, contextTokensUsed?, createdAtMs? }
  meters: Record<string, { totalUsedTokens?: number; contextTokensUsed?: number; createdAtMs?: number }>
  // conversations that have a user + assistant bubble but (optionally) no meter
  conversations: Array<{ id: string; userText: string; assistantText: string; model?: string }>
}): Promise<string> {
  const dbPath = join(tmpDir, 'state.vscdb')
  await writeFile(dbPath, '')
  const db = await openWriter(dbPath)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')

  for (const conv of opts.conversations) {
    insert.run(
      `bubbleId:${conv.id}:u1`,
      bubbleValue({ conversationId: conv.id, text: conv.userText, type: 1, createdAt: opts.bubbleTs })
    )
    insert.run(
      `bubbleId:${conv.id}:a1`,
      bubbleValue({ conversationId: conv.id, text: conv.assistantText, type: 2, createdAt: opts.bubbleTs, model: conv.model })
    )
  }

  for (const [cid, m] of Object.entries(opts.meters)) {
    const value: Record<string, unknown> = {}
    if (m.totalUsedTokens !== undefined) value['promptTokenBreakdown'] = { totalUsedTokens: m.totalUsedTokens }
    if (m.contextTokensUsed !== undefined) value['contextTokensUsed'] = m.contextTokensUsed
    if (m.createdAtMs !== undefined) value['createdAt'] = m.createdAtMs
    insert.run(`composerData:${cid}`, JSON.stringify(value))
  }

  db.close()
  return dbPath
}

describe.skipIf(skipReason !== null)('cursor real context-token crediting (composer meter)', () => {
  const recentTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  it('credits the real context tokens once from promptTokenBreakdown.totalUsedTokens', async () => {
    const meterCreatedAtMs = Date.parse('2026-05-01T10:00:00.000Z')
    const dbPath = await buildDb({
      bubbleTs: recentTs,
      meters: { conv1: { totalUsedTokens: 168_486, createdAtMs: meterCreatedAtMs } },
      conversations: [{ id: 'conv1', userText: 'hi', assistantText: 'def hello(): pass', model: 'composer-2' }],
    })

    const calls = await parseAll(dbPath)

    const synthetic = calls.filter(c => c.deduplicationKey === 'cursor:composer-input:conv1')
    expect(synthetic).toHaveLength(1)
    const rec = synthetic[0]!

    // Credited the REAL meter tokens, NOT the ~text-length estimate ("hi" would
    // be a single-digit token count).
    expect(rec.inputTokens).toBe(168_486)
    expect(rec.outputTokens).toBe(0)
    expect(rec.sessionId).toBe('conv1')
    expect(rec.provider).toBe('cursor')
    expect(rec.costIsEstimated).toBe(true)
    // Anchored to composerData.createdAt so the daily bucket is deterministic.
    expect(rec.timestamp).toBe(new Date(meterCreatedAtMs).toISOString())

    // The user (type=1) bubble's text estimate must be suppressed: there is no
    // non-synthetic input-bearing bubble for this conversation.
    const nonSynthetic = calls.filter(c => c.deduplicationKey !== 'cursor:composer-input:conv1')
    const strayInput = nonSynthetic.find(c => c.sessionId === 'conv1' && c.inputTokens > 0)
    expect(strayInput).toBeUndefined()
  })

  it('falls back to contextTokensUsed and, absent composerData.createdAt, to the first bubble timestamp', async () => {
    const dbPath = await buildDb({
      bubbleTs: recentTs,
      meters: { conv2: { contextTokensUsed: 44_873 } },
      conversations: [{ id: 'conv2', userText: 'question', assistantText: 'answer', model: 'composer-1' }],
    })

    const calls = await parseAll(dbPath)
    const rec = calls.find(c => c.deduplicationKey === 'cursor:composer-input:conv2')
    expect(rec).toBeDefined()
    expect(rec!.inputTokens).toBe(44_873)
    // No composerData.createdAt -> anchor to the (only) bubble timestamp.
    expect(rec!.timestamp).toBe(recentTs)
  })

  it('credits the meter exactly once even across a re-parse (dedup)', async () => {
    const dbPath = await buildDb({
      bubbleTs: recentTs,
      meters: { conv3: { totalUsedTokens: 5_000, createdAtMs: Date.parse('2026-05-02T00:00:00.000Z') } },
      conversations: [{ id: 'conv3', userText: 'q', assistantText: 'a', model: 'composer-2.5' }],
    })

    const provider = await getCursorProvider()
    const seenKeys = new Set<string>()
    const source = { path: dbPath, project: 'test-project', provider: 'cursor' }

    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) first.push(call)
    // Second parse with the SAME seenKeys (mirrors a daily-cache gap-fill that
    // overlaps a prior range) must not re-credit.
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) second.push(call)

    const firstSynthetic = first.filter(c => c.deduplicationKey === 'cursor:composer-input:conv3')
    const secondSynthetic = second.filter(c => c.deduplicationKey === 'cursor:composer-input:conv3')
    expect(firstSynthetic).toHaveLength(1)
    expect(secondSynthetic).toHaveLength(0)
  })

  it('leaves conversations WITHOUT a meter on the per-bubble text estimate', async () => {
    const dbPath = await buildDb({
      bubbleTs: recentTs,
      meters: {},
      conversations: [{ id: 'conv4', userText: 'a much longer user question that spans many characters here', assistantText: 'reply text', model: 'composer-1' }],
    })

    const calls = await parseAll(dbPath)
    // No synthetic record without a meter.
    expect(calls.find(c => c.deduplicationKey === 'cursor:composer-input:conv4')).toBeUndefined()
    // The user bubble still contributes an estimated input from its text.
    const userInput = calls.find(c => c.sessionId === 'conv4' && c.inputTokens > 0)
    expect(userInput).toBeDefined()
  })

  it('prices composer models at Cursor-published rates, not the Sonnet proxy', async () => {
    const { calculateCost, getModelCosts } = await import('../../src/models.js')
    // composer-2: $0.50 / 1M input.
    expect(calculateCost('composer-2', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(0.5, 6)
    // composer-1: $1.25 / 1M input, $10 / 1M output.
    expect(calculateCost('composer-1', 1_000_000, 1_000_000, 0, 0, 0)).toBeCloseTo(11.25, 6)
    // composer-* must resolve to their own pricing entry (not a null / $0
    // fallthrough and not aliased to a Claude model).
    expect(getModelCosts('composer-2.5')?.inputCostPerToken).toBeCloseTo(0.5e-6, 12)
  })
})
