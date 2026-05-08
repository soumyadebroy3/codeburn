import { describe, it, expect } from 'vitest'

import { formatTokens, renderStatusBar } from '../src/format.js'
import type { ProjectSummary } from '../src/types.js'

function makeProject(turnCost: number, ts: string): ProjectSummary {
  return {
    project: 'test',
    projectPath: '/test',
    totalCostUSD: turnCost,
    totalApiCalls: 1,
    sessions: [
      {
        sessionId: 'sess-1',
        firstTimestamp: ts,
        apiCalls: 1,
        totalCostUSD: turnCost,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        modelBreakdown: {},
        toolBreakdown: {},
        mcpBreakdown: {},
        bashBreakdown: {},
        categoryBreakdown: {},
        turns: [
          {
            userMessage: '',
            timestamp: ts,
            assistantCalls: [
              {
                provider: 'claude',
                model: 'sonnet',
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                webSearchRequests: 0,
                costUSD: turnCost,
                tools: [],
                bashCommands: [],
                timestamp: ts,
                speed: 'standard',
                deduplicationKey: 'k1',
                userMessage: '',
                sessionId: 'sess-1',
              },
            ],
            category: 'coding',
            retries: 0,
            hasEdits: false,
          },
        ],
      },
    ],
  }
}

describe('formatTokens', () => {
  it('returns ? for non-finite', () => {
    expect(formatTokens(NaN)).toBe('?')
    expect(formatTokens(Infinity)).toBe('?')
  })
  it('clamps negatives to 0', () => {
    expect(formatTokens(-5)).toBe('0')
  })
  it('uses M suffix at 1M+', () => {
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })
  it('uses K suffix at 1K+', () => {
    expect(formatTokens(2_500)).toBe('2.5K')
  })
  it('rounds small numbers', () => {
    expect(formatTokens(42)).toBe('42')
  })
})

describe('renderStatusBar', () => {
  it('renders without plan (bare today/month labels)', () => {
    const today = new Date().toISOString()
    const out = renderStatusBar([makeProject(1.23, today)])
    expect(out).toContain('Today')
    expect(out).toContain('Month')
    expect(out).not.toContain('leverage')
  })

  it('shows leverage line when plan is set and leverage >= 1', () => {
    const today = new Date().toISOString()
    const out = renderStatusBar([makeProject(500, today)], { displayName: 'Pro', monthlyUsd: 200 })
    expect(out).toContain('leverage')
    expect(out).toContain('Pro')
    expect(out).toContain('Today value')
    expect(out).toContain('Month value')
  })

  it('shows underutilizing line when leverage < 1', () => {
    const today = new Date().toISOString()
    const out = renderStatusBar([makeProject(10, today)], { displayName: 'Max', monthlyUsd: 200 })
    expect(out).toContain('underutilizing')
    expect(out).toContain('Max')
  })

  it('skips turns with no assistant calls and no timestamp', () => {
    const out = renderStatusBar([])
    expect(out).toContain('Today')
  })
})
