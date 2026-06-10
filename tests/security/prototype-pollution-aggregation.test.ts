import { describe, it, expect, afterEach } from 'vitest'

import { aggregateProjectsIntoDays, buildPeriodDataFromDays } from '../../src/day-aggregator.js'
import type { ClassifiedTurn, ParsedApiCall, ProjectSummary, SessionSummary } from '../../src/types.js'

// day-aggregator buckets per-call usage by the RAW model/provider string taken
// verbatim from parsed transcripts (untrusted). If those buckets were plain
// `{}` objects, a model named "__proto__" (or "constructor") would resolve the
// `map[key] ?? {…}` lookup to Object.prototype and the subsequent `+=` writes
// would poison the global prototype for the whole process. The maps are now
// null-prototype (Object.create(null)); these tests lock that in so a future
// regression to `{}` fails CI. See also tests/security/prototype-pollution.test.ts
// which covers the parseAllSessions path.

const DANGEROUS = ['__proto__', 'constructor', 'prototype']

function call(model: string, provider = 'claude'): ParsedApiCall {
  return {
    provider,
    model,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 1,
    tools: ['Edit'],
    mcpTools: [],
    skills: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-05-05T00:00:00Z',
    bashCommands: [],
    deduplicationKey: `${provider}-${model}`,
  }
}

function turn(calls: ParsedApiCall[]): ClassifiedTurn {
  return {
    userMessage: '',
    assistantCalls: calls,
    timestamp: '2026-05-05T00:00:00Z',
    sessionId: 's1',
    category: 'coding',
    retries: 0,
    hasEdits: true,
  }
}

function project(turns: ClassifiedTurn[]): ProjectSummary {
  const session: SessionSummary = {
    sessionId: 's1',
    project: 'app',
    firstTimestamp: '2026-05-05T00:00:00Z',
    lastTimestamp: '2026-05-05T00:00:00Z',
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: turns.reduce((s, t) => s + t.assistantCalls.length, 0),
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
  return { project: 'app', projectPath: '/app', sessions: [session], totalCostUSD: 0, totalApiCalls: session.apiCalls }
}

// If a regression ever does poison the prototype, scrub it so the rest of the
// suite isn't corrupted by leakage from this file.
afterEach(() => {
  for (const key of ['calls', 'cost', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'turns', 'editTurns', 'oneShotTurns']) {
    delete (Object.prototype as Record<string, unknown>)[key]
  }
})

describe('prototype pollution — day-aggregator', () => {
  it('does not poison Object.prototype when a transcript carries a __proto__/constructor model name', () => {
    const proj = project(DANGEROUS.map(name => turn([call(name, name)])))

    const days = aggregateProjectsIntoDays([proj])
    buildPeriodDataFromDays(days, 'Today')

    // A fresh, empty object must not have inherited any numeric accumulator keys.
    const probe = {} as Record<string, unknown>
    expect(probe.calls).toBeUndefined()
    expect(probe.cost).toBeUndefined()
    expect(probe.inputTokens).toBeUndefined()
    expect(probe.turns).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'calls')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'cost')).toBe(false)
  })

  it('still aggregates the dangerous-named models as ordinary own-property buckets', () => {
    const proj = project([turn([call('__proto__', 'claude'), call('claude-sonnet', 'claude')])])

    const days = aggregateProjectsIntoDays([proj])
    expect(days).toHaveLength(1)

    const period = buildPeriodDataFromDays(days, 'Today')
    // The "__proto__"-named model is preserved as data, not silently dropped or
    // collapsed onto the prototype — and totals stay finite (no NaN leakage).
    const names = period.models.map(m => m.name)
    expect(names).toContain('__proto__')
    expect(period.calls).toBe(2)
    expect(Number.isFinite(period.cost)).toBe(true)
  })
})
