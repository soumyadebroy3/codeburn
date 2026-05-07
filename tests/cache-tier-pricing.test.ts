import { describe, it, expect } from 'vitest'
import { calculateCost, getModelCosts } from '../src/models.js'

/**
 * Pins codeburn's cost computation to Anthropic's published pricing model:
 *   - 5-minute cache write: 1.25× input rate
 *   - 1-hour cache write:    2.0×  input rate
 *   - cache read:            0.1×  input rate
 *
 * The bug we found in real usage: codeburn previously applied the 5-minute
 * rate (1.25×) to ALL cache writes, undercharging by ~8.5% for users on
 * Claude Code defaults (which write to 1-hour cache). These tests fail loudly
 * if anyone re-introduces the merge.
 */
describe('cache-tier pricing — Anthropic-correct math', () => {
  const M = 1_000_000

  it('5m and 1h cache writes use different rates', () => {
    const costs = getModelCosts('claude-opus-4-7')!
    expect(costs).not.toBeNull()
    expect(costs.cacheWrite1hCostPerToken).toBeCloseTo(costs.inputCostPerToken * 2, 12)
    // 5m rate is 1.25× input, give or take what LiteLLM ships explicitly.
    expect(costs.cacheWriteCostPerToken / costs.inputCostPerToken).toBeCloseTo(1.25, 2)
  })

  it('analytical cost for Opus 4.7 with mixed cache tiers', () => {
    // 1M tokens of each — easy mental math: input=$5, output=$25, 5m=$6.25,
    // 1h=$10, cache_read=$0.50.
    const cost = calculateCost(
      'claude-opus-4-7',
      1 * M,    // input
      1 * M,    // output
      1 * M,    // 5m cache writes
      1 * M,    // cache reads
      0,        // web search
      'standard',
      1 * M,    // 1h cache writes
    )
    // 5 + 25 + 6.25 + 0.5 + 10 = 46.75
    expect(cost).toBeCloseTo(46.75, 2)
  })

  it('legacy callers (no 1h param) still get correct 5m-only billing', () => {
    // Simulates a third-party caller that never passes the 8th arg.
    const cost = calculateCost('claude-opus-4-7', 1 * M, 1 * M, 1 * M, 1 * M, 0)
    // 5 + 25 + 6.25 + 0.5 = 36.75 (no 1h component)
    expect(cost).toBeCloseTo(36.75, 2)
  })

  it('Claude Code 1h-default workload prices the 60% gap correctly', () => {
    // Real session breakdown sampled from /Users/soumya's terraform-aws repo:
    //   2.5M cache_creation, 100% in 1h tier, 71M cache_read, 286k output, 1k input.
    const inp = 1_000
    const out = 286_000
    const cache_1h = 2_500_000
    const cache_5m = 0
    const cache_read = 71_000_000

    // Legacy (pre-fix): treats the 2.5M as 5m, undercharges.
    const legacyCost = calculateCost('claude-opus-4-7', inp, out, cache_1h + cache_5m, cache_read, 0)
    // Fixed: split correctly into 1h + 5m.
    const fixedCost = calculateCost('claude-opus-4-7', inp, out, cache_5m, cache_read, 0, 'standard', cache_1h)

    expect(fixedCost).toBeGreaterThan(legacyCost)
    // The gap is exactly 0.75 × inputRate × cache_1h_tokens (the 2× minus 1.25× delta).
    const expectedGap = 0.75 * 5e-6 * cache_1h
    expect(fixedCost - legacyCost).toBeCloseTo(expectedGap, 4)
  })

  it('Sonnet 4.6 1h-cache rate is $6/Mtok (2× $3 input)', () => {
    const costs = getModelCosts('claude-sonnet-4-6')!
    expect(costs.cacheWrite1hCostPerToken * M).toBeCloseTo(6.00, 2)
  })

  it('Haiku 4.5 1h-cache rate is $2/Mtok (2× $1 input)', () => {
    const costs = getModelCosts('claude-haiku-4-5')!
    expect(costs.cacheWrite1hCostPerToken * M).toBeCloseTo(2.00, 2)
  })

  it('zero tokens never produce NaN — defends against the loadCachedPricing migration bug', () => {
    // Regression test: a stale ~/.cache/codeburn/litellm-pricing.json from
    // before the 1h-rate field existed previously caused 0 × undefined = NaN.
    const cost = calculateCost('claude-opus-4-7', 0, 0, 0, 0, 0)
    expect(Number.isFinite(cost)).toBe(true)
    expect(cost).toBe(0)
  })
})
