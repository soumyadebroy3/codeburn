import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { isSqliteAvailable, getSqliteLoadError, openDatabase, blobToText, type SqliteDatabase } from '../sqlite.js'
import type {
  Provider,
  SessionSource,
  SessionParser,
  ParsedProviderCall,
} from './types.js'

type MessageRow = {
  session_id: string
  id: string
  time_created: number
  data: Uint8Array | string
}

type PartRow = {
  message_id: string
  data: Uint8Array | string
}

type SessionRow = {
  id: string
  directory: Uint8Array | string
  title: Uint8Array | string
  time_created: number
}

type MessageData = {
  role: string
  modelID?: string
  model?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

type PartData = {
  type: string
  text?: string
  tool?: string
  state?: { input?: { command?: string } }
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  skill: 'Skill',
  patch: 'Patch',
}

/// Normalize an OpenCode tool name into either:
///   * the canonical built-in name (Bash, Read, Edit, ...)
///   * an already-prefixed `mcp__server__tool` name (left alone)
///   * a freshly-prefixed `mcp__server__tool` constructed from OpenCode's
///     own `<server>_<tool>` storage convention
///
/// Why: OpenCode stores MCP tool calls as `<server>_<tool>` with no separate
/// server field, so without this normalization MCP usage was invisible to
/// the cross-provider MCP pipeline and to `codeburn optimize`. Built-in
/// names are checked first so a built-in containing an `_` (none today, but
/// defense-in-depth) can never be misinterpreted as an MCP call. Ports
/// upstream PR #318. Closes upstream #308.
function normalizeToolName(rawTool?: string): string {
  if (!rawTool) return ''
  if (rawTool.startsWith('mcp__')) return rawTool

  const builtIn = toolNameMap[rawTool]
  if (builtIn) return builtIn

  const serverSeparator = rawTool.indexOf('_')
  if (serverSeparator > 0 && serverSeparator < rawTool.length - 1) {
    const server = rawTool.slice(0, serverSeparator)
    const tool = rawTool.slice(serverSeparator + 1)
    return `mcp__${server}__${tool}`
  }

  return rawTool
}

function sanitize(dir: string): string {
  return dir.replace(/^\//, '').replace(/\//g, '-')
}

function getDataDir(dataDir?: string): string {
  const base =
    dataDir ??
    process.env['XDG_DATA_HOME'] ??
    join(homedir(), '.local', 'share')
  return join(base, 'opencode')
}

async function findDbFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries
      .filter((f) => f.startsWith('opencode') && f.endsWith('.db'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

function parseTimestamp(raw: number): string {
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

type SessionTokenRow = {
  cost?: number
  tokens_input?: number
  tokens_output?: number
  tokens_reasoning?: number
  tokens_cache_read?: number
  tokens_cache_write?: number
  model_id?: string
}

function tryQuerySessionTokens(db: SqliteDatabase, sessionId: string): {
  cost: number; input: number; output: number; reasoning: number
  cacheRead: number; cacheWrite: number; model: string | undefined
} | null {
  try {
    const rows = db.query<SessionTokenRow>(
      `SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model_id FROM session WHERE id = ?`,
      [sessionId],
    )
    if (rows.length === 0) return null
    const r = rows[0]!
    return {
      cost: r.cost ?? 0,
      input: r.tokens_input ?? 0,
      output: r.tokens_output ?? 0,
      reasoning: r.tokens_reasoning ?? 0,
      cacheRead: r.tokens_cache_read ?? 0,
      cacheWrite: r.tokens_cache_write ?? 0,
      model: r.model_id ?? undefined,
    }
  } catch {
    return null
  }
}

type SchemaCheckResult =
  | { ok: true }
  | { ok: false; missing: string[] }

/// Inspects OpenCode's SQLite schema. Returns the list of expected tables that
/// are missing rather than just a boolean so the caller can produce an actionable
/// warning ("missing 'part' table") instead of a generic "format not recognized".
/// Only emits the warning when meaningful tables are absent — a brand-new
/// OpenCode install with an empty DB but valid schema does NOT trigger it.
function validateSchemaDetailed(db: SqliteDatabase): SchemaCheckResult {
  const required = ['session', 'message', 'part']
  const missing: string[] = []
  for (const table of required) {
    try {
      db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table} LIMIT 1`)
    } catch {
      missing.push(table)
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

function validateSchema(db: SqliteDatabase): boolean {
  return validateSchemaDetailed(db).ok
}

const warnedOpenCodeSchemas = new Set<string>()

function warnUnrecognizedOpenCodeSchemaOnce(missing: string[]): void {
  const key = missing.slice().sort((a, b) => a.localeCompare(b)).join(',')
  if (warnedOpenCodeSchemas.has(key)) return
  warnedOpenCodeSchemas.add(key)
  process.stderr.write(
    `codeburn: OpenCode database is missing expected tables (${missing.join(', ')}). ` +
    `Run OpenCode once to apply migrations, or report at https://github.com/soumyadebroy3/codeburn/issues if this persists on a current OpenCode install.\n`
  )
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!isSqliteAvailable()) {
        process.stderr.write(getSqliteLoadError() + '\n')
        return
      }

      // Path is encoded as `${dbPath}:${sessionId}`. Session IDs are UUIDs
      // (no colons), so the last segment after splitting on ':' is always
      // the session ID. Rejoining handles Windows drive letters (C:\...).
      const segments = source.path.split(':')
      const sessionId = segments.at(-1)!
      const dbPath = segments.slice(0, -1).join(':')

      let db: SqliteDatabase
      try {
        db = openDatabase(dbPath)
      } catch (err) {
        process.stderr.write(`codeburn: cannot open OpenCode database: ${err instanceof Error ? err.message : err}\n`)
        return
      }

      try {
        const schema = validateSchemaDetailed(db)
        if (!schema.ok) {
          // Warn at most once per process per missing-table set so a directory
          // with a half-migrated OpenCode DB doesn't spam stderr on every
          // session iteration. Show which tables we couldn't find so the
          // user (or a triage agent) knows whether to re-run OpenCode's
          // migration or report a CodeBurn schema gap.
          warnUnrecognizedOpenCodeSchemaOnce(schema.missing)
          return
        }

        // Walk the parent_id chain so child sessions (spawned by sub-task
        // tools) get rolled up under their root session. WITH RECURSIVE
        // CTE expands the root session id to itself + every non-archived
        // descendant. `time_archived IS NULL` skips OpenCode's soft-deleted
        // session entries so we don't re-count messages from a session the
        // user explicitly archived. Upstream PR #343.
        const messages = db.query<MessageRow>(
          `WITH RECURSIVE session_tree(id) AS (
            SELECT id FROM session WHERE id = ?
            UNION
            SELECT child.id
            FROM session child
            JOIN session_tree parent ON child.parent_id = parent.id
            WHERE child.time_archived IS NULL
          )
          SELECT session_id, id, time_created, CAST(data AS BLOB) AS data
          FROM message
          WHERE session_id IN (SELECT id FROM session_tree)
          ORDER BY time_created ASC, id ASC`,
          [sessionId],
        )

        const parts = db.query<PartRow>(
          `WITH RECURSIVE session_tree(id) AS (
            SELECT id FROM session WHERE id = ?
            UNION
            SELECT child.id
            FROM session child
            JOIN session_tree parent ON child.parent_id = parent.id
            WHERE child.time_archived IS NULL
          )
          SELECT message_id, CAST(data AS BLOB) AS data
          FROM part
          WHERE session_id IN (SELECT id FROM session_tree)
          ORDER BY message_id, id`,
          [sessionId],
        )

        const partsByMsg = new Map<string, PartData[]>()
        for (const part of parts) {
          try {
            const parsed = JSON.parse(blobToText(part.data)) as PartData
            const list = partsByMsg.get(part.message_id) ?? []
            list.push(parsed)
            partsByMsg.set(part.message_id, list)
          } catch {
            // skip corrupt part data
          }
        }

        // Keyed by session_id because each child session in the tree
        // has its own user-message timeline; using a single shared
        // `currentUserMessage` would leak across siblings and attribute
        // the wrong prompt to an assistant turn.
        const currentUserMessageBySession = new Map<string, string>()
        let yieldCount = 0
        let parseFailCount = 0
        let roleSkipCount = 0

        for (const msg of messages) {
          let data: MessageData
          try {
            data = JSON.parse(blobToText(msg.data)) as MessageData
          } catch {
            parseFailCount++
            continue
          }

          if (data.role === 'user') {
            const textParts = (partsByMsg.get(msg.id) ?? [])
              .filter((p) => p.type === 'text')
              .map((p) => p.text ?? '')
              .filter(Boolean)
            if (textParts.length > 0) {
              currentUserMessageBySession.set(msg.session_id, textParts.join(' '))
            }
            continue
          }

          if (data.role !== 'assistant' && data.role !== 'model') {
            if (data.role !== 'user') roleSkipCount++
            continue
          }

          const tokens = {
            input: data.tokens?.input ?? data.usage?.input_tokens ?? 0,
            output: data.tokens?.output ?? data.usage?.output_tokens ?? 0,
            reasoning: data.tokens?.reasoning ?? 0,
            cacheRead: data.tokens?.cache?.read ?? data.usage?.cache_read_input_tokens ?? 0,
            cacheWrite: data.tokens?.cache?.write ?? data.usage?.cache_creation_input_tokens ?? 0,
          }

          const msgParts = partsByMsg.get(msg.id) ?? []
          const toolParts = msgParts.filter((p) => (p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call') && normalizeToolName(p.tool))
          const hasTextOutput = msgParts.some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0)
          const hasToolOrTextParts = hasTextOutput || toolParts.length > 0
          const hasAnySubstantiveParts = msgParts.some((p) =>
            p.type === 'text' || p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call' ||
            p.type === 'tool-result' || p.type === 'tool_result' || p.type === 'reasoning' || p.type === 'file'
          )
          const hasActivity = hasToolOrTextParts || hasAnySubstantiveParts

          const allZero =
            tokens.input === 0 &&
            tokens.output === 0 &&
            tokens.reasoning === 0 &&
            tokens.cacheRead === 0 &&
            tokens.cacheWrite === 0
          // Keep entries where the model produced visible activity (tool
          // calls or text) even when token usage is zero — typical of
          // OpenCode router calls (e.g. a /model switch) that don't bill
          // tokens but still represent activity the user expects to see.
          // Ports upstream PR #342.
          if (allZero && (data.cost ?? 0) === 0 && !hasActivity) continue

          const tools = toolParts
            .map((p) => normalizeToolName(p.tool))
            .filter(Boolean)

          const bashCommands = toolParts
            .filter((p) => p.tool === 'bash' && typeof p.state?.input?.command === 'string')
            .flatMap((p) => extractBashCommands(p.state!.input!.command!))

          // Dedup by child-session id, not root, so two distinct child
          // sessions that happen to mint the same internal message id
          // don't collide.
          const dedupKey = `opencode:${msg.session_id}:${msg.id}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const model = data.modelID ?? data.model ?? 'unknown'
          let costUSD = calculateCost(
            model,
            tokens.input,
            tokens.output + tokens.reasoning,
            tokens.cacheWrite,
            tokens.cacheRead,
            0,
          )

          if (costUSD === 0 && typeof data.cost === 'number' && data.cost > 0) {
            costUSD = data.cost
          }

          yieldCount++
          yield {
            provider: 'opencode',
            model,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheCreationInputTokens: tokens.cacheWrite,
            cacheReadInputTokens: tokens.cacheRead,
            cachedInputTokens: tokens.cacheRead,
            reasoningTokens: tokens.reasoning,
            webSearchRequests: 0,
            costUSD,
            tools,
            bashCommands,
            timestamp: parseTimestamp(msg.time_created),
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: currentUserMessageBySession.get(msg.session_id) ?? '',
            sessionId,
          }
        }

        if (yieldCount === 0 && messages.length > 0) {
          // Fallback: newer OpenCode schemas store aggregated tokens on the
          // session row rather than per-message. Ports upstream PR #394.
          const sessionTokens = tryQuerySessionTokens(db, sessionId)
          if (sessionTokens && (sessionTokens.cost > 0 || sessionTokens.input > 0 || sessionTokens.output > 0)) {
            const dedupKey = `opencode:${sessionId}:session-level`
            if (!seenKeys.has(dedupKey)) {
              seenKeys.add(dedupKey)
              const model = sessionTokens.model ?? 'unknown'
              let costUSD = calculateCost(model, sessionTokens.input, sessionTokens.output, sessionTokens.cacheWrite, sessionTokens.cacheRead, 0)
              if (costUSD === 0 && sessionTokens.cost > 0) costUSD = sessionTokens.cost
              yield {
                provider: 'opencode',
                model,
                inputTokens: sessionTokens.input,
                outputTokens: sessionTokens.output,
                cacheCreationInputTokens: sessionTokens.cacheWrite,
                cacheReadInputTokens: sessionTokens.cacheRead,
                cachedInputTokens: sessionTokens.cacheRead,
                reasoningTokens: sessionTokens.reasoning,
                webSearchRequests: 0,
                costUSD,
                tools: [],
                bashCommands: [],
                timestamp: parseTimestamp(messages[0]!.time_created),
                speed: 'standard',
                deduplicationKey: dedupKey,
                userMessage: '',
                sessionId,
              }
              yieldCount++
            }
          }

          if (yieldCount === 0 && process.env['CODEBURN_VERBOSE'] === '1') {
            process.stderr.write(
              `codeburn: OpenCode session ${sessionId} has ${messages.length} messages ` +
              `(${parseFailCount} unparseable, ${roleSkipCount} non-user/assistant roles) ` +
              `but yielded 0 calls. Parts: ${parts.length}.\n`
            )
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

async function discoverFromDb(dbPath: string): Promise<SessionSource[]> {
  let db: SqliteDatabase
  try {
    db = openDatabase(dbPath)
  } catch {
    return []
  }

  try {
    const rows = db.query<SessionRow>(
      'SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC',
    )

    return rows.map((row) => {
      const dir = blobToText(row.directory)
      const title = blobToText(row.title)
      return {
        path: `${dbPath}:${row.id}`,
        project: dir ? sanitize(dir) : sanitize(title),
        provider: 'opencode',
      }
    })
  } catch {
    return []
  } finally {
    db.close()
  }
}

export function createOpenCodeProvider(dataDir?: string): Provider {
  const dir = getDataDir(dataDir)

  return {
    name: 'opencode',
    displayName: 'OpenCode',

    modelDisplayName(model: string): string {
      const stripped = model.replace(/^[^/]+\//, '')
      return getShortModelName(stripped)
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      if (!isSqliteAvailable()) return []

      const dbPaths = await findDbFiles(dir)
      if (dbPaths.length === 0) return []

      const sessions: SessionSource[] = []
      for (const dbPath of dbPaths) {
        sessions.push(...await discoverFromDb(dbPath))
      }
      return sessions
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>,
    ): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const opencode = createOpenCodeProvider()
