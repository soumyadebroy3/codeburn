export type SessionSource = {
  path: string
  project: string
  provider: string
}

export type SessionParser = {
  parse(): AsyncGenerator<ParsedProviderCall>
}

export type ParsedProviderCall = {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  /** Total cache writes (1h + 5m). Kept for backward compat. */
  cacheCreationInputTokens: number
  /** 1-hour cache writes. Priced at 2× input. Optional — older parsers omit. */
  cacheCreationInputTokens1h?: number
  /** 5-minute cache writes. Priced at 1.25× input. Optional — older parsers omit. */
  cacheCreationInputTokens5m?: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  costUSD: number
  costIsEstimated?: boolean
  tools: string[]
  bashCommands: string[]
  timestamp: string
  speed: 'standard' | 'fast'
  deduplicationKey: string
  /// Optional grouping key — when multiple ParsedProviderCalls share the same
  /// turnId the parser treats them as a single user-initiated turn (an
  /// agent-call chain) so the one-shot classifier sees Edit→Bash→Edit as a
  /// single retried turn, not three independent first-tries.
  turnId?: string
  /// Optional per-call ordered tool sub-steps. Providers that aggregate
  /// multiple internal assistant messages into one ParsedProviderCall fill
  /// this in so the classifier can see retry shape inside the aggregate.
  /// `tools` is still the flat union for display.
  toolSequence?: string[][]
  userMessage: string
  sessionId: string
  project?: string
  projectPath?: string
}

export type Provider = {
  name: string
  displayName: string
  modelDisplayName(model: string): string
  toolDisplayName(rawTool: string): string
  discoverSessions(): Promise<SessionSource[]>
  createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser
}
