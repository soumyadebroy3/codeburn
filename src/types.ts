export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  /**
   * Total cache-creation input tokens. Equal to
   * `cacheCreationInputTokens1h + cacheCreationInputTokens5m` when both
   * fields are present; older session JSONLs that don't break it down put
   * everything here. Kept for backward compatibility with downstream code
   * that doesn't care about cache duration.
   */
  cacheCreationInputTokens: number
  /**
   * 1-hour ephemeral cache writes. Anthropic charges 2× the base input rate
   * for these. Defaults to 0 when the breakdown isn't available — in that
   * case the legacy total is treated as 5-minute cache for pricing.
   */
  cacheCreationInputTokens1h?: number
  /**
   * 5-minute ephemeral cache writes. Anthropic charges 1.25× the base input
   * rate. When the breakdown isn't available, the legacy total is treated
   * as 5m for pricing.
   */
  cacheCreationInputTokens5m?: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | ToolUseBlock
  | { type: string; [key: string]: unknown }

export type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  /**
   * Newer Anthropic responses break cache_creation down by TTL. We use
   * these fields when present to apply the correct multiplier (2× for 1h,
   * 1.25× for 5m). Falls back to cache_creation_input_tokens (treated as
   * 5m) when missing.
   */
  cache_creation?: {
    ephemeral_1h_input_tokens?: number
    ephemeral_5m_input_tokens?: number
  }
  cache_read_input_tokens?: number
  server_tool_use?: {
    web_search_requests?: number
    web_fetch_requests?: number
  }
  speed?: 'standard' | 'fast'
}

export type AssistantMessageContent = {
  model: string
  id?: string
  type: 'message'
  role: 'assistant'
  content: ContentBlock[]
  usage: ApiUsage
  stop_reason?: string
}

export type JournalEntry = {
  type: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  sessionId?: string
  cwd?: string
  version?: string
  gitBranch?: string
  promptId?: string
  message?: AssistantMessageContent | { role: 'user'; content: string | ContentBlock[] }
  isSidechain?: boolean
  [key: string]: unknown
}

export type ParsedTurn = {
  userMessage: string
  assistantCalls: ParsedApiCall[]
  timestamp: string
  sessionId: string
}

export type ParsedApiCall = {
  provider: string
  model: string
  usage: TokenUsage
  costUSD: number
  tools: string[]
  mcpTools: string[]
  skills: string[]
  hasAgentSpawn: boolean
  hasPlanMode: boolean
  speed: 'standard' | 'fast'
  timestamp: string
  bashCommands: string[]
  deduplicationKey: string
}

export type TaskCategory =
  | 'coding'
  | 'debugging'
  | 'feature'
  | 'refactoring'
  | 'testing'
  | 'exploration'
  | 'planning'
  | 'delegation'
  | 'git'
  | 'build/deploy'
  | 'conversation'
  | 'brainstorming'
  | 'general'

export type ClassifiedTurn = ParsedTurn & {
  category: TaskCategory
  subCategory?: string
  retries: number
  hasEdits: boolean
}

export type SessionSummary = {
  sessionId: string
  project: string
  firstTimestamp: string
  lastTimestamp: string
  totalCostUSD: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  apiCalls: number
  turns: ClassifiedTurn[]
  modelBreakdown: Record<string, { calls: number; costUSD: number; tokens: TokenUsage }>
  toolBreakdown: Record<string, { calls: number }>
  mcpBreakdown: Record<string, { calls: number }>
  bashBreakdown: Record<string, { calls: number }>
  categoryBreakdown: Record<TaskCategory, { turns: number; costUSD: number; retries: number; editTurns: number; oneShotTurns: number }>
  skillBreakdown: Record<string, { turns: number; costUSD: number; editTurns: number; oneShotTurns: number }>
  // Observed MCP tools available in this session, captured from
  // `attachment.deferred_tools_delta.addedNames` entries. Union across all
  // turns. Each name is a fully-qualified `mcp__<server>__<tool>` identifier.
  // Built-in tools (Bash, Edit, etc.) are filtered out. Provider-agnostic field;
  // currently populated only by the Claude parser.
  mcpInventory?: string[]
}

export type ProjectSummary = {
  project: string
  projectPath: string
  sessions: SessionSummary[]
  totalCostUSD: number
  totalApiCalls: number
}

export type DateRange = {
  start: Date
  end: Date
}

export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  coding: 'Coding',
  debugging: 'Debugging',
  feature: 'Feature Dev',
  refactoring: 'Refactoring',
  testing: 'Testing',
  exploration: 'Exploration',
  planning: 'Planning',
  delegation: 'Delegation',
  git: 'Git Ops',
  'build/deploy': 'Build/Deploy',
  conversation: 'Conversation',
  brainstorming: 'Brainstorming',
  general: 'General',
}
