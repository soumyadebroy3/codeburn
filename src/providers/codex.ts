import { readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

import { readSessionLines } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { readCachedCodexResults, writeCachedCodexResults, getCachedCodexProject, fingerprintFile } from '../codex-cache.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5': 'GPT-5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
}

const toolNameMap: Record<string, string> = {
  exec_command: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
  close_agent: 'Agent',
  wait_agent: 'Agent',
  read_dir: 'Glob',
}

type CodexEntry = {
  type: string
  timestamp?: string
  payload?: {
    type?: string
    role?: string
    cwd?: string
    model_provider?: string
    originator?: string
    session_id?: string
    model?: string
    name?: string
    content?: Array<{ type?: string; text?: string }>
    info?: {
      model?: string
      model_name?: string
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
    }
  }
}

type CodexTokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

const CHARS_PER_TOKEN = 4

function getCodexDir(override?: string): string {
  return override ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
}

function sanitizeProject(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '-')
}

// Cap how many bytes we'll read while looking for the first newline. Real
// Codex session_meta lines are ~22-27 KB; this leaves plenty of headroom while
// keeping memory bounded if a corrupt file has no newline at all.
const FIRST_LINE_READ_CAP = 1024 * 1024

async function readFirstLine(filePath: string): Promise<CodexEntry | null> {
  // Codex CLI 0.128+ writes a session_meta line that can exceed 20 KB because
  // it embeds the full base_instructions / system prompt. A fixed-size buffer
  // would miss the trailing newline and reject the session as invalid.
  // Stream the file via readline so we can read the first line up to
  // FIRST_LINE_READ_CAP, which keeps memory bounded if the file has no newline.
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    start: 0,
    end: FIRST_LINE_READ_CAP - 1,
  })
  // Silence stream errors so a late read-ahead error after we've already
  // returned the first line cannot escape as an unhandled 'error' event.
  // readline's async iterator re-throws underlying stream errors (ENOENT,
  // EACCES, etc.) on Node 16+, which the catch below handles for the cases
  // that matter for validation.
  stream.on('error', () => {})
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  // Use the async iterator's .next() to grab a single line without a
  // for-await loop that's immediately broken (S1751 / "loop only
  // iterates once" trip). Same semantics; cleaner intent.
  let firstLine: string | undefined
  try {
    const it = rl[Symbol.asyncIterator]()
    const first = await it.next()
    if (!first.done) firstLine = first.value
  } catch {
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
  if (!firstLine?.trim()) return null
  try {
    return JSON.parse(firstLine) as CodexEntry
  } catch {
    return null
  }
}

async function isValidCodexSession(filePath: string): Promise<{ valid: boolean; meta?: CodexEntry }> {
  const entry = await readFirstLine(filePath)
  if (!entry) return { valid: false }
  const valid = entry.type === 'session_meta' &&
    typeof entry.payload?.originator === 'string' &&
    entry.payload.originator.toLowerCase().startsWith('codex')
  return { valid, meta: valid ? entry : undefined }
}

async function discoverSessionsInDir(codexDir: string): Promise<SessionSource[]> {
  const sessionsDir = join(codexDir, 'sessions')
  const sources: SessionSource[] = []

  let years: string[]
  try {
    years = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const yearDir = join(sessionsDir, year)
    const months = await readdir(yearDir).catch(() => [] as string[])

    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const monthDir = join(yearDir, month)
      const days = await readdir(monthDir).catch(() => [] as string[])

      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue
        const dayDir = join(monthDir, day)
        const files = await readdir(dayDir).catch(() => [] as string[])

        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
          const filePath = join(dayDir, file)
          const s = await stat(filePath).catch(() => null)
          if (!s?.isFile()) continue

          const cachedProject = await getCachedCodexProject(filePath)
          if (cachedProject) {
            sources.push({ path: filePath, project: cachedProject, provider: 'codex' })
            continue
          }

          const { valid, meta } = await isValidCodexSession(filePath)
          if (!valid || !meta) continue

          const cwd = meta.payload?.cwd ?? 'unknown'
          sources.push({ path: filePath, project: sanitizeProject(cwd), provider: 'codex' })
        }
      }
    }
  }

  return sources
}

function resolveModel(info: CodexEntry['payload'], sessionModel?: string): string {
  return info?.model
    ?? info?.info?.model
    ?? info?.info?.model_name
    ?? sessionModel
    ?? 'gpt-5'
}

type CodexParserState = {
  sessionModel?: string
  sessionId: string
  prevCumulativeTotal: number | null
  prevInput: number
  prevCached: number
  prevOutput: number
  prevReasoning: number
  pendingTools: string[]
  pendingUserMessage: string
  pendingOutputChars: number
  estCounter: number
  results: ParsedProviderCall[]
}

function newCodexParserState(): CodexParserState {
  return {
    sessionId: '',
    prevCumulativeTotal: null,
    prevInput: 0,
    prevCached: 0,
    prevOutput: 0,
    prevReasoning: 0,
    pendingTools: [],
    pendingUserMessage: '',
    pendingOutputChars: 0,
    estCounter: 0,
    results: [],
  }
}

function clearPending(state: CodexParserState): void {
  state.pendingTools = []
  state.pendingUserMessage = ''
  state.pendingOutputChars = 0
}

function handleSessionMeta(state: CodexParserState, entry: CodexEntry, fallbackId: string): void {
  state.sessionId = entry.payload?.session_id ?? fallbackId
  state.sessionModel = entry.payload?.model ?? state.sessionModel
}

function handleUserMessage(state: CodexParserState, entry: CodexEntry): void {
  const texts = (entry.payload?.content ?? [])
    .filter(c => c.type === 'input_text')
    .map(c => c.text ?? '')
    .filter(Boolean)
  if (texts.length > 0) state.pendingUserMessage = texts.join(' ')
}

function handleAssistantMessage(state: CodexParserState, entry: CodexEntry): void {
  const texts = (entry.payload?.content ?? [])
    .filter(c => c.type === 'output_text' || c.type === 'text')
    .map(c => c.text ?? '')
  state.pendingOutputChars += texts.join('').length
}

function handleTokenCountEstimated(state: CodexParserState, entry: CodexEntry, seenKeys: Set<string>): void {
  if (state.pendingOutputChars === 0 && state.pendingUserMessage.length === 0) return
  const estInput = Math.ceil(state.pendingUserMessage.length / CHARS_PER_TOKEN)
  const estOutput = Math.ceil(state.pendingOutputChars / CHARS_PER_TOKEN)
  if (estInput === 0 && estOutput === 0) return

  const model = state.sessionModel ?? 'gpt-5'
  const timestamp = entry.timestamp ?? ''
  const dedupKey = `codex:${state.sessionId}:${timestamp}:est${state.estCounter++}`

  if (seenKeys.has(dedupKey)) {
    clearPending(state)
    return
  }
  seenKeys.add(dedupKey)

  const costUSD = calculateCost(model, estInput, estOutput, 0, 0, 0)
  state.results.push({
    provider: 'codex',
    model,
    inputTokens: estInput,
    outputTokens: estOutput,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD,
    costIsEstimated: true,
    tools: state.pendingTools,
    bashCommands: [],
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: state.pendingUserMessage,
    sessionId: state.sessionId,
  })
  clearPending(state)
}

type ExtractedTokens = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
}

// Extract per-turn token counts from a token_count event. Codex usually
// includes `last_token_usage` (per-turn deltas) but legacy sessions only
// emit cumulative `total_token_usage`; we derive the delta against the
// previously-observed cumulative state in that fallback path.
function extractTurnTokens(state: CodexParserState, info: NonNullable<CodexEntry['payload']>['info']): ExtractedTokens | null {
  if (!info) return null
  const last = info.last_token_usage
  if (last) {
    return {
      inputTokens: last.input_tokens ?? 0,
      cachedInputTokens: last.cached_input_tokens ?? 0,
      outputTokens: last.output_tokens ?? 0,
      reasoningTokens: last.reasoning_output_tokens ?? 0,
    }
  }
  const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0
  if (cumulativeTotal <= 0) {
    return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  }
  const total = info.total_token_usage
  if (!total) return null
  return {
    inputTokens: (total.input_tokens ?? 0) - state.prevInput,
    cachedInputTokens: (total.cached_input_tokens ?? 0) - state.prevCached,
    outputTokens: (total.output_tokens ?? 0) - state.prevOutput,
    reasoningTokens: (total.reasoning_output_tokens ?? 0) - state.prevReasoning,
  }
}

function advancePrevCounters(state: CodexParserState, info: NonNullable<CodexEntry['payload']>['info']): void {
  // Always advance the prev counters to track cumulative state. The prev
  // value must mirror what cumulative reports regardless of whether this
  // event used `last` or fell back to deltas — otherwise a mixed session
  // double-counts the entire cumulative window on the next fallback event.
  const total = info?.total_token_usage
  if (!total) return
  state.prevInput = total.input_tokens ?? 0
  state.prevCached = total.cached_input_tokens ?? 0
  state.prevOutput = total.output_tokens ?? 0
  state.prevReasoning = total.reasoning_output_tokens ?? 0
}

function handleTokenCount(state: CodexParserState, entry: CodexEntry, seenKeys: Set<string>): void {
  const info = entry.payload?.info
  if (!info) {
    handleTokenCountEstimated(state, entry, seenKeys)
    return
  }

  const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0
  // Dedup guard. Two consecutive events with cumulativeTotal=0 but non-empty
  // last_token_usage would have been double-counted under the previous
  // `> 0` form. The null sentinel ensures the FIRST event always passes.
  if (state.prevCumulativeTotal !== null && cumulativeTotal === state.prevCumulativeTotal) return
  state.prevCumulativeTotal = cumulativeTotal

  const tokens = extractTurnTokens(state, info)
  if (!tokens) return
  advancePrevCounters(state, info)

  const totalTokens = tokens.inputTokens + tokens.cachedInputTokens + tokens.outputTokens + tokens.reasoningTokens
  if (totalTokens === 0) return

  // OpenAI includes cached tokens inside input_tokens; Anthropic does not.
  // Normalize to Anthropic semantics: inputTokens = non-cached only.
  const uncachedInputTokens = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens)
  const model = resolveModel(entry.payload, state.sessionModel)
  const timestamp = entry.timestamp ?? ''
  const dedupKey = `codex:${state.sessionId}:${timestamp}:${cumulativeTotal}`

  if (seenKeys.has(dedupKey)) return
  seenKeys.add(dedupKey)

  const costUSD = calculateCost(
    model,
    uncachedInputTokens,
    tokens.outputTokens + tokens.reasoningTokens,
    0,
    tokens.cachedInputTokens,
    0,
  )

  state.results.push({
    provider: 'codex',
    model,
    inputTokens: uncachedInputTokens,
    outputTokens: tokens.outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: tokens.cachedInputTokens,
    cachedInputTokens: tokens.cachedInputTokens,
    reasoningTokens: tokens.reasoningTokens,
    webSearchRequests: 0,
    costUSD,
    tools: state.pendingTools,
    bashCommands: [],
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: state.pendingUserMessage,
    sessionId: state.sessionId,
  })
  clearPending(state)
}

function processCodexEntry(state: CodexParserState, entry: CodexEntry, source: SessionSource, seenKeys: Set<string>): void {
  const payloadType = entry.payload?.type
  if (entry.type === 'session_meta') {
    handleSessionMeta(state, entry, basename(source.path, '.jsonl'))
    return
  }
  if (entry.type === 'turn_context' && entry.payload?.model) {
    state.sessionModel = entry.payload.model
    return
  }
  if (entry.type === 'response_item' && payloadType === 'function_call') {
    const rawName = entry.payload?.name ?? ''
    state.pendingTools.push(toolNameMap[rawName] ?? rawName)
    return
  }
  if (entry.type === 'event_msg' && payloadType === 'patch_apply_end') {
    state.pendingTools.push('Edit')
    return
  }
  if (entry.type === 'response_item' && payloadType === 'message' && entry.payload?.role === 'user') {
    handleUserMessage(state, entry)
    return
  }
  if (entry.type === 'response_item' && payloadType === 'message' && entry.payload?.role === 'assistant') {
    handleAssistantMessage(state, entry)
    return
  }
  if (entry.type === 'event_msg' && payloadType === 'token_count') {
    handleTokenCount(state, entry, seenKeys)
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const cached = await readCachedCodexResults(source.path)
      if (cached) {
        for (const call of cached) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      const fp = await fingerprintFile(source.path)
      if (!fp) return

      const state = newCodexParserState()
      let sawAnyLine = false

      // Stream the session file line by line. Heavy Codex sessions can exceed
      // 250 MB on disk; reading the entire file into a string would either
      // hit the readSessionFile cap or push V8 toward its 512 MB string limit
      // after split('\n'). readSessionLines streams via readline.
      for await (const rawLine of readSessionLines(source.path)) {
        sawAnyLine = true
        const line = rawLine.trim()
        if (!line) continue
        let entry: CodexEntry
        try {
          entry = JSON.parse(line) as CodexEntry
        } catch {
          continue
        }
        processCodexEntry(state, entry, source, seenKeys)
      }

      // If the stream yielded nothing the file was unreadable, oversized, or
      // empty. Skip cache write so a transient failure can't pin an empty
      // result set against a fingerprint that would otherwise be re-parsed.
      if (!sawAnyLine) return

      await writeCachedCodexResults(source.path, source.project, state.results, fp)

      for (const call of state.results) {
        yield call
      }
    },
  }
}

export function createCodexProvider(codexDir?: string): Provider {
  const dir = getCodexDir(codexDir)

  return {
    name: 'codex',
    displayName: 'Codex',

    modelDisplayName(model: string): string {
      for (const [key, name] of Object.entries(modelDisplayNames)) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(dir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const codex = createCodexProvider()
