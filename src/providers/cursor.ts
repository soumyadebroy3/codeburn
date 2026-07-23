import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { calculateCost } from '../models.js'
import { readCachedResults, writeCachedResults } from '../cursor-cache.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, blobToText, type SqliteDatabase } from '../sqlite.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const CURSOR_COST_MODEL = 'claude-sonnet-4-5'

const modelDisplayNames: Record<string, string> = {
  'claude-4.5-opus-high-thinking': 'Opus 4.5 (Thinking)',
  'claude-4-opus': 'Opus 4',
  'claude-4-sonnet-thinking': 'Sonnet 4 (Thinking)',
  'claude-4.5-sonnet-thinking': 'Sonnet 4.5 (Thinking)',
  'claude-4.6-sonnet': 'Sonnet 4.6',
  'composer-1': 'Composer 1',
  'grok-code-fast-1': 'Grok Code Fast',
  'gemini-3-pro': 'Gemini 3 Pro',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-high': 'GPT-5.1 Codex',
  'gpt-5': 'GPT-5',
  'gpt-4.1': 'GPT-4.1',
  'cursor-auto': 'Cursor (auto)',
}

type BubbleRow = {
  bubble_key: string
  input_tokens: number | null
  output_tokens: number | null
  model: string | null
  created_at: string | null
  conversation_id: string | null
  user_text: Uint8Array | string | null
  text_length: number | null
  bubble_type: number | null
  code_blocks: Uint8Array | string | null
  /// Only populated on the paged scan path (BUBBLE_QUERY_PAGE) used for very
  /// large databases; undefined on the un-paged BUBBLE_QUERY_SINCE path.
  rid?: number
}

type AgentKvRow = {
  key: string
  role: string | null
  content: Uint8Array | string | null
  request_id: string | null
  content_length: number
}

type AgentKvContent = {
  type?: string
  text?: string
  providerOptions?: {
    cursor?: {
      modelName?: string
      requestId?: string
    }
  }
}

const CHARS_PER_TOKEN = 4

function getCursorDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

type CodeBlock = { languageId?: string }

function extractLanguages(codeBlocksJson: string | null): string[] {
  if (!codeBlocksJson) return []
  try {
    const blocks = JSON.parse(codeBlocksJson) as CodeBlock[]
    if (!Array.isArray(blocks)) return []
    const langs = new Set<string>()
    for (const block of blocks) {
      if (block.languageId && block.languageId !== 'plaintext') {
        langs.add(block.languageId)
      }
    }
    return [...langs]
  } catch {
    return []
  }
}

function resolveModel(raw: string | null): string {
  if (!raw || raw === 'default') return CURSOR_COST_MODEL
  return raw
}

function modelForDisplay(raw: string | null): string {
  if (!raw || raw === 'default') return 'cursor-auto'
  return raw
}

const BUBBLE_QUERY_BASE = `
  SELECT
    key as bubble_key,
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.conversationId') as conversation_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
`

const AGENTKV_QUERY = `
  SELECT
    key,
    json_extract(value, '$.role') as role,
    CAST(json_extract(value, '$.content') AS BLOB) as content,
    json_extract(value, '$.providerOptions.cursor.requestId') as request_id,
    length(value) as content_length
  FROM cursorDiskKV
  WHERE key LIKE 'agentKv:blob:%'
    AND hex(substr(value, 1, 1)) = '7B'
  ORDER BY ROWID ASC
`

// Cursor leaves the per-bubble tokenCount at {0,0} on current builds, so the
// text-length estimate that follows systematically undercounts the real prompt
// (a bubble's visible text is a small fraction of the context window actually
// sent). The one real input figure on disk is Cursor's own context meter,
// recorded per conversation in composerData.promptTokenBreakdown.totalUsedTokens
// or, on older builds, contextTokensUsed. It is the LATEST context-window
// snapshot for the conversation, not a per-turn sum, so we credit it exactly
// ONCE per conversation (see the synthetic cursor:composer-input:<id> record in
// parseBubbles) rather than per bubble. The key-range predicate seeks the
// composerData primary-key span instead of scanning the whole table.
const COMPOSER_META_QUERY = `
  SELECT
    substr(key, length('composerData:') + 1) as composer_id,
    json_extract(value, '$.promptTokenBreakdown.totalUsedTokens') as used,
    json_extract(value, '$.contextTokensUsed') as ctx,
    json_extract(value, '$.createdAt') as created_at
  FROM cursorDiskKV
  WHERE key >= 'composerData:' AND key < 'composerData;'
`

const USER_MESSAGES_QUERY = `
  SELECT
    json_extract(value, '$.conversationId') as conversation_id,
    json_extract(value, '$.createdAt') as created_at,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as text
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
    AND json_extract(value, '$.type') = 1
    AND (json_extract(value, '$.createdAt') > ? OR json_extract(value, '$.createdAt') IS NULL)
  ORDER BY ROWID ASC
`

// Split into HEAD (predicates we always emit) and TAIL (ORDER BY) so the
// caller can splice in an optional `ROWID >= ?` cutoff without rewriting
// the whole template. The original combined string is preserved as
// BUBBLE_QUERY_SINCE for any caller that doesn't want the cap.
const BUBBLE_QUERY_SINCE_HEAD = BUBBLE_QUERY_BASE + `
    AND json_extract(value, '$.createdAt') IS NOT NULL
    AND json_extract(value, '$.createdAt') > ?`
const BUBBLE_QUERY_SINCE_TAIL = `
  ORDER BY ROWID ASC
`
const BUBBLE_QUERY_SINCE = BUBBLE_QUERY_SINCE_HEAD + BUBBLE_QUERY_SINCE_TAIL

// Paged variant for very large DBs: fetches one ROWID-descending page below a
// cursor. Returns ROWID and createdAt so the caller can stop once it has paged
// past the requested window floor. No date predicate here — the caller filters
// by createdAt in JS so it can see the window boundary.
const BUBBLE_QUERY_PAGE = `
  SELECT
    key as bubble_key,
    ROWID as rid,
    json_extract(value, '$.tokenCount.inputTokens') as input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') as output_tokens,
    json_extract(value, '$.modelInfo.modelName') as model,
    json_extract(value, '$.createdAt') as created_at,
    json_extract(value, '$.conversationId') as conversation_id,
    CAST(substr(json_extract(value, '$.text'), 1, 500) AS BLOB) as user_text,
    length(json_extract(value, '$.text')) as text_length,
    json_extract(value, '$.type') as bubble_type,
    CAST(json_extract(value, '$.codeBlocks') AS BLOB) as code_blocks
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%' AND ROWID < ?
  ORDER BY ROWID DESC
  LIMIT ?
`

function validateSchema(db: SqliteDatabase): boolean {
  try {
    const rows = db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' LIMIT 1"
    )
    return rows.length > 0
  } catch {
    return false
  }
}

type UserMsgRow = { conversation_id: string; created_at: string; text: Uint8Array | string }

/// Per-conversation user-message buffer. We pop messages in arrival order via
/// the `pos` cursor — a previous implementation called Array.shift() which is
/// O(n) per call on large conversations and pinned multi-GB Cursor DBs at
/// minutes-of-parse for power users. The cursor walk is O(1).
type UserMessageQueue = {
  messages: string[]
  pos: number
}

function buildUserMessageMap(db: SqliteDatabase, timeFloor: string): Map<string, UserMessageQueue> {
  const map = new Map<string, UserMessageQueue>()
  try {
    const rows = db.query<UserMsgRow>(USER_MESSAGES_QUERY, [timeFloor])
    for (const row of rows) {
      if (!row.conversation_id || !row.text) continue
      const text = blobToText(row.text)
      const existing = map.get(row.conversation_id)
      if (existing) {
        existing.messages.push(text)
      } else {
        map.set(row.conversation_id, { messages: [text], pos: 0 })
      }
    }
  } catch {}
  return map
}

function takeUserMessage(queues: Map<string, UserMessageQueue>, conversationId: string): string {
  const queue = queues.get(conversationId)
  if (!queue || queue.pos >= queue.messages.length) return ''
  const msg = queue.messages[queue.pos]
  queue.pos += 1
  return msg
}

/// Real per-conversation context-token figure from Cursor's context meter,
/// plus the conversation's own createdAt (epoch ms) so the synthetic input
/// record can be anchored to the conversation's start rather than the parse
/// time — that keeps the daily-cache bucket deterministic across re-parses.
type ComposerMeta = { tokens: number; createdAt: number | null }

function loadComposerMeta(db: SqliteDatabase): Map<string, ComposerMeta> {
  const map = new Map<string, ComposerMeta>()
  try {
    const rows = db.query<{ composer_id: string; used: number | null; ctx: number | null; created_at: number | null }>(
      COMPOSER_META_QUERY
    )
    for (const r of rows) {
      // `||` (not `??`): a recorded-but-zero promptTokenBreakdown must fall
      // through to the context meter rather than shadowing it at 0.
      const tokens = (r.used || r.ctx) ?? 0
      if (r.composer_id && tokens > 0) {
        map.set(r.composer_id, { tokens, createdAt: r.created_at ?? null })
      }
    }
  } catch {
    /* best-effort: callers fall back to the per-bubble text estimate */
  }
  return map
}

/// Scans bubbles for very large DBs by paging ROWID-descending (newest first),
/// keeping only rows within the requested window (createdAt > timeFloor), and
/// stopping once a full page lands below the floor. A `budget` caps the number
/// of in-range bubbles collected so a genuinely enormous in-range scan can't
/// stall; `truncated` is set only when that budget is actually hit, so the
/// caller warns only when older in-range sessions were really dropped.
function scanBubblesPaged(
  db: SqliteDatabase,
  timeFloor: string,
  budget: number,
): { rows: BubbleRow[]; truncated: boolean } {
  const BATCH = 25_000
  const collected: BubbleRow[] = []
  let beforeRowId = Number.MAX_SAFE_INTEGER
  let truncated = false

  paging: while (true) {
    let batch: BubbleRow[]
    try {
      batch = db.query<BubbleRow>(BUBBLE_QUERY_PAGE, [beforeRowId, BATCH])
    } catch {
      break
    }
    if (batch.length === 0) break

    for (const row of batch) {
      if (collected.length >= budget) { truncated = true; break paging }
      if (row.created_at != null && row.created_at > timeFloor) collected.push(row)
    }

    const oldest = batch[batch.length - 1]!
    beforeRowId = oldest.rid ?? 0
    if (beforeRowId <= 0) break
    if (batch.length < BATCH) break // exhausted the table
    // Pages are ROWID-descending (~chronological), so once the oldest row in a
    // full page predates the window, every older page does too.
    if (oldest.created_at != null && oldest.created_at <= timeFloor) break
  }

  // Restore ROWID-ascending order to match the un-paged query's row ordering.
  collected.sort((a, b) => (a.rid ?? 0) - (b.rid ?? 0))
  return { rows: collected, truncated }
}

function parseBubbles(db: SqliteDatabase, seenKeys: Set<string>): { calls: ParsedProviderCall[] } {
  const results: ParsedProviderCall[] = []
  let skipped = 0

  const LOOKBACK_DAYS = 180
  const timeFloor = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // The bubble timestamp lives inside the JSON value (no index), so the date
  // filter forces a full JSON decode per row. Multi-GB Cursor DBs (500k+
  // bubbles) were producing 30s+ parse stalls, so the scan is bounded. The old
  // approach kept only the most-recent MAX_BUBBLES by ROWID, which dropped
  // in-range older sessions and warned even when the requested window fit
  // comfortably. Instead, for large DBs we page the requested window
  // (ROWID-descending, stopping past the window floor) and only fall back to a
  // hard budget — warning — when the in-range scan genuinely exceeds it.
  // Override the budget in tests via CODEBURN_CURSOR_MAX_BUBBLES.
  const MAX_BUBBLES = Number(process.env['CODEBURN_CURSOR_MAX_BUBBLES']) || 250_000

  let total = 0
  try {
    const countRows = db.query<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'"
    )
    total = countRows[0]?.cnt ?? 0
  } catch { /* best-effort */ }

  const userMessages = buildUserMessageMap(db, timeFloor)
  const composerMeta = loadComposerMeta(db)

  let rows: BubbleRow[]
  try {
    if (total > MAX_BUBBLES) {
      const scan = scanBubblesPaged(db, timeFloor, MAX_BUBBLES)
      rows = scan.rows
      if (scan.truncated) {
        process.stderr.write(
          `codeburn: Cursor database has ${total.toLocaleString()} bubbles and the ` +
          `requested range exceeds the ${MAX_BUBBLES.toLocaleString()}-bubble scan budget; ` +
          `the oldest sessions in range may be missing from this report.\n`
        )
      }
    } else {
      rows = db.query<BubbleRow>(BUBBLE_QUERY_SINCE, [timeFloor])
    }
  } catch {
    return { calls: results }
  }

  // Pre-scan the fetched rows (no extra table scan) for the per-conversation
  // facts the composer-meter crediting needs:
  //   firstBubbleTs        - earliest bubble timestamp, the fallback anchor
  //                          when composerData.createdAt is absent.
  //   convModel            - a model seen on the conversation's bubbles; user
  //                          (type=1) bubbles carry no modelInfo.
  //   meteredConversations - conversations whose real context tokens (Cursor's
  //                          meter) will be credited once, below, via a
  //                          synthetic cursor:composer-input:<id> record. A
  //                          conversation is metered iff it has a composerData
  //                          meter AND at least one in-range bubble, so the
  //                          credit always lands on a real, dated conversation.
  //                          For these we suppress the per-bubble text estimate
  //                          on the INPUT side so the meter figure is not
  //                          double-counted against the visible-text estimate.
  const firstBubbleTs = new Map<string, string>()
  const convModel = new Map<string, string>()
  const meteredConversations = new Set<string>()
  for (const row of rows) {
    const cid = row.conversation_id ?? 'unknown'
    if (row.created_at) {
      const prev = firstBubbleTs.get(cid)
      if (!prev || row.created_at < prev) firstBubbleTs.set(cid, row.created_at)
    }
    if (!convModel.has(cid) && row.model) convModel.set(cid, row.model)
    if (composerMeta.has(cid)) meteredConversations.add(cid)
  }

  for (const row of rows) {
    try {
      const createdAt = row.created_at ?? ''
      // Bubbles without a createdAt timestamp were defaulting to new Date()
      // downstream, misattributing historical or undated usage to Today and
      // inflating the daily chart. Skip them outright. Ports upstream #321.
      if (!createdAt) continue
      const conversationId = row.conversation_id ?? 'unknown'
      // Does this conversation have a real context-token figure on disk? If so
      // its input is credited once, after the loop, from Cursor's meter — not
      // per bubble from visible text.
      const hasMeter = composerMeta.has(conversationId)

      let inputTokens = row.input_tokens ?? 0
      let outputTokens = row.output_tokens ?? 0

      // Cursor's current builds store zero per-bubble token counts. Estimate
      // output from reply text as before. For input, prefer the conversation's
      // real context meter (credited once below) over the text estimate:
      // when a meter exists, mark the conversation and do NOT bill per-bubble
      // input text here.
      if (inputTokens === 0 && outputTokens === 0) {
        const textLen = row.text_length ?? 0
        if (row.bubble_type === 1) {
          // Input is credited once from the meter (below); this user bubble
          // contributes nothing on its own, so drop it rather than emitting a
          // $0 call or double-counting via the text estimate.
          if (hasMeter) continue
          if (textLen === 0) continue
          inputTokens = Math.ceil(textLen / CHARS_PER_TOKEN)
        } else {
          if (textLen === 0) continue
          outputTokens = Math.ceil(textLen / CHARS_PER_TOKEN)
        }
      }

      // Use the SQLite row key (bubbleId:<unique>) as the dedup key.
      // Cursor mutates token counts on the row in place when streaming
      // completes — including tokens in the dedup key (the previous
      // implementation) caused the same bubble to be counted twice once
      // its tokens stabilized.
      const dedupKey = `cursor:bubble:${row.bubble_key}`

      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      const pricingModel = resolveModel(row.model)
      const displayModel = modelForDisplay(row.model)

      const costUSD = calculateCost(pricingModel, inputTokens, outputTokens, 0, 0, 0)

      const timestamp = createdAt
      const userQuestion = takeUserMessage(userMessages, conversationId)
      const assistantText = blobToText(row.user_text)
      const userText = (userQuestion + ' ' + assistantText).trim()

      const languages = extractLanguages(blobToText(row.code_blocks))
      const hasCode = languages.length > 0

      const cursorTools: string[] = hasCode ? ['cursor:edit', ...languages.map(l => `lang:${l}`)] : []

      results.push({
        provider: 'cursor',
        model: displayModel,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD,
        tools: cursorTools,
        bashCommands: [],
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: userText,
        sessionId: conversationId,
      })
    } catch {
      skipped++
    }
  }

  // Credit each metered conversation's REAL context tokens exactly once, via a
  // synthetic conversation-level input record. Cursor's meter
  // (promptTokenBreakdown.totalUsedTokens / contextTokensUsed) is the LATEST
  // context-window size, not a per-turn sum, so crediting it once per
  // conversation — rather than per bubble — is the honest figure and never
  // double counts. The record is:
  //   - anchored to composerData.createdAt (falling back to the conversation's
  //     first in-range bubble timestamp) so the daily-cache bucket is
  //     deterministic across re-parses and cache gap-fills, independent of the
  //     parse window; and
  //   - keyed cursor:composer-input:<id> so a re-parse or an overlapping
  //     daily-cache range dedupes on it instead of multiplying the credit.
  for (const conversationId of meteredConversations) {
    const meta = composerMeta.get(conversationId)
    const inputTokens = meta?.tokens ?? 0
    if (inputTokens <= 0) continue

    const dedupKey = `cursor:composer-input:${conversationId}`
    if (seenKeys.has(dedupKey)) continue

    const createdAtMs = meta?.createdAt
    const timestamp = typeof createdAtMs === 'number' && createdAtMs > 0
      ? new Date(createdAtMs).toISOString()
      : firstBubbleTs.get(conversationId) ?? ''
    // No anchor (composerData.createdAt absent and no dated bubble in range) —
    // skip rather than default to now and misattribute to Today.
    if (!timestamp) continue
    seenKeys.add(dedupKey)

    const model = convModel.get(conversationId) ?? null
    const pricingModel = resolveModel(model)
    const costUSD = calculateCost(pricingModel, inputTokens, 0, 0, 0, 0)

    results.push({
      provider: 'cursor',
      model: modelForDisplay(model),
      inputTokens,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD,
      // The meter is the latest context snapshot, not an exact per-turn sum,
      // so this input figure (and thus its cost) is an estimate.
      costIsEstimated: true,
      tools: [],
      bashCommands: [],
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: '',
      sessionId: conversationId,
    })
  }

  if (skipped > 0) {
    process.stderr.write(`codeburn: skipped ${skipped} unreadable Cursor entries\n`)
  }

  return { calls: results }
}

function extractModelFromContent(content: AgentKvContent[]): string | null {
  for (const c of content) {
    if (c.providerOptions?.cursor?.modelName) {
      return c.providerOptions.cursor.modelName
    }
  }
  return null
}

function extractTextLength(content: AgentKvContent[]): number {
  let total = 0
  for (const c of content) {
    if (c.text) total += c.text.length
  }
  return total
}

function parseAgentKv(db: SqliteDatabase, seenKeys: Set<string>, dbPath: string): { calls: ParsedProviderCall[] } {
  const results: ParsedProviderCall[] = []

  // Cursor's agentKv schema does not record per-message timestamps. Use the
  // SQLite file's mtime as a bounded "last write" timestamp for all calls;
  // it's at least honest (no future time, no always-now). Users running
  // codeburn against an idle Cursor install will see agentKv calls land at
  // the actual last activity time rather than today's date.
  let agentKvTimestamp: string
  try {
    agentKvTimestamp = new Date(statSync(dbPath).mtimeMs).toISOString()
  } catch {
    agentKvTimestamp = new Date().toISOString()
  }

  let rows: AgentKvRow[]
  try {
    rows = db.query<AgentKvRow>(AGENTKV_QUERY)
  } catch {
    return { calls: results }
  }

  const sessions: Map<string, { inputChars: number; outputChars: number; model: string | null; userText: string }> = new Map()
  let currentRequestId = 'unknown'

  for (const row of rows) {
    if (!row.role || !row.content) continue
    const contentText = blobToText(row.content)

    let content: AgentKvContent[]
    let plainTextLength = 0
    try {
      const parsed = JSON.parse(contentText)
      if (Array.isArray(parsed)) {
        content = parsed
      } else {
        content = []
        plainTextLength = contentText.length
      }
    } catch {
      content = []
      plainTextLength = contentText.length
    }

    const requestId = row.request_id ?? currentRequestId
    if (requestId !== currentRequestId) {
      currentRequestId = requestId
    }

    const textLength = plainTextLength || extractTextLength(content)
    const model = extractModelFromContent(content)

    if (row.role === 'user') {
      const existing = sessions.get(requestId) ?? { inputChars: 0, outputChars: 0, model: null, userText: '' }
      existing.inputChars += textLength
      if (!existing.userText) {
        const text = content[0]?.text ?? contentText
        const queryMatch = text.match(/<user_query>([\s\S]*?)<\/user_query>/)
        existing.userText = queryMatch ? queryMatch[1].trim().slice(0, 500) : text.slice(0, 500)
      }
      sessions.set(requestId, existing)
    } else if (row.role === 'assistant') {
      const existing = sessions.get(requestId) ?? { inputChars: 0, outputChars: 0, model: null, userText: '' }
      existing.outputChars += textLength
      if (model) existing.model = model
      sessions.set(requestId, existing)
    } else if (row.role === 'tool' || row.role === 'system') {
      const existing = sessions.get(requestId) ?? { inputChars: 0, outputChars: 0, model: null, userText: '' }
      existing.inputChars += textLength
      sessions.set(requestId, existing)
    }
  }

  for (const [requestId, session] of sessions) {
    if (session.inputChars === 0 && session.outputChars === 0) continue

    const inputTokens = Math.ceil(session.inputChars / CHARS_PER_TOKEN)
    const outputTokens = Math.ceil(session.outputChars / CHARS_PER_TOKEN)
    const dedupKey = `cursor:agentKv:${requestId}`

    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    const pricingModel = resolveModel(session.model)
    const displayModel = modelForDisplay(session.model)
    const costUSD = calculateCost(pricingModel, inputTokens, outputTokens, 0, 0, 0)

    results.push({
      provider: 'cursor',
      model: displayModel,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD,
      tools: [],
      bashCommands: [],
      timestamp: agentKvTimestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: session.userText,
      sessionId: requestId,
    })
  }

  return { calls: results }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      const cached = await readCachedResults(source.path)
      if (cached) {
        for (const call of cached) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      let db: SqliteDatabase
      try {
        db = openDatabase(source.path)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open Cursor database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        if (!validateSchema(db)) {
          process.stderr.write('codeburn: Cursor storage format not recognized. You may need to update CodeBurn.\n')
          return
        }

        const { calls: bubbleCalls } = parseBubbles(db, seenKeys)
        const { calls: agentKvCalls } = parseAgentKv(db, seenKeys, source.path)
        const calls = [...bubbleCalls, ...agentKvCalls]

        await writeCachedResults(source.path, calls)

        for (const call of calls) {
          yield call
        }
      } finally {
        db.close()
      }
    },
  }
}

export function createCursorProvider(dbPathOverride?: string): Provider {
  return {
    name: 'cursor',
    displayName: 'Cursor',

    modelDisplayName(model: string): string {
      return modelDisplayNames[model] ?? model
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []

      const dbPath = dbPathOverride ?? getCursorDbPath()
      if (!existsSync(dbPath)) return []

      return [{ path: dbPath, project: 'cursor', provider: 'cursor' }]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const cursor = createCursorProvider()
